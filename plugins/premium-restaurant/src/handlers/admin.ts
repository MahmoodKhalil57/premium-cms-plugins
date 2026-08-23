/**
 * Admin routes: live board, tables (QR cards), staff PINs and roles (CMS
 * users or name-only team members), printers, shifts, reservation sync and
 * kitchen overrides. A minimal Block Kit page for non-PremiumCMS admins.
 */
import { bookingsCall, recentOrders } from "../commerce.js";
import { formatMoney } from "../money.js";
import { reservationServiceId, syncReservations, syncTable, unsyncTable } from "../reservations.js";
import { currentShift, fulfilments, hashPin, isOpenNow, newId, normalizeStaff, normalizeTable, nowIso, printJobs, printers, publicFulfilment, publicTable, saveFulfilment, sendToPrintNode, shifts, staff, tables, tickets } from "../restaurant.js";
import { loadSettings } from "../settings.js";
import { PluginRouteError, type RouteContext } from "../shim.js";
import type { FulfilmentRecord, PrinterRecord } from "../types.js";

/* ---- tables ---------------------------------------------------------------- */

export async function tablesListHandler(ctx: RouteContext) {
	const items = (await tables(ctx).query({ limit: 200 })).items.map((t) => publicTable(t.id, t.data)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	return { items };
}
export async function tableSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const s = await loadSettings(ctx);
	const existing = ctx.input.id ? await tables(ctx).get(ctx.input.id) : null;
	const rec = normalizeTable(ctx.input.record, existing ?? undefined);
	const dup = (await tables(ctx).query({ where: { code: rec.code }, limit: 1 })).items[0];
	let id: string;
	if (dup && dup.id !== ctx.input.id) {
		if (ctx.input.id) throw PluginRouteError.conflict(`Code ${rec.code} is already used by ${dup.data.name}`);
		id = dup.id;
		await tables(ctx).put(id, { ...rec, createdAt: dup.data.createdAt });
	} else {
		id = existing && ctx.input.id ? ctx.input.id : newId();
		await tables(ctx).put(id, rec);
	}
	await syncTable(ctx, s, id, rec).catch((err) => console.error("[restaurant] table sync failed:", err));
	return publicTable(id, rec);
}
export async function tableDeleteHandler(ctx: RouteContext<{ id: string }>) {
	const deleted = await tables(ctx).delete(ctx.input.id);
	await unsyncTable(ctx, ctx.input.id);
	return { deleted };
}

/* ---- staff (PIN holders) ------------------------------------------------------ */

export async function staffListHandler(ctx: RouteContext) {
	const items = (await staff(ctx).query({ limit: 200 })).items.map((m) => ({ id: m.id, ...m.data, pinHash: undefined, hasPin: Boolean(m.data.pinHash) }));
	const users = ctx.users ? (await ctx.users.list({ limit: 100 }).catch(() => ({ items: [] }))).items.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, staffId: items.find((m) => m.userId === u.id)?.id ?? null })) : [];
	return { items, users };
}

/** Create or update a team member. Seeds may carry a plain PIN; only its salted hash is stored. */
export async function staffSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const rec0 = { ...ctx.input.record };
	if (rec0.userId && ctx.users && !rec0.name) {
		const u = await ctx.users.get(String(rec0.userId)).catch(() => null);
		if (u) {
			rec0.name = u.name || u.email;
			rec0.email = rec0.email ?? u.email;
		}
	}
	const all = ctx.input.id ? [] : (await staff(ctx).query({ limit: 200 })).items;
	const match = ctx.input.id ? null : (all.find((m) => rec0.userId && m.data.userId === rec0.userId) ?? all.find((m) => typeof rec0.name === "string" && m.data.name.toLowerCase() === String(rec0.name).trim().toLowerCase()) ?? null);
	const existing = ctx.input.id ? await staff(ctx).get(ctx.input.id) : (match?.data ?? null);
	const rec = normalizeStaff(rec0, existing ?? undefined);
	if (typeof rec0.pin === "string") {
		const clean = rec0.pin.replace(/\D/g, "");
		if (clean === "") rec.pinHash = null;
		else {
			if (clean.length < 4 || clean.length > 8) throw PluginRouteError.badRequest("PIN must be 4–8 digits");
			const hash = await hashPin(ctx, clean);
			const clash = (await staff(ctx).query({ limit: 200 })).items.find((x) => x.id !== (ctx.input.id ?? match?.id) && x.data.pinHash === hash);
			if (clash) throw PluginRouteError.conflict("Another team member already uses that PIN");
			rec.pinHash = hash;
		}
	}
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newId());
	await staff(ctx).put(id, rec);
	return { id, ...rec, pinHash: undefined, hasPin: Boolean(rec.pinHash) };
}
export async function staffDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await staff(ctx).delete(ctx.input.id) };
}

/* ---- printers ------------------------------------------------------------------ */

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
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newId());
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
	const id = newId();
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

/* ---- reservations (mirror in Bookings) ------------------------------------------ */

export async function reservationsSyncHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	const serviceId = await syncReservations(ctx, s);
	return { serviceId, bookingsInstalled: serviceId !== null };
}

