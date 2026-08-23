/**
 * Admin-only routes (plugins:manage): orders, refunds, export, inventory, stats.
 * Also used by the PremiumCMS admin's first-party React order screens.
 */

import { available, inventory, inventoryFor, listProducts } from "../catalog.js";
import { formatMoney } from "../money.js";
import { cancelOrder, emitOrderEvent, event, orders, saveOrder, stockLines } from "../orders.js";
import { loadSettings } from "../settings.js";
import type { RouteContext } from "../shim.js";
import { PluginRouteError } from "../shim.js";
import { carts } from "../carts.js";
import { customers, publicCustomer } from "../customers.js";
import { Polar } from "../polar.js";
import { discounts, invalidateDiscounts, newDiscountId, normalizeDiscount } from "../discounts.js";
import { newOrderId, nextOrderNumber, randomToken } from "../orders.js";
import { loadSettings as loadStoreSettings } from "../settings.js";
import { recordTransaction, transactions } from "../transactions.js";
import { Stripe } from "../stripe.js";
import type { Order, OrderStatus } from "../types.js";

export async function ordersListHandler(ctx: RouteContext<{ status?: string; limit: number; cursor?: string }>) {
	const res = await orders(ctx).query({
		where: ctx.input.status ? { status: ctx.input.status } : undefined,
		orderBy: { createdAt: "desc" },
		limit: ctx.input.limit,
		cursor: ctx.input.cursor,
	});
	return { items: res.items.map((i) => ({ id: i.id, ...i.data })), cursor: res.cursor, hasMore: res.hasMore };
}

export async function orderGetHandler(ctx: RouteContext<{ id: string }>) {
	const order = await orders(ctx).get(ctx.input.id);
	if (!order) throw PluginRouteError.notFound("Order not found");
	return { id: ctx.input.id, ...order };
}

const TRANSITIONS: Record<string, OrderStatus[]> = {
	awaiting_payment: ["paid", "cancelled"],
	pending: ["cancelled", "paid"],
	paid: ["fulfilled", "cancelled"],
	fulfilled: ["paid"],
	failed: ["cancelled"],
	cancelled: [],
	refunded: [],
};

export async function orderUpdateHandler(ctx: RouteContext<{ id: string; status?: OrderStatus; tracking?: string; note?: string }>) {
	const order = await orders(ctx).get(ctx.input.id);
	if (!order) throw PluginRouteError.notFound("Order not found");
	const settings = await loadSettings(ctx);
	if (ctx.input.status && ctx.input.status !== order.status) {
		const allowed = TRANSITIONS[order.status] ?? [];
		if (!allowed.includes(ctx.input.status)) throw PluginRouteError.conflict(`Cannot move an order from ${order.status} to ${ctx.input.status}`);
		if (ctx.input.status === "cancelled") {
			await cancelOrder(ctx, ctx.input.id, order, ctx.input.note ?? "cancelled by admin");
		} else if (ctx.input.status === "paid" && (order.status === "awaiting_payment" || order.status === "pending")) {
			const { commitStock } = await import("../catalog.js");
			await commitStock(ctx, stockLines(order));
			order.status = "paid";
			order.paidAt = new Date().toISOString();
			order.expiresAt = undefined;
			order.events.push(event("paid", ctx.input.note ?? "marked paid by admin"));
			await saveOrder(ctx, ctx.input.id, order);
			await emitOrderEvent(ctx, "order.paid", ctx.input.id, order);
		} else if (ctx.input.status === "fulfilled") {
			order.status = "fulfilled";
			order.events.push(event("fulfilled", ctx.input.note));
			await saveOrder(ctx, ctx.input.id, order);
			await emitOrderEvent(ctx, "order.fulfilled", ctx.input.id, order);
		} else {
			order.status = ctx.input.status;
			order.events.push(event(ctx.input.status, ctx.input.note));
		}
	}
	if (ctx.input.tracking !== undefined) {
		order.tracking = ctx.input.tracking || undefined;
		if (ctx.input.tracking) order.events.push(event("tracking", ctx.input.tracking));
	}
	if (ctx.input.note && !ctx.input.status) order.events.push(event("note", ctx.input.note));
	if (order.status !== "cancelled") await saveOrder(ctx, ctx.input.id, order);
	if (ctx.input.status === "fulfilled" && order.email && ctx.email) {
		await ctx.email
			.send({
				to: order.email,
				subject: `Order #${order.number} is on its way${settings.storeName ? ` — ${settings.storeName}` : ""}`,
				text: `Good news — your order #${order.number} has been fulfilled.${order.tracking ? `\n\nTracking: ${order.tracking}` : ""}`,
			})
			.catch(() => {});
	}
	return { id: ctx.input.id, ...order };
}

