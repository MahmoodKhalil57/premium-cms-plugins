/**
 * The staff app (PIN sessions): POS (ring up orders through Commerce, cash /
 * card / open tabs, delivery dispatch), cash drawer, kitchen display per
 * station and the browser print agent.
 */
import { commerceCall, commerceConfig, getOrder, menuProducts, recentOrders } from "../commerce.js";
import { menuHandler } from "./public.js";
import { closeShift, currentShift, fulfilments, headerValue, newId, nowIso, onOrderCommitted, openShift, printJobs, printers, publicFulfilment, publicTable, queuePrintJobs, recordCardSale, recordShiftMovement, requireStaff, saveFulfilment, staff, staffLogin, staffLogout, syncOrderKitchen, tables, tickets } from "../restaurant.js";
import { loadSettings } from "../settings.js";
import { PluginRouteError, type RouteContext } from "../shim.js";
import type { FulfilmentMode, FulfilmentRecord, OrderMeta, TicketRecord } from "../types.js";

const PLUGIN_ID = "premium-restaurant";

/* ---- sessions ---------------------------------------------------------------- */

export async function staffLoginHandler(ctx: RouteContext<{ pin: string }>) {
	const s = await loadSettings(ctx);
	const { token, session } = await staffLogin(ctx, ctx.input.pin);
	const cc = await commerceConfig(ctx).catch(() => ({ currency: "usd", storeName: "" }));
	return { token, staff: { id: session.staffId, name: session.name, roles: session.roles }, stations: s.kdsStations, currency: cc.currency, storeName: s.storeName || cc.storeName, timezone: s.timezone, shift: await currentShift(ctx), modes: s.fulfilmentModes, tipPresets: s.tipPresets, serviceChargePct: s.serviceChargePct };
}

export async function staffLogoutHandler(ctx: RouteContext<{ staffToken?: string }>) {
	const token = headerValue(ctx.request, "x-staff-token") || ctx.input?.staffToken || "";
	if (token) await staffLogout(ctx, token);
	return { ok: true };
}

export async function staffMeHandler(ctx: RouteContext) {
	const session = await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const cc = await commerceConfig(ctx).catch(() => ({ currency: "usd", storeName: "" }));
	return { staff: { id: session.staffId, name: session.name, roles: session.roles }, stations: s.kdsStations, currency: cc.currency, storeName: s.storeName || cc.storeName, timezone: s.timezone, shift: await currentShift(ctx), modes: s.fulfilmentModes, tipPresets: s.tipPresets, serviceChargePct: s.serviceChargePct };
}

/* ---- POS ------------------------------------------------------------------------ */

export async function posMenuHandler(ctx: RouteContext) {
	await requireStaff(ctx);
	const menu = await menuHandler(ctx);
	const tbl = (await tables(ctx).query({ limit: 200 })).items.filter((t) => t.data.active).map((t) => publicTable(t.id, t.data));
	const drivers = (await staff(ctx).query({ limit: 200 })).items.filter((m) => m.data.active && m.data.roles.includes("driver")).map((m) => ({ id: m.id, name: m.data.name }));
	return { ...menu, tables: tbl, drivers };
}

const OPEN_KITCHEN = new Set(["new", "preparing", "ready", "served", "out_for_delivery"]);

/** Open orders for the floor: Commerce orders with a restaurant fulfilment that is not finished. */
export async function posOrdersHandler(ctx: RouteContext<{ mode?: FulfilmentMode; includeDone?: boolean }>) {
	await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const recent = await recentOrders(ctx, { limit: 200, sinceHours: 48 });
	const fs = await fulfilments(ctx).getMany(recent.map((r) => r.id));
	const list = recent
		.map(({ id, order: o }) => ({ id, o, f: fs.get(id) }))
		.filter(({ o, f }) => f && o.status !== "cancelled" && o.status !== "failed" && o.status !== "pending" && (ctx.input.includeDone || OPEN_KITCHEN.has(f.kitchen) || o.status === "awaiting_payment"))
		.filter(({ f }) => !ctx.input.mode || f!.mode === ctx.input.mode)
		.map(({ id, o, f }) => ({ id, number: o.number, status: o.status, total: o.total, currency: o.currency, customerName: o.customerName ?? null, phone: o.phone ?? null, note: o.note ?? null, createdAt: o.createdAt, items: o.items.map((it) => ({ title: it.title, quantity: it.quantity, unitAmount: it.unitAmount, options: it.optionsDisplay?.map((x) => x.value).join(", ") ?? null })), fulfilment: publicFulfilment(f, s.timezone), address: o.shippingAddress ?? null }));
	return { orders: list };
}