/** Today's and upcoming table reservations, read from Bookings (manage them in Plugins → Bookings). */
export async function reservationsListHandler(ctx: RouteContext<{ from?: string; to?: string }>) {
	const s = await loadSettings(ctx);
	const serviceId = await reservationServiceId(ctx, s);
	if (!serviceId) return { items: [], timezone: s.timezone, bookingsInstalled: false };
	const r = await bookingsCall<{ items: unknown[]; timezone: string }>(ctx, "bookings/query", { serviceId, from: ctx.input.from, to: ctx.input.to });
	return { items: r?.items ?? [], timezone: r?.timezone ?? s.timezone, bookingsInstalled: true, serviceId };
}

/* ---- board + overrides -------------------------------------------------------------- */

/** Live board for the admin: open orders by kitchen status + queued prints. */
export async function boardHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	const recent = await recentOrders(ctx, { limit: 150, sinceHours: 36 });
	const fs = await fulfilments(ctx).getMany(recent.map((r) => r.id));
	const withF = recent.map(({ id, order }) => ({ id, o: order, f: fs.get(id) })).filter((x): x is { id: string; o: typeof x.o; f: FulfilmentRecord } => Boolean(x.f));
	const open = withF.filter(({ o, f }) => o.status !== "cancelled" && o.status !== "failed" && o.status !== "pending" && (["new", "preparing", "ready", "served", "out_for_delivery"].includes(f.kitchen) || o.status === "awaiting_payment"));
	const queued = (await printJobs(ctx).query({ where: { status: "queued" }, limit: 100 })).items.length;
	const failed = (await printJobs(ctx).query({ where: { status: "failed" }, limit: 100 })).items.length;
	const today = withF.filter(({ o }) => Date.now() - Date.parse(o.createdAt) < 86_400_000 && o.status !== "cancelled");
	const currency = recent[0]?.order.currency ?? "usd";
	return {
		orders: open.map(({ id, o, f }) => ({ id, number: o.number, status: o.status, total: o.total, totalFormatted: formatMoney(o.total, o.currency), customerName: o.customerName ?? null, createdAt: o.createdAt, fulfilment: publicFulfilment(f, s.timezone), items: o.items.map((it) => `${it.quantity}× ${it.title}`) })),
		prints: { queued, failed },
		today: { orders: today.length, revenue: formatMoney(today.filter(({ o }) => o.status === "paid" || o.status === "fulfilled").reduce((n, { o }) => n + o.total, 0), currency), byMode: Object.fromEntries((["delivery", "pickup", "dine_in", "pos"] as const).map((m) => [m, today.filter(({ f }) => f.mode === m).length])) },
		shift: await currentShift(ctx),
		openNow: isOpenNow(s),
	};
}

/** Admin override of the kitchen state. */
export async function orderStatusHandler(ctx: RouteContext<{ id: string; kitchen: FulfilmentRecord["kitchen"] }>) {
	const f = await fulfilments(ctx).get(ctx.input.id);
	if (!f) throw PluginRouteError.notFound("Order not found");
	f.kitchen = ctx.input.kitchen;
	if (ctx.input.kitchen === "completed" || ctx.input.kitchen === "delivered") f.completedAt = nowIso();
	await saveFulfilment(ctx, ctx.input.id, f);
	if (ctx.input.kitchen === "completed" || ctx.input.kitchen === "delivered" || ctx.input.kitchen === "cancelled") {
		for (const t of (await tickets(ctx).query({ where: { orderId: ctx.input.id }, limit: 20 })).items) {
			if (t.data.status === "served" || t.data.status === "cancelled") continue;
			t.data.status = ctx.input.kitchen === "cancelled" ? "cancelled" : "served";
			t.data.bumpedAt = nowIso();
			await tickets(ctx).put(t.id, t.data);
		}
	}
	return { id: ctx.input.id, kitchen: f.kitchen };
}

/* ---- Block Kit (any EmDash admin) ---------------------------------------------------- */

export async function adminHandler(ctx: RouteContext<{ page?: string }>) {
	const b = await boardHandler(ctx);
	return {
		blocks: [
			{ type: "header", text: "Restaurant" },
			{ type: "stats", items: [{ label: "Open now", value: b.openNow ? "Yes" : "Closed" }, { label: "Orders today", value: b.today.orders }, { label: "Revenue today", value: b.today.revenue }, { label: "Prints queued / failed", value: `${b.prints.queued} / ${b.prints.failed}` }] },
			b.orders.length
				? { type: "table", columns: [{ key: "number", label: "#" }, { key: "mode", label: "Mode" }, { key: "kitchen", label: "Kitchen", format: "badge" }, { key: "items", label: "Items" }, { key: "total", label: "Total" }], rows: b.orders.map((o) => ({ number: String(o.number), mode: `${o.fulfilment?.mode ?? ""}${o.fulfilment?.table ? ` · ${o.fulfilment.table}` : ""}`, kitchen: o.fulfilment?.kitchen ?? "", items: o.items.join(", "), total: o.totalFormatted })) }
				: { type: "context", text: "No open orders. The staff app at /staff runs the floor; the PremiumCMS admin adds tables, printers, staff PINs and shifts." },
		],
	};
}
