/**
 * Restaurant routes: public config/menu/slots/zones/tables/tracking,
 * reservations, and the staff app (PIN sessions) — POS, cash drawer,
 * kitchen display, print agent. Admin routes manage tables, printers,
 * shifts and reservations.
 */
import { listProducts } from "../catalog.js";
import { event, nextOrderNumber, newOrderId, orders, randomToken, saveOrder, sendOrderEmails } from "../orders.js";
import { resolveLine } from "../pricing.js";
import { loadSettings } from "../settings.js";
import { staff } from "../bookings.js";
import { recordTransaction } from "../transactions.js";
import {
	closeShift, createReservation, currentShift, hashPin, headerValue, isOpenNow, matchZone, normalizeTable, onRestaurantOrderCommitted, openShift, orderSlots, printJobs, printers, publicFulfilment, publicReservation, publicTable, queuePrintJobs, receiptText, recordShiftMovement, requireStaff, reservationAvailability, reservations, sendToPrintNode, shifts, staffLogin, staffLogout, syncOrderKitchen, tableByCode, tables, tickets, type PrinterRecord, type ReservationRecord, type TicketRecord,
} from "../restaurant.js";
import { PluginRouteError, type PluginContext, type RouteContext } from "../shim.js";
import type { Fulfilment, FulfilmentMode, Order, OrderItem, Product } from "../types.js";
import { formatMoney } from "../money.js";

const nowIso = () => new Date().toISOString();

/* ---- public ------------------------------------------------------------- */

export async function restaurantConfigHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	return {
		enabled: s.restaurantMode,
		storeName: s.storeName,
		currency: s.currency,
		modes: s.fulfilmentModes,
		openNow: isOpenNow(s),
		openingHours: s.openingHours,
		timezone: s.bookingTimezone,
		prepTimeMin: s.prepTimeMin,
		tipPresets: s.tipPresets,
		serviceChargePct: s.serviceChargePct,
		payAtTable: s.allowPayAtTable,
		payOnCollection: s.allowPayOnCollection,
		qrOrdering: s.qrOrdering,
		reservations: s.reservationsEnabled,
		maxPartySize: s.maxPartySize,
		zones: s.deliveryZones.map((z) => ({ id: z.id, name: z.name, fee: z.fee, minimum: z.minimum, etaMin: z.etaMin })),
	};
}

/** Menu grouped by category with everything the storefront needs to render dishes and modifiers. */
export async function restaurantMenuHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	const products = (await listProducts(ctx, s.currency)).filter((p) => p.available !== false);
	const cats = new Map<string, Product[]>();
	for (const p of products) cats.set(p.category || "Menu", [...(cats.get(p.category || "Menu") ?? []), p]);
	return {
		currency: s.currency,
		categories: [...cats.entries()].map(([name, items]) => ({
			name,
			items: items.map((p) => ({ id: p.id, slug: p.slug, title: p.title, unitAmount: p.unitAmount, summary: p.summary ?? null, description: p.description ?? null, image: p.image ?? null, tags: p.tags ?? [], popular: p.popular ?? false, options: p.options ?? [], station: p.station ?? null })),
		})),
	};
}

export async function orderSlotsHandler(ctx: RouteContext<{ mode: FulfilmentMode; date: string }>) {
	const s = await loadSettings(ctx);
	return orderSlots(ctx, s, ctx.input.mode, ctx.input.date);
}

export async function zoneHandler(ctx: RouteContext<{ postcode: string }>) {
	const s = await loadSettings(ctx);
	const z = matchZone(s.deliveryZones, ctx.input.postcode);
	return z ? { zone: { id: z.id, name: z.name, fee: z.fee, minimum: z.minimum, etaMin: z.etaMin } } : { zone: null, message: "Sorry, we do not deliver there yet — pickup is available." };
}

export async function tableHandler(ctx: RouteContext<{ code: string }>) {
	const s = await loadSettings(ctx);
	if (!s.qrOrdering) throw PluginRouteError.badRequest("Table ordering is off");
	const t = await tableByCode(ctx, ctx.input.code);
	if (!t) throw PluginRouteError.notFound("Unknown table code");
	return { table: publicTable(t.id, t.data) };
}

