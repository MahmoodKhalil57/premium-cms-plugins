/**
 * Orders: storage helpers, the reservation lifecycle and finalisation from a
 * verified Checkout Session. Everything here is idempotent — webhook
 * deliveries and the success-page confirm can both race to finalise.
 * Every state change is announced to sibling plugins as an order event.
 */

import { ulid } from "ulidx";

import { commitStock, releaseStock, restock } from "./catalog.js";
import { formatMoney } from "./money.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import type { StripeAddress, StripeSession } from "./stripe.js";
import { lineSummary } from "./pricing.js";
import type { StripePaymentIntent } from "./stripe.js";
import { recordCouponUse } from "./discounts.js";
import { recordTransaction } from "./transactions.js";
import type { Address, Order, OrderEvent, OrderEventName, OrderEventPayload, StoreSettings } from "./types.js";

export const PENDING_TTL_MS = 45 * 60 * 1000;

export function providerLabel(method: string): string {
	return method === "stripe" ? "Stripe" : method === "polar" ? "Polar" : "Pay later";
}

export function orders(ctx: PluginContext): StorageCollection<Order> {
	return ctx.storage.orders as StorageCollection<Order>;
}

export function newOrderId(): string {
	return ulid();
}

export function randomToken(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Human-friendly sequential order number, kept in KV. */
export async function nextOrderNumber(ctx: PluginContext): Promise<number> {
	const current = (await ctx.kv.get<number>("state:orderSeq")) ?? 1000;
	const next = current + 1;
	await ctx.kv.set("state:orderSeq", next);
	return next;
}

export function event(type: string, note?: string): OrderEvent {
	return { at: new Date().toISOString(), type, ...(note ? { note } : {}) };
}

export async function saveOrder(ctx: PluginContext, id: string, order: Order): Promise<void> {
	order.updatedAt = new Date().toISOString();
	await orders(ctx).put(id, order);
}

/** Lines that draw on inventory (provider lines are priced elsewhere and carry no stock). */
export const stockLines = (order: Pick<Order, "items">) => order.items.filter((it) => !it.provider && !it.productId.startsWith("balance:"));

/** Tell sibling plugins (bookings, restaurant …) what happened. Best effort; never blocks the order. */
export async function emitOrderEvent(ctx: PluginContext, name: OrderEventName, id: string, order: Order): Promise<void> {
	if (!ctx.plugins) return;
	const payload: OrderEventPayload = { id, order };
	try {
		await ctx.plugins.emit(name, payload);
	} catch (err) {
		console.error(`[commerce] ${name} event failed:`, err);
	}
}

export async function findBySession(ctx: PluginContext, sessionId: string): Promise<{ id: string; order: Order } | null> {
	const res = await orders(ctx).query({ where: { sessionId }, limit: 1 });
	const hit = res.items[0];
	return hit ? { id: hit.id, order: hit.data } : null;
}

function address(a: StripeAddress | null | undefined, name?: string | null): Address | undefined {
	if (!a) return undefined;
	return {
		name: name ?? undefined,
		line1: a.line1 ?? undefined,
		line2: a.line2 ?? undefined,
		city: a.city ?? undefined,
		state: a.state ?? undefined,
		postalCode: a.postal_code ?? undefined,
		country: a.country ?? undefined,
	};
}

/**
 * Mark an order paid from a Checkout Session the plugin fetched itself from
 * the provider (never from the webhook payload). Returns the order either way.
 */
export async function finalizeFromSession(ctx: PluginContext, settings: StoreSettings, id: string, order: Order, session: StripeSession): Promise<Order> {
	if (order.status === "paid" || order.status === "fulfilled" || order.status === "refunded") return order;
	if (session.client_reference_id && session.client_reference_id !== id) throw new Error("session does not belong to this order");
	if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return order;
	if (session.currency && session.currency.toLowerCase() !== order.currency) throw new Error("currency mismatch");

	const subtotal = session.amount_subtotal ?? order.subtotal;
	order.shipping = session.total_details?.amount_shipping ?? 0;
	order.tax = session.total_details?.amount_tax ?? 0;
	order.discount = session.total_details?.amount_discount ?? 0;
	order.subtotal = subtotal;
	order.total = session.amount_total ?? order.total;
	order.email = session.customer_details?.email ?? session.customer_email ?? order.email;
	order.customerName = session.customer_details?.name ?? order.customerName;
	order.phone = session.customer_details?.phone ?? order.phone;
	const ship = session.shipping_details ?? session.collected_information?.shipping_details;
	order.shippingAddress = address(ship?.address, ship?.name) ?? address(session.customer_details?.address, session.customer_details?.name);
	const ref = typeof session.payment_intent === "string" ? session.payment_intent : ((session.payment_intent as { id?: string } | null)?.id ?? null);
	order.paymentRef = ref ?? order.paymentRef;
	order.status = "paid";
	order.paidAt = new Date().toISOString();
	order.expiresAt = undefined;
	order.events.push(event("paid", `${providerLabel(order.paymentMethod)} ${ref ?? session.id}`));
	await saveOrder(ctx, id, order);
	await commitStock(ctx, stockLines(order));
	await recordTransaction(ctx, id, order, { provider: order.paymentMethod, kind: "payment", amount: order.total, status: "succeeded", providerRef: ref ?? session.id }).catch((err) => console.error("[commerce] transaction not recorded:", err));
	if (order.coupon) await recordCouponUse(ctx, order.coupon.id, order.userId ?? order.email.toLowerCase() ?? null).catch(() => undefined);
	await settleBalance(ctx, order).catch(() => undefined);
	await emitOrderEvent(ctx, "order.paid", id, order);
	await sendOrderEmails(ctx, settings, id, order).catch((err) => console.error("[commerce] order emails failed:", err));
	return order;
}

/** A paid balance order marks the deposit order's plan as settled. */
async function settleBalance(ctx: PluginContext, balanceOrder: Order): Promise<void> {
	const ref = balanceOrder.items.find((it) => it.productId.startsWith("balance:"))?.productId.slice(8);
	if (!ref) return;
	const parent = await orders(ctx).get(ref);
	if (!parent?.paymentPlan) return;
	parent.paymentPlan.balanceStatus = "paid";
	parent.paymentPlan.balanceRef = balanceOrder.paymentRef ?? balanceOrder.sessionId ?? null;
	parent.events.push(event("balance_paid", `order #${balanceOrder.number}`));
	await saveOrder(ctx, ref, parent);
}

/** Mark an order paid from an off-session PaymentIntent the plugin created itself (saved card). */
export async function finalizeFromPaymentIntent(ctx: PluginContext, settings: StoreSettings, id: string, order: Order, pi: StripePaymentIntent): Promise<Order> {
	if (order.status === "paid" || order.status === "fulfilled" || order.status === "refunded") return order;
	if (pi.status !== "succeeded") return order;
	if (pi.currency.toLowerCase() !== order.currency || pi.amount !== order.total) throw new Error("payment does not match the order");
	order.paymentRef = pi.id;
	order.status = "paid";
	order.paidAt = new Date().toISOString();
	order.expiresAt = undefined;
	order.events.push(event("paid", `Stripe ${pi.id} (saved card)`));
	await saveOrder(ctx, id, order);
	await commitStock(ctx, stockLines(order));
	await recordTransaction(ctx, id, order, { provider: "stripe", kind: "payment", amount: order.total, status: "succeeded", providerRef: pi.id }).catch((err) => console.error("[commerce] transaction not recorded:", err));
	if (order.coupon) await recordCouponUse(ctx, order.coupon.id, order.userId ?? order.email.toLowerCase() ?? null).catch(() => undefined);
	await emitOrderEvent(ctx, "order.paid", id, order);
	await sendOrderEmails(ctx, settings, id, order).catch((err) => console.error("[commerce] order emails failed:", err));
	return order;
}

export async function cancelOrder(ctx: PluginContext, id: string, order: Order, note: string): Promise<Order> {
	if (order.status === "cancelled") return order;
	const wasCommitted = order.status === "paid" || order.status === "fulfilled";
	if (wasCommitted) await restock(ctx, stockLines(order));
	else if (order.status === "pending" || order.status === "awaiting_payment") await releaseStock(ctx, stockLines(order));
	order.status = "cancelled";
	order.expiresAt = undefined;
	order.events.push(event("cancelled", note));
	await saveOrder(ctx, id, order);
	await emitOrderEvent(ctx, "order.cancelled", id, order);
	return order;
}

export function orderText(order: Order, settings: StoreSettings, siteUrl: string): string {
	const lines = order.items.map((it) => `  ${it.quantity} × ${it.title}${lineSummary(it)}${it.sku ? ` [${it.sku}]` : ""} — ${formatMoney(it.unitAmount * it.quantity, order.currency)}${it.customization?.previewUrl ? `\n      design preview: ${it.customization.previewUrl}` : ""}`);
	const parts = [
		`Order #${order.number}`,
		"",
		...lines,
		"",
		`Subtotal: ${formatMoney(order.subtotal, order.currency)}`,
		order.shipping ? `Shipping: ${formatMoney(order.shipping, order.currency)}` : null,
		...(order.adjustments ?? []).filter((a) => a.amount).map((a) => `${a.label}: ${formatMoney(a.amount, order.currency)}`),
		order.tax ? `Tax: ${formatMoney(order.tax, order.currency)}` : null,
		order.discount ? `Discount${order.coupon ? ` (${order.coupon.code})` : ""}: -${formatMoney(order.discount, order.currency)}` : null,
		`Total: ${formatMoney(order.total, order.currency)}`,
		order.paymentPlan && order.paymentPlan.balanceDue > 0 ? `This is a deposit. Balance of ${formatMoney(order.paymentPlan.balanceDue, order.currency)} ${order.paymentPlan.balanceStatus === "paid" ? "has been paid" : "is due on the day or via the payment link we will send"}.` : null,
		"",
		order.shippingAddress
			? `Ship to: ${[order.shippingAddress.name, order.shippingAddress.line1, order.shippingAddress.line2, order.shippingAddress.city, order.shippingAddress.state, order.shippingAddress.postalCode, order.shippingAddress.country].filter(Boolean).join(", ")}`
			: null,
		order.offline ? `Payment: ${order.offline.method}` : order.paymentMethod === "manual" ? "Payment: to be arranged (the store will contact you with payment details)." : `Payment: online (${providerLabel(order.paymentMethod)})`,
		siteUrl ? `Track this order: ${siteUrl}${settings.successPath}?order=${encodeURIComponent(order.number)}&token=${order.accessToken}` : null,
	];
	return parts.filter((p): p is string => p !== null).join("\n");
}

export async function sendOrderEmails(ctx: PluginContext, settings: StoreSettings, _id: string, order: Order): Promise<void> {
	if (!ctx.email) return;
	const siteUrl = ctx.site?.url ?? "";
	const store = settings.storeName || "our store";
	const body = orderText(order, settings, siteUrl);
	const jobs: Promise<unknown>[] = [];
	if (order.email) {
		jobs.push(
			ctx.email.send({
				to: order.email,
				subject: order.status === "awaiting_payment" ? `Order #${order.number} received — ${store}` : `Order #${order.number} confirmed — ${store}`,
				text: `${order.status === "awaiting_payment" ? "Thanks — we have your order." : "Thanks for your purchase!"}\n\n${body}`,
			}),
		);
	}
	if (settings.notifyEmail) {
		jobs.push(
			ctx.email.send({
				to: settings.notifyEmail,
				subject: `New order #${order.number} (${formatMoney(order.total, order.currency)})`,
				text: `${order.customerName ?? ""} <${order.email}>\n\n${body}`,
			}),
		);
	}
	await Promise.all(jobs);
}

/** Public-safe projection for the success page / order lookup. */
export function publicOrder(id: string, order: Order) {
	return {
		id,
		number: order.number,
		status: order.status,
		paymentMethod: order.paymentMethod,
		currency: order.currency,
		items: order.items.map((it) => ({ title: it.title, slug: it.slug, quantity: it.quantity, unitAmount: it.unitAmount, options: it.options, optionsDisplay: it.optionsDisplay, previewUrl: it.customization?.previewUrl, provider: it.provider ?? null })),
		subtotal: order.subtotal,
		shipping: order.shipping,
		tax: order.tax,
		discount: order.discount,
		adjustments: order.adjustments ?? [],
		coupon: order.coupon ?? null,
		paymentPlan: order.paymentPlan ?? null,
		total: order.total,
		email: order.email,
		customerName: order.customerName,
		shippingAddress: order.shippingAddress,
		billingAddress: order.billingAddress,
		tracking: order.tracking,
		channel: order.channel ?? "web",
		extensions: order.extensions ?? {},
		createdAt: order.createdAt,
		paidAt: order.paidAt,
	};
}
