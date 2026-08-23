/**
 * Routes for sibling plugins (manifest `callers: ["*"]`, reached through
 * `ctx.plugins.call("premium-commerce", "internal/…")`). They let a plugin
 * read the catalogue and orders, ring up an order outside the storefront
 * (a till, a phone order), settle pay-later orders offline, cancel and
 * fulfil. Direct HTTP callers are refused — only plugins get here.
 */

import { available, commitStock, inventoryFor, listProducts, reserveStock } from "../catalog.js";
import { formatMoney } from "../money.js";
import { cancelOrder, emitOrderEvent, event, newOrderId, nextOrderNumber, orders, randomToken, saveOrder, sendOrderEmails, stockLines } from "../orders.js";
import { resolveLine } from "../pricing.js";
import { loadSettings } from "../settings.js";
import { type RouteContext, PluginRouteError, requireCaller } from "../shim.js";
import { recordTransaction } from "../transactions.js";
import type { OfflinePayment, Order, OrderAdjustment, OrderItem } from "../types.js";

const nowIso = () => new Date().toISOString();

export async function internalConfigHandler(ctx: RouteContext) {
	requireCaller(ctx);
	const s = await loadSettings(ctx);
	return { currency: s.currency, storeName: s.storeName, paymentProvider: s.paymentProvider, online: s.paymentProvider !== "none", allowManualPayment: s.allowManualPayment, customerAccounts: s.customerAccounts, successPath: s.successPath, notifyEmail: s.notifyEmail };
}

/** Published products with live availability — the same view the storefront gets. */
export async function internalCatalogHandler(ctx: RouteContext) {
	requireCaller(ctx);
	const s = await loadSettings(ctx);
	const products = await listProducts(ctx, s.currency);
	const inv = await inventoryFor(ctx, products.map((p) => p.id));
	return { currency: s.currency, products: products.map((p) => ({ ...p, availableUnits: available(p, inv.get(p.id)) })) };
}

export async function internalOrderHandler(ctx: RouteContext<{ id?: string; number?: string | number; token?: string }>) {
	requireCaller(ctx);
	let hit: { id: string; data: Order } | undefined;
	if (ctx.input.id) {
		const o = await orders(ctx).get(ctx.input.id);
		if (o) hit = { id: ctx.input.id, data: o };
	} else if (ctx.input.number !== undefined) {
		hit = (await orders(ctx).query({ where: { number: Number(ctx.input.number) }, limit: 1 })).items[0];
	}
	if (!hit) throw PluginRouteError.notFound("Order not found");
	if (ctx.input.token !== undefined && ctx.input.token !== hit.data.accessToken) throw PluginRouteError.notFound("Order not found");
	return { id: hit.id, order: hit.data };
}

export async function internalOrdersHandler(ctx: RouteContext<{ status?: string; channel?: string; limit: number; sinceHours?: number }>) {
	requireCaller(ctx);
	const res = await orders(ctx).query({ where: ctx.input.status ? { status: ctx.input.status } : undefined, orderBy: { createdAt: "desc" }, limit: ctx.input.limit });
	const since = ctx.input.sinceHours ? Date.now() - ctx.input.sinceHours * 3_600_000 : 0;
	return { items: res.items.filter((o) => (!ctx.input.channel || (o.data.channel ?? "web") === ctx.input.channel) && (!since || Date.parse(o.data.createdAt) >= since)).map((o) => ({ id: o.id, order: o.data })) };
}

interface CreateOrderInput {
	items: Array<{ productId: string; quantity: number; options?: Record<string, unknown>; notes?: string }>;
	adjustments?: Array<{ label: string; amount: number; key?: string }>;
	discount?: number;
	customer?: { name?: string; email?: string; phone?: string };
	note?: string;
	channel: string;
	paid: boolean;
	offline?: OfflinePayment;
	extensions?: Record<string, unknown>;
	sendEmails: boolean;
}