/** Live order status for the tracking page (number + access token). */
export async function trackHandler(ctx: RouteContext<{ order: string | number; token: string }>) {
	const s = await loadSettings(ctx);
	const hit = (await orders(ctx).query({ where: { number: Number(ctx.input.order) }, limit: 1 })).items[0];
	if (!hit || hit.data.accessToken !== ctx.input.token) throw PluginRouteError.notFound("Order not found");
	const o = hit.data;
	return { number: o.number, status: o.status, total: o.total, currency: o.currency, fulfilment: publicFulfilment(o.fulfilment, s.bookingTimezone), items: o.items.map((it) => ({ title: it.title, quantity: it.quantity })), events: o.events.filter((e) => e.type === "kitchen" || e.type === "paid" || e.type === "created").map((e) => ({ at: e.at, type: e.type, note: e.note ?? null })) };
}

/* ---- reservations (public) ------------------------------------------------ */

export async function reservationAvailabilityHandler(ctx: RouteContext<{ date: string; partySize: number }>) {
	const s = await loadSettings(ctx);
	if (!s.reservationsEnabled) throw PluginRouteError.badRequest("Reservations are not open online");
	const r = await reservationAvailability(ctx, s, ctx.input.date, ctx.input.partySize);
	return { date: r.date, slots: r.slots.map((x) => ({ at: x.at, label: x.label })) };
}

export async function reservationCreateHandler(ctx: RouteContext<{ name: string; email: string; phone?: string; partySize: number; at: string; notes?: string }>) {
	const s = await loadSettings(ctx);
	if (!s.reservationsEnabled) throw PluginRouteError.badRequest("Reservations are not open online");
	const { id, reservation } = await createReservation(ctx, s, ctx.input);
	return { reservation: publicReservation(id, reservation, s), token: reservation.accessToken };
}

export async function reservationLookupHandler(ctx: RouteContext<{ id: string; token: string }>) {
	const s = await loadSettings(ctx);
	const r = await reservations(ctx).get(ctx.input.id);
	if (!r || r.accessToken !== ctx.input.token) throw PluginRouteError.notFound("Reservation not found");
	return { reservation: publicReservation(ctx.input.id, r, s) };
}

export async function reservationCancelHandler(ctx: RouteContext<{ id: string; token: string }>) {
	const s = await loadSettings(ctx);
	const r = await reservations(ctx).get(ctx.input.id);
	if (!r || r.accessToken !== ctx.input.token) throw PluginRouteError.notFound("Reservation not found");
	if (r.status === "confirmed") {
		r.status = "cancelled";
		r.updatedAt = nowIso();
		await reservations(ctx).put(ctx.input.id, r);
	}
	return { reservation: publicReservation(ctx.input.id, r, s) };
}

/* ---- staff sessions -------------------------------------------------------- */

export async function staffLoginHandler(ctx: RouteContext<{ pin: string }>) {
	const s = await loadSettings(ctx);
	if (!s.restaurantMode) throw PluginRouteError.badRequest("Restaurant mode is off");
	const { token, session } = await staffLogin(ctx, ctx.input.pin);
	return { token, staff: { id: session.staffId, name: session.name, roles: session.roles }, stations: s.kdsStations, currency: s.currency, storeName: s.storeName, timezone: s.bookingTimezone, shift: await currentShift(ctx) };
}

export async function staffLogoutHandler(ctx: RouteContext<{ staffToken?: string }>) {
	const token = headerValue(ctx.request, "x-staff-token") || ctx.input?.staffToken || "";
	if (token) await staffLogout(ctx, token);
	return { ok: true };
}

export async function staffMeHandler(ctx: RouteContext) {
	const session = await requireStaff(ctx);
	const s = await loadSettings(ctx);
	return { staff: { id: session.staffId, name: session.name, roles: session.roles }, stations: s.kdsStations, currency: s.currency, storeName: s.storeName, timezone: s.bookingTimezone, shift: await currentShift(ctx), modes: s.fulfilmentModes, tipPresets: s.tipPresets, serviceChargePct: s.serviceChargePct };
}