export async function orderRefundHandler(ctx: RouteContext<{ id: string; amount?: number }>) {
	const order = await orders(ctx).get(ctx.input.id);
	if (!order) throw PluginRouteError.notFound("Order not found");
	if (order.paymentMethod === "manual") throw PluginRouteError.badRequest("Pay-later orders have no online payment to refund");
	if (order.status !== "paid" && order.status !== "fulfilled") throw PluginRouteError.conflict(`Order is ${order.status}`);
	const settings = await loadSettings(ctx);
	let refund: { id: string; status: string; amount: number };
	if (order.paymentMethod === "stripe") {
		if (!order.paymentRef) throw PluginRouteError.badRequest("No Stripe payment reference on this order");
		refund = await Stripe.from(ctx, settings.stripeSecretKey).createRefund(order.paymentRef, ctx.input.amount);
	} else {
		const polar = Polar.from(ctx, settings.polarAccessToken);
		const polarOrder = order.paymentRef ?? (order.sessionId ? await polar.findOrderByCheckout(order.sessionId) : null);
		if (!polarOrder) throw PluginRouteError.badRequest("Polar order not found for this checkout");
		refund = await polar.createRefund(polarOrder, ctx.input.amount ?? order.total);
	}
	const full = !ctx.input.amount || ctx.input.amount >= order.total;
	if (full) {
		const { restock } = await import("../catalog.js");
		await restock(ctx, stockLines(order));
		order.status = "refunded";
	}
	order.events.push(event("refund", `${refund.id} ${formatMoney(refund.amount, order.currency)}`));
	await saveOrder(ctx, ctx.input.id, order);
	if (full) await emitOrderEvent(ctx, "order.refunded", ctx.input.id, order);
	await recordTransaction(ctx, ctx.input.id, order, { provider: order.paymentMethod, kind: "refund", amount: refund.amount, status: refund.status, providerRef: refund.id }).catch(() => undefined);
	return { id: ctx.input.id, refund, order };
}