/** Ring up an order on behalf of a plugin (till, phone, kiosk). Lines are priced from the catalogue, never from the caller. */
export async function internalCreateOrderHandler(ctx: RouteContext<CreateOrderInput>) {
	const from = requireCaller(ctx);
	const s = await loadSettings(ctx);
	const input = ctx.input;
	const products = await listProducts(ctx, s.currency);
	const items: OrderItem[] = [];
	for (const line of input.items) {
		const p = products.find((x) => x.id === line.productId || x.slug === line.productId);
		if (!p) throw PluginRouteError.badRequest(`Unknown item: ${line.productId}`);
		const r = await resolveLine(ctx, p, s.currency, line.options, undefined);
		const display = [...(r.optionsDisplay ?? []), ...(line.notes ? [{ name: "notes", label: "Notes", value: line.notes }] : [])];
		items.push({ productId: p.id, slug: p.slug, title: p.title, sku: p.sku, unitAmount: r.unitAmount, quantity: Math.max(1, Math.floor(line.quantity)), requiresShipping: false, ...(r.options ? { options: r.options } : {}), ...(display.length ? { optionsDisplay: display } : {}), ...(r.extras ? { extras: r.extras, baseUnitAmount: r.baseUnitAmount } : {}), ...(r.stockKeys.length > 1 ? { stockKeys: r.stockKeys } : {}) });
	}
	const subtotal = items.reduce((n, it) => n + it.unitAmount * it.quantity, 0);
	const discount = Math.min(subtotal, Math.max(0, Math.round(input.discount ?? 0)));
	const adjustments: OrderAdjustment[] = (input.adjustments ?? []).map((a) => ({ label: a.label, amount: Math.round(a.amount), provider: from, key: a.key }));
	const total = Math.max(0, subtotal - discount + adjustments.reduce((n, a) => n + a.amount, 0));
	const paidNow = input.paid;
	if (paidNow && !input.offline) throw PluginRouteError.badRequest("A paid order needs `offline` (how the money was taken)");
	if (input.offline?.tendered !== undefined && paidNow && input.offline.tendered < total) throw PluginRouteError.badRequest("Cash tendered is less than the total");
	const id = newOrderId();
	const now = nowIso();
	const offline: OfflinePayment | null = input.offline ? { ...input.offline, ...(input.offline.tendered !== undefined ? { change: input.offline.tendered - total } : {}) } : null;
	const order: Order = {
		number: await nextOrderNumber(ctx),
		status: paidNow ? "paid" : "awaiting_payment",
		paymentMethod: "manual",
		currency: s.currency,
		items,
		subtotal,
		shipping: 0,
		tax: 0,
		discount,
		adjustments,
		total,
		email: input.customer?.email?.trim() ?? "",
		customerName: input.customer?.name?.trim() || undefined,
		phone: input.customer?.phone?.trim() || undefined,
		note: input.note?.trim() || undefined,
		userId: null,
		cartId: null,
		channel: input.channel,
		extensions: input.extensions ?? {},
		offline: paidNow ? offline : null,
		accessToken: randomToken(),
		createdAt: now,
		updatedAt: now,
		paidAt: paidNow ? now : undefined,
		paymentRef: paidNow ? offline?.note || offline?.method : undefined,
		events: [event("created", `${input.channel} · ${from}${offline?.by ? ` · ${offline.by}` : ""}`), ...(paidNow ? [event("paid", `${offline?.method}${offline?.by ? ` · ${offline.by}` : ""}`)] : [])],
		meta: { ip: null, country: null, userAgent: input.channel },
	};
	await saveOrder(ctx, id, order);
	if (paidNow) await commitStock(ctx, stockLines(order));
	else await reserveStock(ctx, stockLines(order));
	await emitOrderEvent(ctx, "order.created", id, order);
	if (paidNow) {
		await recordTransaction(ctx, id, order, { provider: "manual", kind: "payment", amount: total, status: "succeeded", providerRef: `${input.channel}:${order.number}`, note: offline?.method }).catch(() => undefined);
		await emitOrderEvent(ctx, "order.paid", id, order);
	}
	if (input.sendEmails && order.email) await sendOrderEmails(ctx, s, id, order).catch(() => undefined);
	return { id, number: order.number, total, status: order.status, change: offline?.change ?? 0, totalFormatted: formatMoney(total, s.currency) };
}