interface PosOrderInput {
	items: Array<{ productId: string; quantity: number; options?: Record<string, unknown>; notes?: string }>;
	mode: FulfilmentMode;
	tableId?: string;
	customerName?: string;
	phone?: string;
	email?: string;
	note?: string;
	tip?: number;
	discount?: number;
	payment: { type: "cash" | "card_terminal" | "later"; tendered?: number; note?: string };
}

/** Ring up an order at the counter / table. Commerce prices the lines; cash and card settle immediately, "later" keeps a tab open. */
export async function posOrderHandler(ctx: RouteContext<PosOrderInput>) {
	const session = await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const input = ctx.input;
	if (!input.items?.length) throw PluginRouteError.badRequest("Add something to the order first");
	const table = input.mode === "dine_in" && input.tableId ? await tables(ctx).get(input.tableId) : null;
	const shift = await currentShift(ctx);
	const pay = input.payment;
	const paidNow = pay.type === "cash" || pay.type === "card_terminal";
	const meta: OrderMeta = { mode: input.mode, at: null, tableId: table ? input.tableId! : null, table: table?.name ?? null, zoneId: null, zone: null, payLater: !paidNow, staffId: session.staffId, staffName: session.name, shiftId: shift?.id ?? null };
	const adjustments: Array<{ label: string; amount: number; key: string }> = [];
	if (input.mode === "dine_in" && s.serviceChargePct > 0) {
		// Same prices Commerce will use (options deltas aside); the receipt shows the exact figures.
		const { products } = await menuProducts(ctx);
		const sub = input.items.reduce((n, l) => n + (products.find((p) => p.id === l.productId || p.slug === l.productId)?.unitAmount ?? 0) * l.quantity, 0);
		adjustments.push({ label: `Service ${s.serviceChargePct}%`, amount: Math.round((sub - Math.round(input.discount ?? 0)) * s.serviceChargePct / 100), key: "service" });
	}
	if (input.tip && input.tip > 0) adjustments.push({ label: "Tip", amount: Math.round(input.tip), key: "tip" });
	const r = await commerceCall<{ id: string; number: number; total: number; status: string; change: number }>(ctx, "internal/create-order", {
		items: input.items.map((l) => ({ productId: l.productId, quantity: l.quantity, options: l.options, notes: l.notes })),
		adjustments,
		discount: Math.max(0, Math.round(input.discount ?? 0)),
		customer: { name: input.customerName?.trim() || (table ? table.name : "Walk-in"), email: input.email?.trim() || undefined, phone: input.phone?.trim() || undefined },
		note: input.note?.trim() || undefined,
		channel: "pos",
		paid: paidNow,
		offline: paidNow ? { method: pay.type, tendered: pay.type === "cash" ? pay.tendered : undefined, note: pay.note, by: session.name } : undefined,
		extensions: { [PLUGIN_ID]: meta },
		sendEmails: Boolean(input.email),
	});
	if (paidNow) {
		if (pay.type === "cash") await recordShiftMovement(ctx, "sale", r.total, `#${r.number}`, r.id);
		else await recordCardSale(ctx, r.total);
	}
	// The order events already created the fulfilment + tickets; make sure (a missed event must not lose a ticket).
	const f = await fulfilments(ctx).get(r.id);
	if (f && !f.ticketsCreated) {
		const { order } = await getOrder(ctx, { id: r.id });
		await onOrderCommitted(ctx, s, r.id, order, f).catch(() => undefined);
	}
	return { id: r.id, number: r.number, total: r.total, change: r.change, status: r.status };
}