/* ---- POS ------------------------------------------------------------------- */

export async function posMenuHandler(ctx: RouteContext) {
	await requireStaff(ctx);
	const menu = await restaurantMenuHandler(ctx);
	const tbl = (await tables(ctx).query({ limit: 200 })).items.filter((t) => t.data.active).map((t) => publicTable(t.id, t.data));
	const drivers = (await staff(ctx).query({ limit: 200 })).items.filter((m) => m.data.active && ((m.data as { roles?: string[] }).roles ?? []).includes("driver")).map((m) => ({ id: m.id, name: m.data.name }));
	return { ...menu, tables: tbl, drivers };
}

const OPEN_KITCHEN = new Set(["new", "preparing", "ready", "served", "out_for_delivery"]);

/** Open orders for the floor: anything with fulfilment that is not finished. */
export async function posOrdersHandler(ctx: RouteContext<{ mode?: FulfilmentMode; includeDone?: boolean }>) {
	await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const recent = await orders(ctx).query({ orderBy: { createdAt: "desc" }, limit: 200 });
	const list = recent.items
		.filter(({ data: o }) => o.fulfilment && o.status !== "cancelled" && o.status !== "failed" && o.status !== "pending" && (ctx.input.includeDone || OPEN_KITCHEN.has(o.fulfilment.kitchen) || o.status === "awaiting_payment"))
		.filter(({ data: o }) => !ctx.input.mode || o.fulfilment?.mode === ctx.input.mode)
		.map(({ id, data: o }) => ({ id, number: o.number, status: o.status, total: o.total, currency: o.currency, customerName: o.customerName ?? null, phone: o.phone ?? null, note: o.note ?? null, createdAt: o.createdAt, items: o.items.map((it) => ({ title: it.title, quantity: it.quantity, unitAmount: it.unitAmount, options: it.optionsDisplay?.map((x) => x.value).join(", ") ?? null })), fulfilment: publicFulfilment(o.fulfilment, s.bookingTimezone), address: o.shippingAddress ?? null }));
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

/** Ring up an order at the counter / table. Cash and card settle immediately; "later" keeps a tab open. */
export async function posOrderHandler(ctx: RouteContext<PosOrderInput>) {
	const session = await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const input = ctx.input;
	if (!input.items?.length) throw PluginRouteError.badRequest("Add something to the order first");
	const products = await listProducts(ctx, s.currency);
	const byId = new Map(products.map((p) => [p.id, p]));
	const items: OrderItem[] = [];
	for (const line of input.items) {
		const p = products.find((x) => x.id === line.productId || x.slug === line.productId);
		if (!p) throw PluginRouteError.badRequest(`Unknown item: ${line.productId}`);
		const r = await resolveLine(ctx, p, s.currency, line.options, undefined);
		items.push({ productId: p.id, slug: p.slug, title: p.title, unitAmount: r.unitAmount, quantity: Math.max(1, Math.floor(line.quantity)), requiresShipping: false, ...(r.options ? { options: r.options } : {}), ...(r.optionsDisplay ? { optionsDisplay: [...r.optionsDisplay, ...(line.notes ? [{ name: "notes", label: "Notes", value: line.notes }] : [])] } : line.notes ? { optionsDisplay: [{ name: "notes", label: "Notes", value: line.notes }] } : {}), ...(r.extras ? { extras: r.extras, baseUnitAmount: r.baseUnitAmount } : {}) });
	}
	const table = input.mode === "dine_in" && input.tableId ? await tables(ctx).get(input.tableId) : null;
	const subtotal = items.reduce((n, it) => n + it.unitAmount * it.quantity, 0);
	const discount = Math.min(subtotal, Math.max(0, Math.round(input.discount ?? 0)));
	const serviceCharge = input.mode === "dine_in" && s.serviceChargePct > 0 ? Math.round((subtotal - discount) * s.serviceChargePct) / 100 : 0;
	const tip = Math.max(0, Math.round(input.tip ?? 0));
	const total = subtotal - discount + serviceCharge + tip;
	const pay = input.payment;
	const paidNow = pay.type === "cash" || pay.type === "card_terminal";
	if (pay.type === "cash" && (pay.tendered ?? 0) < total) throw PluginRouteError.badRequest("Cash tendered is less than the total");
	const shift = await currentShift(ctx);
	const id = newOrderId();
	const now = nowIso();
	const fulfilment: Fulfilment = {
		mode: input.mode,
		at: null,
		table: table ? { id: input.tableId!, name: table.name } : null,
		zone: null,
		deliveryFee: 0,
		serviceCharge,
		tip,
		payLater: !paidNow,
		kitchen: "new",
		staffId: session.staffId,
		staffName: session.name,
		shiftId: shift?.id ?? null,
		paidVia: pay.type === "cash" ? "cash" : pay.type === "card_terminal" ? "card_terminal" : "unpaid",
		...(pay.type === "cash" ? { tendered: pay.tendered, change: (pay.tendered ?? 0) - total } : {}),
		paymentNote: pay.note,
	};
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
		total,
		email: input.email?.trim() ?? "",
		customerName: input.customerName?.trim() || (table ? table.name : "Walk-in"),
		phone: input.phone?.trim(),
		note: input.note?.trim(),
		userId: null,
		cartId: null,
		accessToken: randomToken(),
		createdAt: now,
		updatedAt: now,
		paidAt: paidNow ? now : undefined,
		paymentRef: pay.type === "card_terminal" ? pay.note : undefined,
		fulfilment,
		events: [event("created", `POS · ${session.name}`), ...(paidNow ? [event("paid", pay.type === "cash" ? `cash · ${session.name}` : `card terminal · ${session.name}`)] : [])],
		meta: { ip: null, country: null, userAgent: "pos" },
	} as Order;
	await saveOrder(ctx, id, order);
	if (paidNow) {
		await recordTransaction(ctx, id, order, { provider: "manual", kind: "payment", amount: total, status: "succeeded", providerRef: pay.type === "cash" ? "cash" : (pay.note ?? "card") }).catch(() => undefined);
		if (pay.type === "cash") await recordShiftMovement(ctx, "sale", total, `#${order.number}`, id);
		else if (shift) {
			shift.shift.cardSales += total;
			shift.shift.orderCount++;
			await shifts(ctx).put(shift.id, shift.shift);
		}
	}
	await onRestaurantOrderCommitted(ctx, s, id, order, byId);
	if (order.email) await sendOrderEmails(ctx, s, id, order).catch(() => undefined);
	return { id, number: order.number, total, change: fulfilment.change ?? 0, status: order.status };
}