export async function ordersExportHandler(ctx: RouteContext<{ status?: string; format: "csv" | "json" }>) {
	const all: Array<{ id: string; data: Order }> = [];
	let cursor: string | undefined;
	do {
		const batch = await orders(ctx).query({ where: ctx.input.status ? { status: ctx.input.status } : undefined, orderBy: { createdAt: "desc" }, limit: 100, cursor });
		all.push(...batch.items);
		cursor = batch.cursor;
	} while (cursor && all.length < 5000);
	if (ctx.input.format === "json") return { count: all.length, contentType: "application/json", data: all.map((i) => ({ id: i.id, ...i.data })) };
	const esc = (v: unknown) => {
		const s = v === undefined || v === null ? "" : String(v);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const header = ["Number", "Created", "Status", "Payment", "Email", "Name", "Currency", "Subtotal", "Shipping", "Tax", "Discount", "Total", "Items", "Tracking", "Payment ref"];
	const lines = [header.join(",")];
	for (const { data: o } of all) {
		lines.push(
			[
				o.number,
				o.createdAt,
				o.status,
				o.paymentMethod,
				o.email,
				o.customerName,
				o.currency,
				o.subtotal,
				o.shipping,
				o.tax,
				o.discount,
				o.total,
				o.items.map((i) => `${i.quantity}x ${i.sku ?? i.slug}`).join("; "),
				o.tracking,
				o.paymentRef,
			]
				.map(esc)
				.join(","),
		);
	}
	return { count: all.length, contentType: "text/csv", filename: `orders-${new Date().toISOString().slice(0, 10)}.csv`, data: lines.join("\n") };
}

export async function inventoryListHandler(ctx: RouteContext) {
	const settings = await loadSettings(ctx);
	const products = await listProducts(ctx, settings.currency);
	const inv = await inventoryFor(ctx, products.map((p) => p.id));
	return {
		currency: settings.currency,
		items: products.map((p) => {
			const row = inv.get(p.id);
			return { productId: p.id, slug: p.slug, title: p.title, sku: p.sku, unitAmount: p.unitAmount, stock: p.stock, sold: row?.sold ?? 0, reserved: row?.reserved ?? 0, available: available(p, row) };
		}),
	};
}

export async function inventoryAdjustHandler(ctx: RouteContext<{ productId: string; sold?: number; reserved?: number }>) {
	const row = (await inventory(ctx).get(ctx.input.productId)) ?? { productId: ctx.input.productId, sold: 0, reserved: 0, updatedAt: "" };
	if (ctx.input.sold !== undefined) row.sold = Math.max(0, ctx.input.sold);
	if (ctx.input.reserved !== undefined) row.reserved = Math.max(0, ctx.input.reserved);
	row.updatedAt = new Date().toISOString();
	await inventory(ctx).put(ctx.input.productId, row);
	return row;
}

export async function statsHandler(ctx: RouteContext) {
	const settings = await loadSettings(ctx);
	const since = new Date(Date.now() - 30 * 86400000).toISOString();
	const recent = await orders(ctx).query({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, limit: 100 });
	const paid = recent.items.filter((i) => i.data.status === "paid" || i.data.status === "fulfilled");
	const revenue = paid.reduce((n, i) => n + i.data.total, 0);
	const [open, awaiting] = await Promise.all([orders(ctx).count({ status: "paid" }), orders(ctx).count({ status: "awaiting_payment" })]);
	return { currency: settings.currency, orders30d: recent.items.length, paid30d: paid.length, revenue30d: revenue, revenue30dFormatted: formatMoney(revenue, settings.currency), toFulfil: open, awaitingPayment: awaiting, recent: recent.items.slice(0, 8).map((i) => ({ id: i.id, ...i.data })) };
}

/* ---- customers / carts / transactions (admin) ---------------------------- */

export async function customersListHandler(ctx: RouteContext<{ limit: number; cursor?: string }>) {
	const res = await customers(ctx).query({ orderBy: { updatedAt: "desc" }, limit: ctx.input.limit, cursor: ctx.input.cursor });
	return { items: res.items.map((c) => ({ id: c.id, ...publicCustomer(c.data), stripeCustomerId: c.data.stripeCustomerId, polarCustomerId: c.data.polarCustomerId, updatedAt: c.data.updatedAt })), cursor: res.cursor, hasMore: res.hasMore };
}

export async function cartsListHandler(ctx: RouteContext<{ limit: number; cursor?: string; status?: string }>) {
	const res = await carts(ctx).query({ where: { status: ctx.input.status ?? "active" }, orderBy: { updatedAt: "desc" }, limit: ctx.input.limit, cursor: ctx.input.cursor });
	return { items: res.items.map((c) => ({ id: c.id, userId: c.data.userId, email: c.data.email ?? null, lines: c.data.lines.length, units: c.data.lines.reduce((n, l) => n + l.quantity, 0), status: c.data.status, updatedAt: c.data.updatedAt, convertedOrderId: c.data.convertedOrderId ?? null })), cursor: res.cursor, hasMore: res.hasMore };
}

export async function transactionsListHandler(ctx: RouteContext<{ limit: number; cursor?: string }>) {
	const res = await transactions(ctx).query({ orderBy: { createdAt: "desc" }, limit: ctx.input.limit, cursor: ctx.input.cursor });
	return { items: res.items.map((t) => ({ id: t.id, ...t.data })), cursor: res.cursor, hasMore: res.hasMore };
}

/* ---- discounts (admin) ---------------------------------------------------- */

export async function discountsListHandler(ctx: RouteContext<{ limit: number; cursor?: string }>) {
	const res = await discounts(ctx).query({ orderBy: { updatedAt: "desc" }, limit: ctx.input.limit, cursor: ctx.input.cursor });
	return { items: res.items.map((d) => ({ id: d.id, ...d.data })), cursor: res.cursor, hasMore: res.hasMore };
}

export async function discountSaveHandler(ctx: RouteContext<{ id?: string; discount: Record<string, unknown> }>) {
	const existing = ctx.input.id ? await discounts(ctx).get(ctx.input.id) : null;
	const record = normalizeDiscount(ctx.input.discount, existing ?? undefined);
	if (record.code) {
		const dup = await discounts(ctx).query({ where: { code: record.code }, limit: 1 });
		if (dup.items[0] && dup.items[0].id !== ctx.input.id) throw PluginRouteError.conflict(`Code ${record.code} is already used by "${dup.items[0].data.title}"`);
	}
	const id = existing && ctx.input.id ? ctx.input.id : newDiscountId();
	await discounts(ctx).put(id, record);
	invalidateDiscounts();
	return { id, ...record };
}

export async function discountDeleteHandler(ctx: RouteContext<{ id: string }>) {
	const ok = await discounts(ctx).delete(ctx.input.id);
	invalidateDiscounts();
	return { deleted: ok };
}

/* ---- deposits: collect the balance ---------------------------------------- */

/**
 * Collect what is still owed on a deposit order: charge the shopper's saved
 * card off-session, email a Stripe pay link (a balance order), or waive it.
 */
export async function collectBalanceHandler(ctx: RouteContext<{ id: string; mode: "saved_card" | "pay_link" | "waive" }>) {
	const order = await orders(ctx).get(ctx.input.id);
	if (!order) throw PluginRouteError.notFound("Order not found");
	const plan = order.paymentPlan;
	if (!plan || plan.balanceDue <= 0 || plan.balanceStatus !== "due") throw PluginRouteError.badRequest("Nothing is due on this order");
	const settings = await loadStoreSettings(ctx);
	if (ctx.input.mode === "waive") {
		plan.balanceStatus = "waived";
		order.events.push(event("balance_waived"));
		await saveOrder(ctx, ctx.input.id, order);
		return { order, status: "waived" };
	}
	if (settings.paymentProvider !== "stripe") throw PluginRouteError.badRequest("Balance collection needs Stripe as the payment provider");
	const stripe = Stripe.from(ctx, settings.stripeSecretKey);
	if (ctx.input.mode === "saved_card") {
		const c = order.userId ? await customers(ctx).get(order.userId) : null;
		const pm = c?.paymentMethods.find((m) => m.provider === "stripe");
		if (!c?.stripeCustomerId || !pm) throw PluginRouteError.badRequest("The customer has no saved card — send a pay link instead");
		const pi = await stripe.createPaymentIntent({ amount: plan.balanceDue, currency: order.currency, customer: c.stripeCustomerId, payment_method: pm.token, off_session: "true", confirm: "true", description: `Balance for order #${order.number}`, metadata: { orderId: ctx.input.id, balanceFor: String(order.number) } });
		if (pi.status !== "succeeded") throw PluginRouteError.badRequest(`The card could not be charged (${pi.status}) — send a pay link instead`);
		plan.balanceStatus = "paid";
		plan.balanceRef = pi.id;
		order.events.push(event("balance_paid", `saved card ${pi.id}`));
		await saveOrder(ctx, ctx.input.id, order);
		await recordTransaction(ctx, ctx.input.id, order, { provider: "stripe", kind: "payment", amount: plan.balanceDue, status: "succeeded", providerRef: pi.id, note: "balance" }).catch(() => undefined);
		return { order, status: "paid" };
	}
	// Pay link: a second order for the balance, paid through Checkout; the webhook/confirm marks the original plan paid.
	const id = newOrderId();
	const now = new Date().toISOString();
	const balance: Order = {
		number: await nextOrderNumber(ctx),
		status: "pending",
		paymentMethod: "stripe",
		currency: order.currency,
		items: [{ productId: `balance:${ctx.input.id}`, slug: `balance-${order.number}`, title: `Balance for order #${order.number}`, unitAmount: plan.balanceDue, quantity: 1, requiresShipping: false }],
		subtotal: plan.balanceDue,
		shipping: 0,
		tax: 0,
		discount: 0,
		total: plan.balanceDue,
		email: order.email,
		customerName: order.customerName,
		userId: order.userId ?? null,
		accessToken: randomToken(),
		createdAt: now,
		updatedAt: now,
		expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		events: [event("created", `balance for #${order.number}`)],
		meta: { ip: null, country: null, userAgent: null },
	};
	const origin = ctx.site?.url?.replace(/\/$/, "") ?? "";
	const session = await stripe.createCheckoutSession({
		mode: "payment",
		client_reference_id: id,
		customer_email: order.email || undefined,
		success_url: `${origin}${settings.successPath}?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${origin}${settings.cancelPath}`,
		expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
		metadata: { orderId: id, balanceFor: ctx.input.id },
		line_items: [{ quantity: 1, price_data: { currency: order.currency, unit_amount: plan.balanceDue, product_data: { name: `Balance for order #${order.number}` } } }],
		payment_intent_data: { metadata: { orderId: id, balanceFor: ctx.input.id } },
	});
	balance.sessionId = session.id;
	balance.events.push(event("stripe_session", session.id));
	await saveOrder(ctx, id, balance);
	plan.balanceOrderId = id;
	order.events.push(event("balance_link_sent", `#${balance.number}`));
	await saveOrder(ctx, ctx.input.id, order);
	if (ctx.email && order.email) {
		await ctx.email.send({ to: order.email, subject: `Balance due for order #${order.number} — ${settings.storeName || "our store"}`, text: `Hi ${order.customerName ?? ""},\n\nThe remaining balance of ${formatMoney(plan.balanceDue, order.currency)} for order #${order.number} can be paid here:\n\n${session.url}\n\nThank you.` }).catch((err) => console.error("[commerce] balance email failed:", err));
	}
	return { order, status: "link_sent", balanceOrderId: id, url: session.url };
}

/* ---- config export (theme snapshots) ---------------------------------------- */

const EXPORT_SETTING_KEYS = ["currency", "paymentProvider", "allowManualPayment", "customerAccounts", "storeName", "automaticTax", "shippingRates", "shippingCountries", "allowPromotionCodes", "collectPhone", "successPath", "cancelPath"];

/**
 * The plugin's current setup as a theme-seed `plugins.<id>` fragment:
 * non-secret settings and discounts. Payment provider keys and webhook
 * secrets, the notify email, and all order/cart/inventory runtime data are
 * left out — a fresh site configures its own provider.
 */
export async function configExportHandler(ctx: RouteContext) {
	const rows = (await ctx.kv.list("settings:").catch(() => null)) ?? [];
	const bag: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
	const settings: Record<string, unknown> = {};
	for (const k of EXPORT_SETTING_KEYS) {
		const v = bag[k];
		if (v !== undefined && v !== null && v !== "") settings[k] = v;
	}
	const calls: Array<{ route: string; body?: unknown; ignoreErrors?: boolean }> = [];
	for (const d of (await discounts(ctx).query({ limit: 200 })).items.sort((a, b) => String(a.data.code ?? a.data.title ?? "").localeCompare(String(b.data.code ?? b.data.title ?? "")))) {
		const rec = { ...(d.data as unknown as Record<string, unknown>) };
		for (const k of ["createdAt", "updatedAt", "usedCount", "timesUsed"]) delete rec[k];
		calls.push({ route: "discounts/save", body: { discount: rec } });
	}
	return { settings, calls };
}