/** Settle an open tab / pay-at-table / pay-on-collection order. */
export async function posPayHandler(ctx: RouteContext<{ orderId: string; type: "cash" | "card_terminal"; tendered?: number; note?: string; tip?: number }>) {
	const session = await requireStaff(ctx);
	const tip = Math.max(0, Math.round(ctx.input.tip ?? 0));
	const r = await commerceCall<{ id: string; number: number; status: string; total: number; change: number }>(ctx, "internal/settle", {
		id: ctx.input.orderId,
		offline: { method: ctx.input.type, tendered: ctx.input.type === "cash" ? ctx.input.tendered : undefined, note: ctx.input.note, by: session.name },
		adjustments: tip ? [{ label: "Tip", amount: tip, key: "tip" }] : [],
	});
	if (ctx.input.type === "cash") await recordShiftMovement(ctx, "sale", r.total, `#${r.number}`, ctx.input.orderId);
	else await recordCardSale(ctx, r.total);
	const f = await fulfilments(ctx).get(ctx.input.orderId);
	if (f) {
		f.staffId = session.staffId;
		f.staffName = session.name;
		if (f.mode === "dine_in" && (f.kitchen === "served" || f.kitchen === "ready")) f.kitchen = "completed";
		await saveFulfilment(ctx, ctx.input.orderId, f);
	}
	return { id: ctx.input.orderId, number: r.number, status: r.status, total: r.total, change: r.change };
}

export async function posVoidHandler(ctx: RouteContext<{ orderId: string; reason?: string }>) {
	const session = await requireStaff(ctx, "manager");
	const { order } = await getOrder(ctx, { id: ctx.input.orderId });
	const wasCashPaid = order.status === "paid" && order.offline?.method === "cash";
	const r = await commerceCall<{ id: string; status: string }>(ctx, "internal/cancel", { id: ctx.input.orderId, note: `void · ${session.name}${ctx.input.reason ? ` · ${ctx.input.reason}` : ""}` });
	if (wasCashPaid) await recordShiftMovement(ctx, "refund", order.total, `void #${order.number}`, ctx.input.orderId);
	return { id: ctx.input.orderId, status: r.status };
}

/** Delivery dispatch: assign a driver (out for delivery) or mark delivered / done. */
export async function posDispatchHandler(ctx: RouteContext<{ orderId: string; driverId?: string; delivered?: boolean }>) {
	const session = await requireStaff(ctx);
	const f = await fulfilments(ctx).get(ctx.input.orderId);
	if (!f) throw PluginRouteError.notFound("Order not found");
	if (ctx.input.delivered) {
		f.kitchen = f.mode === "delivery" ? "delivered" : "completed";
		f.completedAt = nowIso();
		await saveFulfilment(ctx, ctx.input.orderId, f);
		if (f.orderStatus === "paid") await commerceCall(ctx, "internal/fulfil", { id: ctx.input.orderId, note: `${f.kitchen} · ${session.name}` }).catch(() => undefined);
	} else {
		const driver = ctx.input.driverId ? await staff(ctx).get(ctx.input.driverId) : null;
		f.driverId = ctx.input.driverId ?? session.staffId;
		f.driverName = driver?.name ?? session.name;
		f.kitchen = "out_for_delivery";
		await saveFulfilment(ctx, ctx.input.orderId, f);
	}
	return { id: ctx.input.orderId, kitchen: f.kitchen, driverName: f.driverName ?? null };
}

/* ---- cash drawer ----------------------------------------------------------------- */

export async function shiftHandler(ctx: RouteContext) {
	await requireStaff(ctx);
	return { shift: await currentShift(ctx) };
}
export async function shiftOpenHandler(ctx: RouteContext<{ float: number; note?: string }>) {
	const session = await requireStaff(ctx);
	return { shift: await openShift(ctx, session, Math.max(0, Math.round(ctx.input.float)), ctx.input.note) };
}
export async function shiftCloseHandler(ctx: RouteContext<{ counted: number; note?: string }>) {
	await requireStaff(ctx, "manager");
	return { shift: await closeShift(ctx, Math.max(0, Math.round(ctx.input.counted)), ctx.input.note) };
}
export async function shiftMovementHandler(ctx: RouteContext<{ kind: "pay_in" | "pay_out"; amount: number; note?: string }>) {
	await requireStaff(ctx);
	if (!(await currentShift(ctx))) throw PluginRouteError.badRequest("Open the drawer first");
	await recordShiftMovement(ctx, ctx.input.kind, Math.max(0, Math.round(ctx.input.amount)), ctx.input.note);
	return { shift: await currentShift(ctx) };
}