/** Settle an open tab / pay-at-table / pay-on-collection order. */
export async function posPayHandler(ctx: RouteContext<{ orderId: string; type: "cash" | "card_terminal"; tendered?: number; note?: string; tip?: number }>) {
	const session = await requireStaff(ctx);
	const s = await loadSettings(ctx);
	const o = await orders(ctx).get(ctx.input.orderId);
	if (!o) throw PluginRouteError.notFound("Order not found");
	if (o.status !== "awaiting_payment") throw PluginRouteError.badRequest(`Order is ${o.status}`);
	const tip = Math.max(0, Math.round(ctx.input.tip ?? 0));
	if (tip && o.fulfilment) {
		o.fulfilment.tip = (o.fulfilment.tip ?? 0) + tip;
		o.total += tip;
	}
	if (ctx.input.type === "cash" && (ctx.input.tendered ?? 0) < o.total) throw PluginRouteError.badRequest("Cash tendered is less than the total");
	const now = nowIso();
	o.status = "paid";
	o.paidAt = now;
	o.updatedAt = now;
	if (o.fulfilment) {
		o.fulfilment.paidVia = ctx.input.type;
		o.fulfilment.payLater = false;
		o.fulfilment.staffId = session.staffId;
		o.fulfilment.staffName = session.name;
		if (ctx.input.type === "cash") {
			o.fulfilment.tendered = ctx.input.tendered;
			o.fulfilment.change = (ctx.input.tendered ?? 0) - o.total;
		}
		o.fulfilment.paymentNote = ctx.input.note;
		if (o.fulfilment.mode === "dine_in" && (o.fulfilment.kitchen === "served" || o.fulfilment.kitchen === "ready")) o.fulfilment.kitchen = "completed";
	}
	o.events.push(event("paid", `${ctx.input.type === "cash" ? "cash" : "card terminal"} · ${session.name}`));
	await saveOrder(ctx, ctx.input.orderId, o);
	await recordTransaction(ctx, ctx.input.orderId, o, { provider: "manual", kind: "payment", amount: o.total, status: "succeeded", providerRef: ctx.input.type === "cash" ? "cash" : (ctx.input.note ?? "card") }).catch(() => undefined);
	if (ctx.input.type === "cash") await recordShiftMovement(ctx, "sale", o.total, `#${o.number}`, ctx.input.orderId);
	else {
		const shift = await currentShift(ctx);
		if (shift) {
			shift.shift.cardSales += o.total;
			shift.shift.orderCount++;
			await shifts(ctx).put(shift.id, shift.shift);
		}
	}
	await queuePrintJobs(ctx, s, ctx.input.orderId, o, [], ["receipt"]).catch(() => undefined);
	return { id: ctx.input.orderId, number: o.number, status: o.status, total: o.total, change: o.fulfilment?.change ?? 0 };
}