/** Settle a pay-later order with money taken outside the PSP (till, terminal, transfer). */
export async function internalSettleHandler(ctx: RouteContext<{ id: string; offline: OfflinePayment; adjustments?: Array<{ label: string; amount: number; key?: string }> }>) {
	const from = requireCaller(ctx);
	const o = await orders(ctx).get(ctx.input.id);
	if (!o) throw PluginRouteError.notFound("Order not found");
	if (o.status !== "awaiting_payment" && o.status !== "pending") throw PluginRouteError.badRequest(`Order is ${o.status}`);
	for (const a of ctx.input.adjustments ?? []) {
		const amount = Math.round(a.amount);
		if (!amount) continue;
		o.adjustments = [...(o.adjustments ?? []), { label: a.label, amount, provider: from, key: a.key }];
		o.total += amount;
	}
	if (ctx.input.offline.tendered !== undefined && ctx.input.offline.tendered < o.total) throw PluginRouteError.badRequest("Cash tendered is less than the total");
	const now = nowIso();
	o.status = "paid";
	o.paidAt = now;
	o.expiresAt = undefined;
	o.offline = { ...ctx.input.offline, ...(ctx.input.offline.tendered !== undefined ? { change: ctx.input.offline.tendered - o.total } : {}) };
	o.paymentRef = ctx.input.offline.note || ctx.input.offline.method;
	o.events.push(event("paid", `${ctx.input.offline.method}${ctx.input.offline.by ? ` · ${ctx.input.offline.by}` : ""}`));
	await saveOrder(ctx, ctx.input.id, o);
	await commitStock(ctx, stockLines(o));
	await recordTransaction(ctx, ctx.input.id, o, { provider: "manual", kind: "payment", amount: o.total, status: "succeeded", providerRef: `${from}:${o.number}:${now}`, note: ctx.input.offline.method }).catch(() => undefined);
	await emitOrderEvent(ctx, "order.paid", ctx.input.id, o);
	return { id: ctx.input.id, number: o.number, status: o.status, total: o.total, change: o.offline?.change ?? 0 };
}

export async function internalCancelHandler(ctx: RouteContext<{ id: string; note?: string }>) {
	const from = requireCaller(ctx);
	const o = await orders(ctx).get(ctx.input.id);
	if (!o) throw PluginRouteError.notFound("Order not found");
	const updated = await cancelOrder(ctx, ctx.input.id, o, ctx.input.note ? `${ctx.input.note} · ${from}` : `cancelled by ${from}`);
	return { id: ctx.input.id, status: updated.status };
}

export async function internalFulfilHandler(ctx: RouteContext<{ id: string; note?: string }>) {
	const from = requireCaller(ctx);
	const o = await orders(ctx).get(ctx.input.id);
	if (!o) throw PluginRouteError.notFound("Order not found");
	if (o.status === "fulfilled") return { id: ctx.input.id, status: o.status };
	if (o.status !== "paid") throw PluginRouteError.conflict(`Cannot fulfil an order that is ${o.status}`);
	o.status = "fulfilled";
	o.events.push(event("fulfilled", ctx.input.note ? `${ctx.input.note} · ${from}` : from));
	await saveOrder(ctx, ctx.input.id, o);
	await emitOrderEvent(ctx, "order.fulfilled", ctx.input.id, o);
	return { id: ctx.input.id, status: o.status };
}

/** Keep public-safe state on the order under the caller's id (shown on the receipt page, never trusted for money). */
export async function internalExtensionHandler(ctx: RouteContext<{ id: string; meta: unknown }>) {
	const from = requireCaller(ctx);
	const o = await orders(ctx).get(ctx.input.id);
	if (!o) throw PluginRouteError.notFound("Order not found");
	o.extensions = { ...(o.extensions ?? {}), [from]: ctx.input.meta };
	await saveOrder(ctx, ctx.input.id, o);
	return { id: ctx.input.id };
}

/**
 * Records left behind by Commerce 0.9.x, which bundled bookings and the
 * restaurant: Bookings and Restaurant import them once (`migrate/commerce`).
 * The staff PIN salt travels along so existing PINs keep working.
 */
export async function internalLegacyExportHandler(ctx: RouteContext<{ collection: string; cursor?: string }>) {
	requireCaller(ctx, "premium-bookings", "premium-restaurant");
	const col = ctx.storage[ctx.input.collection];
	if (!col) return { items: [], cursor: undefined, hasMore: false, salt: null };
	const res = await col.query({ limit: 100, cursor: ctx.input.cursor });
	const salt = ctx.input.collection === "staff" ? await ctx.kv.get<string>("staff:salt") : null;
	return { items: res.items, cursor: res.cursor, hasMore: res.hasMore, salt };
}