/* ---- kitchen display --------------------------------------------------------------- */

export async function kdsTicketsHandler(ctx: RouteContext<{ station?: string; includeRecent?: boolean }>) {
	await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const recent = await tickets(ctx).query({ orderBy: { createdAt: "asc" }, limit: 300 });
	const cutoff = Date.now() - 2 * 3_600_000;
	const list = recent.items
		.filter(({ data: t }) => (!ctx.input.station || t.station === ctx.input.station) && (t.status === "new" || t.status === "preparing" || t.status === "ready" || (ctx.input.includeRecent && Date.parse(t.bumpedAt ?? t.createdAt) > cutoff)))
		.map(({ id, data: t }) => ({ id, ...t, ageSec: Math.round((Date.now() - Date.parse(t.createdAt)) / 1000) }));
	return { tickets: list, stations: s.kdsStations, serverTime: nowIso() };
}

export async function kdsBumpHandler(ctx: RouteContext<{ id: string; status: TicketRecord["status"] }>) {
	await requireStaff(ctx);
	const t = await tickets(ctx).get(ctx.input.id);
	if (!t) throw PluginRouteError.notFound("Ticket not found");
	const now = nowIso();
	t.status = ctx.input.status;
	if (ctx.input.status === "preparing") t.startedAt = t.startedAt ?? now;
	if (ctx.input.status === "ready") t.readyAt = now;
	if (ctx.input.status === "served" || ctx.input.status === "cancelled") t.bumpedAt = now;
	await tickets(ctx).put(ctx.input.id, t);
	await syncOrderKitchen(ctx, t.orderId);
	return { id: ctx.input.id, status: t.status };
}

/* ---- print agent --------------------------------------------------------------------- */

export async function printJobsHandler(ctx: RouteContext<{ printerId?: string; limit?: number }>) {
	await requireStaff(ctx);
	const all = (await printJobs(ctx).query({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, limit: Math.min(50, ctx.input.limit ?? 20) })).items.filter((j) => !ctx.input.printerId || j.data.printerId === ctx.input.printerId);
	const ps = (await printers(ctx).query({ limit: 50 })).items.map((p) => ({ id: p.id, ...p.data }));
	return { jobs: all.map((j) => ({ id: j.id, ...j.data })), printers: ps };
}

export async function printAckHandler(ctx: RouteContext<{ id: string; status: "printed" | "failed"; error?: string }>) {
	await requireStaff(ctx);
	const j = await printJobs(ctx).get(ctx.input.id);
	if (!j) throw PluginRouteError.notFound("Job not found");
	j.status = ctx.input.status;
	j.attempts++;
	j.error = ctx.input.error ?? null;
	if (ctx.input.status === "printed") j.printedAt = nowIso();
	await printJobs(ctx).put(ctx.input.id, j);
	return { id: ctx.input.id, status: j.status };
}

/** Reprint the receipt of an order (staff app / admin). */
export async function reprintHandler(ctx: RouteContext<{ orderId: string }>) {
	await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const { id, order } = await getOrder(ctx, { id: ctx.input.orderId });
	const f = (await fulfilments(ctx).get(id)) ?? ({ orderId: id, orderNumber: order.number, mode: "pos", at: null, deliveryFee: 0, serviceCharge: 0, tip: 0, payLater: false, kitchen: "new", orderStatus: order.status, ticketsCreated: true, receiptPrinted: false, createdAt: order.createdAt, updatedAt: nowIso() } as FulfilmentRecord);
	const n = await queuePrintJobs(ctx, s, id, order, f, [], ["receipt"]);
	return { queued: n };
}

export { newId };