export async function posVoidHandler(ctx: RouteContext<{ orderId: string; reason?: string }>) {
	const session = await requireStaff(ctx, "manager");
	const o = await orders(ctx).get(ctx.input.orderId);
	if (!o) throw PluginRouteError.notFound("Order not found");
	if (o.status === "cancelled") return { id: ctx.input.orderId, status: o.status };
	const wasCashPaid = o.status === "paid" && o.fulfilment?.paidVia === "cash";
	o.status = "cancelled";
	o.updatedAt = nowIso();
	if (o.fulfilment) o.fulfilment.kitchen = "cancelled";
	o.events.push(event("cancelled", `void · ${session.name}${ctx.input.reason ? ` · ${ctx.input.reason}` : ""}`));
	await saveOrder(ctx, ctx.input.orderId, o);
	for (const t of (await tickets(ctx).query({ where: { orderId: ctx.input.orderId }, limit: 20 })).items) {
		t.data.status = "cancelled";
		t.data.bumpedAt = nowIso();
		await tickets(ctx).put(t.id, t.data);
	}
	if (wasCashPaid) await recordShiftMovement(ctx, "refund", o.total, `void #${o.number}`, ctx.input.orderId);
	return { id: ctx.input.orderId, status: o.status };
}

/** Delivery dispatch: assign a driver (out for delivery) or mark delivered. */
export async function posDispatchHandler(ctx: RouteContext<{ orderId: string; driverId?: string; delivered?: boolean }>) {
	const session = await requireStaff(ctx);
	const o = await orders(ctx).get(ctx.input.orderId);
	if (!o?.fulfilment) throw PluginRouteError.notFound("Order not found");
	if (ctx.input.delivered) {
		o.fulfilment.kitchen = o.fulfilment.mode === "delivery" ? "delivered" : "completed";
		o.fulfilment.completedAt = nowIso();
		o.events.push(event("kitchen", `${o.fulfilment.kitchen} · ${session.name}`));
	} else {
		const driver = ctx.input.driverId ? await staff(ctx).get(ctx.input.driverId) : null;
		o.fulfilment.driverId = ctx.input.driverId ?? session.staffId;
		o.fulfilment.driverName = driver?.name ?? session.name;
		o.fulfilment.kitchen = "out_for_delivery";
		o.events.push(event("kitchen", `out for delivery · ${o.fulfilment.driverName}`));
	}
	o.updatedAt = nowIso();
	await saveOrder(ctx, ctx.input.orderId, o);
	return { id: ctx.input.orderId, kitchen: o.fulfilment.kitchen, driverName: o.fulfilment.driverName ?? null };
}

/* ---- cash drawer ----------------------------------------------------------- */

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

/* ---- kitchen display -------------------------------------------------------- */

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

/* ---- print agent -------------------------------------------------------------- */

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

/* ---- admin ---------------------------------------------------------------------- */

export async function tablesListHandler(ctx: RouteContext) {
	const items = (await tables(ctx).query({ limit: 200 })).items.map((t) => publicTable(t.id, t.data)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	return { items };
}
export async function tableSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const existing = ctx.input.id ? await tables(ctx).get(ctx.input.id) : null;
	const rec = normalizeTable(ctx.input.record, existing ?? undefined);
	const dup = (await tables(ctx).query({ where: { code: rec.code }, limit: 1 })).items[0];
	if (dup && dup.id !== ctx.input.id) {
		if (ctx.input.id) throw PluginRouteError.conflict(`Code ${rec.code} is already used by ${dup.data.name}`);
		await tables(ctx).put(dup.id, { ...rec, createdAt: dup.data.createdAt });
		return publicTable(dup.id, rec);
	}
	const id = existing && ctx.input.id ? ctx.input.id : newOrderId();
	await tables(ctx).put(id, rec);
	return publicTable(id, rec);
}
export async function tableDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await tables(ctx).delete(ctx.input.id) };
}

function normalizePrinter(input: Record<string, unknown>, existing?: PrinterRecord): PrinterRecord {
	const name = String(input.name ?? existing?.name ?? "").trim();
	if (!name) throw PluginRouteError.badRequest("Printer name is required");
	const target = (input.target ?? existing?.target ?? "agent") === "printnode" ? "printnode" : "agent";
	const list = (v: unknown, d: string[]) => (v === undefined ? d : (Array.isArray(v) ? v.map(String) : String(v).split(/[,\s]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean));
	const kinds = list(input.kinds, existing?.kinds ?? ["kitchen", "receipt"]).filter((k): k is "kitchen" | "receipt" => k === "kitchen" || k === "receipt");
	const now = nowIso();
	return {
		name,
		target,
		printnodePrinterId: input.printnodePrinterId === undefined ? (existing?.printnodePrinterId ?? null) : Number(input.printnodePrinterId) || null,
		stations: list(input.stations, existing?.stations ?? []),
		kinds: kinds.length ? kinds : ["kitchen", "receipt"],
		width: Math.min(64, Math.max(24, Math.round(Number(input.width ?? existing?.width ?? 32)) || 32)),
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}
export async function printersListHandler(ctx: RouteContext) {
	const items = (await printers(ctx).query({ limit: 50 })).items.map((p) => ({ id: p.id, ...p.data }));
	const queued = (await printJobs(ctx).query({ where: { status: "queued" }, limit: 100 })).items.length;
	const recent = (await printJobs(ctx).query({ orderBy: { createdAt: "desc" }, limit: 30 })).items.map((j) => ({ id: j.id, printerId: j.data.printerId, kind: j.data.kind, title: j.data.title, status: j.data.status, error: j.data.error ?? null, createdAt: j.data.createdAt }));
	return { items, queued, recent };
}
export async function printerSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const existing = ctx.input.id ? await printers(ctx).get(ctx.input.id) : null;
	const match = !ctx.input.id && typeof ctx.input.record.name === "string" ? (await printers(ctx).query({ limit: 50 })).items.find((p) => p.data.name.toLowerCase() === String(ctx.input.record.name).trim().toLowerCase()) : null;
	const rec = normalizePrinter(ctx.input.record, existing ?? match?.data);
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newOrderId());
	await printers(ctx).put(id, rec);
	return { id, ...rec };
}
export async function printerDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await printers(ctx).delete(ctx.input.id) };
}
export async function printTestHandler(ctx: RouteContext<{ id: string }>) {
	const s = await loadSettings(ctx);
	const p = await printers(ctx).get(ctx.input.id);
	if (!p) throw PluginRouteError.notFound("Printer not found");
	const text = `${(s.storeName || "PremiumCMS").padStart(Math.floor((p.width + (s.storeName || "PremiumCMS").length) / 2))}\n${"-".repeat(p.width)}\nTest print · ${new Date().toUTCString()}\n${"-".repeat(p.width)}\n\n\n`;
	const id = newOrderId();
	const job = { printerId: ctx.input.id, kind: "receipt" as const, orderId: null, orderNumber: null, title: "Test print", text, status: "queued" as const, attempts: 0, createdAt: nowIso() };
	await printJobs(ctx).put(id, job);
	if (p.target === "printnode") {
		if (!s.printnodeApiKey || !p.printnodePrinterId) throw PluginRouteError.badRequest("Set the PrintNode API key and the printer's PrintNode id first");
		await sendToPrintNode(ctx, s, id, job, p);
	}
	return { id, status: (await printJobs(ctx).get(id))?.status ?? "queued" };
}

export async function shiftsListHandler(ctx: RouteContext<{ limit?: number }>) {
	const items = (await shifts(ctx).query({ orderBy: { openedAt: "desc" }, limit: Math.min(100, ctx.input.limit ?? 30) })).items.map((x) => ({ id: x.id, ...x.data }));
	return { items };
}

export async function reservationsListHandler(ctx: RouteContext<{ from?: string; to?: string; status?: string }>) {
	const s = await loadSettings(ctx);
	const from = ctx.input.from ? Date.parse(ctx.input.from) : Date.now() - 6 * 3_600_000;
	const to = ctx.input.to ? Date.parse(ctx.input.to) : Date.now() + 14 * 86_400_000;
	const items = (await reservations(ctx).query({ orderBy: { at: "asc" }, limit: 500 })).items
		.filter((r) => Date.parse(r.data.at) >= from && Date.parse(r.data.at) <= to && (!ctx.input.status || r.data.status === ctx.input.status))
		.map((r) => ({ ...publicReservation(r.id, r.data, s), phone: r.data.phone ?? null, endAt: r.data.endAt, source: r.data.source, tableId: r.data.tableId }));
	return { items, timezone: s.bookingTimezone };
}
export async function reservationUpdateHandler(ctx: RouteContext<{ id: string; status?: ReservationRecord["status"]; tableId?: string; notes?: string; record?: Record<string, unknown> }>) {
	const s = await loadSettings(ctx);
	let r = await reservations(ctx).get(ctx.input.id);
	if (!r && ctx.input.record) {
		const rec = ctx.input.record;
		const created = await createReservation(ctx, s, { name: String(rec.name ?? "Walk-in"), email: String(rec.email ?? ""), phone: rec.phone ? String(rec.phone) : undefined, partySize: Number(rec.partySize) || 2, at: String(rec.at), notes: rec.notes ? String(rec.notes) : undefined, source: "pos" });
		return publicReservation(created.id, created.reservation, s);
	}
	if (!r) throw PluginRouteError.notFound("Reservation not found");
	if (ctx.input.status) r.status = ctx.input.status;
	if (ctx.input.tableId !== undefined) {
		r.tableId = ctx.input.tableId || null;
		r.tableName = ctx.input.tableId ? ((await tables(ctx).get(ctx.input.tableId))?.name ?? null) : null;
	}
	if (ctx.input.notes !== undefined) r.notes = ctx.input.notes;
	r.updatedAt = nowIso();
	await reservations(ctx).put(ctx.input.id, r);
	return publicReservation(ctx.input.id, r, s);
}

/** Live board for the admin: open orders by kitchen status + queued prints. */
export async function boardHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	const recent = await orders(ctx).query({ orderBy: { createdAt: "desc" }, limit: 150 });
	const open = recent.items.filter(({ data: o }) => o.fulfilment && o.status !== "cancelled" && o.status !== "failed" && o.status !== "pending" && (OPEN_KITCHEN.has(o.fulfilment.kitchen) || o.status === "awaiting_payment"));
	const queued = (await printJobs(ctx).query({ where: { status: "queued" }, limit: 100 })).items.length;
	const failed = (await printJobs(ctx).query({ where: { status: "failed" }, limit: 100 })).items.length;
	const today = recent.items.filter(({ data: o }) => o.fulfilment && Date.now() - Date.parse(o.createdAt) < 86_400_000 && o.status !== "cancelled");
	return {
		orders: open.map(({ id, data: o }) => ({ id, number: o.number, status: o.status, total: o.total, totalFormatted: formatMoney(o.total, o.currency), customerName: o.customerName ?? null, createdAt: o.createdAt, fulfilment: publicFulfilment(o.fulfilment, s.bookingTimezone), items: o.items.map((it) => `${it.quantity}× ${it.title}`) })),
		prints: { queued, failed },
		today: { orders: today.length, revenue: formatMoney(today.filter(({ data: o }) => o.status === "paid" || o.status === "fulfilled").reduce((n, { data: o }) => n + o.total, 0), s.currency), byMode: Object.fromEntries((["delivery", "pickup", "dine_in", "pos"] as const).map((m) => [m, today.filter(({ data: o }) => o.fulfilment?.mode === m).length])) },
		shift: await currentShift(ctx),
		openNow: isOpenNow(s),
	};
}

/** Admin override of kitchen / fulfilment state. */
export async function orderStatusHandler(ctx: RouteContext<{ id: string; kitchen: Fulfilment["kitchen"] }>) {
	const o = await orders(ctx).get(ctx.input.id);
	if (!o?.fulfilment) throw PluginRouteError.notFound("Order not found");
	o.fulfilment.kitchen = ctx.input.kitchen;
	if (ctx.input.kitchen === "completed" || ctx.input.kitchen === "delivered") o.fulfilment.completedAt = nowIso();
	o.events.push(event("kitchen", `${ctx.input.kitchen} · admin`));
	o.updatedAt = nowIso();
	await saveOrder(ctx, ctx.input.id, o);
	if (ctx.input.kitchen === "completed" || ctx.input.kitchen === "delivered" || ctx.input.kitchen === "cancelled") {
		for (const t of (await tickets(ctx).query({ where: { orderId: ctx.input.id }, limit: 20 })).items) {
			if (t.data.status === "served" || t.data.status === "cancelled") continue;
			t.data.status = ctx.input.kitchen === "cancelled" ? "cancelled" : "served";
			t.data.bumpedAt = nowIso();
			await tickets(ctx).put(t.id, t.data);
		}
	}
	return { id: ctx.input.id, kitchen: o.fulfilment.kitchen };
}

/** Set (or clear) a staff member's POS PIN; the hash is stored, never the PIN. */
export async function staffSetPinHandler(ctx: RouteContext<{ id: string; pin: string; roles?: string[] }>) {
	const m = await staff(ctx).get(ctx.input.id);
	if (!m) throw PluginRouteError.notFound("Staff member not found");
	const rec = m as typeof m & { pinHash?: string | null; roles?: string[] };
	if (ctx.input.pin === "") rec.pinHash = null;
	else if (ctx.input.pin !== "__keep__") {
		const clean = ctx.input.pin.replace(/\D/g, "");
		if (clean.length < 4 || clean.length > 8) throw PluginRouteError.badRequest("PIN must be 4–8 digits");
		const hash = await hashPin(ctx, clean);
		const clash = (await staff(ctx).query({ limit: 200 })).items.find((x) => x.id !== ctx.input.id && (x.data as { pinHash?: string }).pinHash === hash);
		if (clash) throw PluginRouteError.conflict("Another team member already uses that PIN");
		rec.pinHash = hash;
	}
	if (ctx.input.roles) rec.roles = ctx.input.roles.map((r) => r.trim().toLowerCase()).filter(Boolean);
	rec.updatedAt = nowIso();
	await staff(ctx).put(ctx.input.id, rec);
	return { id: ctx.input.id, hasPin: Boolean(rec.pinHash), roles: rec.roles ?? [] };
}

/** The receipt text for an order (admin reprint / preview). */
export async function receiptPreview(ctx: PluginContext, id: string): Promise<string> {
	const s = await loadSettings(ctx);
	const o = await orders(ctx).get(id);
	if (!o) throw PluginRouteError.notFound("Order not found");
	return receiptText(o, s);
}
