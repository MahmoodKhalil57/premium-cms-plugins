/**
 * Restaurant core: opening hours → order slots, delivery zones, tables,
 * fulfilment records, kitchen tickets, receipts + print jobs, staff PIN
 * sessions and cash-drawer shifts.
 */
import { ulid } from "ulidx";

import { menuProducts } from "./commerce.js";
import { formatMoney } from "./money.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import { zoned, zonedToUtc } from "./time.js";
import type { CommerceItem, CommerceOrder, DeliveryZone, FulfilmentMode, FulfilmentRecord, KitchenStatus, OrderMeta, PrinterRecord, PrintJobRecord, RestaurantSettings, ShiftMovement, ShiftRecord, StaffRecord, TableRecord, TicketItem, TicketRecord } from "./types.js";

export const tables = (ctx: PluginContext) => ctx.storage.tables as StorageCollection<TableRecord>;
export const tickets = (ctx: PluginContext) => ctx.storage.tickets as StorageCollection<TicketRecord>;
export const printers = (ctx: PluginContext) => ctx.storage.printers as StorageCollection<PrinterRecord>;
export const printJobs = (ctx: PluginContext) => ctx.storage.printJobs as StorageCollection<PrintJobRecord>;
export const shifts = (ctx: PluginContext) => ctx.storage.shifts as StorageCollection<ShiftRecord>;
export const staff = (ctx: PluginContext) => ctx.storage.staff as StorageCollection<StaffRecord>;
export const fulfilments = (ctx: PluginContext) => ctx.storage.fulfilments as StorageCollection<FulfilmentRecord>;

export const nowIso = () => new Date().toISOString();
export const newId = () => ulid();
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) && v !== "" && v !== null && v !== undefined ? Number(v) : d);

/* ---- opening hours ------------------------------------------------------- */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export interface HoursRule { dow: number; start: string; end: string }

/** "mon-thu 11:30-22:00; fri-sat 11:30-23:30; sun 12:00-21:00" → rules per weekday (0 = Sunday). */
export function parseHours(text: string): HoursRule[] {
	const out: HoursRule[] = [];
	for (const raw of text.split(/[;\n]+/)) {
		const part = raw.trim().toLowerCase();
		if (!part) continue;
		const m = /^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(.+)$/.exec(part);
		if (!m) continue;
		const a = DAYS.indexOf(m[1]!);
		const b = m[2] ? DAYS.indexOf(m[2]) : a;
		if (a < 0 || b < 0) continue;
		const days: number[] = [];
		for (let d = a; ; d = (d + 1) % 7) {
			days.push(d);
			if (d === b) break;
			if (days.length > 7) break;
		}
		for (const range of m[3]!.split(/[,&]+/)) {
			const r = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(range.trim());
			if (!r) continue;
			for (const dow of days) out.push({ dow, start: r[1]!.padStart(5, "0"), end: r[2]!.padStart(5, "0") });
		}
	}
	return out;
}

const hm = (t: string) => {
	const [h, m] = t.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
};

/** Local-time windows (minutes from midnight) the venue is open on a given local date. */
export function windowsFor(rules: HoursRule[], dow: number): Array<{ start: number; end: number }> {
	return rules.filter((r) => r.dow === dow).map((r) => ({ start: hm(r.start), end: hm(r.end) <= hm(r.start) ? 24 * 60 : hm(r.end) })).sort((a, b) => a.start - b.start);
}

export function isOpenNow(settings: RestaurantSettings, at = new Date()): boolean {
	const z = zoned(at, settings.timezone);
	const mins = z.hh * 60 + z.mm;
	return windowsFor(parseHours(settings.openingHours), z.dow).some((w) => mins >= w.start && mins < w.end);
}

export interface Slot { at: string; label: string; full?: boolean }

/** Order slots for a local date: every interval inside opening windows, after lead time, throttled per slot when configured. */
export async function orderSlots(ctx: PluginContext, settings: RestaurantSettings, mode: FulfilmentMode, ymd: string): Promise<{ date: string; open: boolean; asap: Slot | null; slots: Slot[] }> {
	const tz = settings.timezone;
	const rules = parseHours(settings.openingHours);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw PluginRouteError.badRequest("date must be YYYY-MM-DD");
	const dayStart = zonedToUtc(ymd, "00:00", tz);
	const dow = zoned(new Date(dayStart.getTime() + 12 * 3_600_000), tz).dow;
	const windows = windowsFor(rules, dow);
	const lead = (mode === "delivery" ? settings.prepTimeMin + 20 : mode === "pickup" ? settings.pickupLeadMin : settings.prepTimeMin) * 60_000;
	const earliest = Date.now() + lead;
	const step = Math.max(5, settings.orderSlotIntervalMin) * 60_000;
	const counts = settings.maxOrdersPerSlot > 0 ? await slotCounts(ctx, dayStart) : new Map<string, number>();
	const slots: Slot[] = [];
	for (const w of windows) {
		for (let t = dayStart.getTime() + w.start * 60_000; t < dayStart.getTime() + w.end * 60_000; t += step) {
			if (t < earliest) continue;
			const at = new Date(t).toISOString();
			const z = zoned(new Date(t), tz);
			const label = `${String(z.hh).padStart(2, "0")}:${String(z.mm).padStart(2, "0")}`;
			const full = settings.maxOrdersPerSlot > 0 && (counts.get(at) ?? 0) >= settings.maxOrdersPerSlot;
			slots.push({ at, label, ...(full ? { full: true } : {}) });
		}
	}
	const openNow = isOpenNow(settings);
	const asap = openNow ? { at: new Date(earliest).toISOString(), label: `ASAP (~${Math.round(lead / 60_000)} min)` } : null;
	return { date: ymd, open: windows.length > 0, asap, slots };
}

async function slotCounts(ctx: PluginContext, dayStart: Date): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	const recent = await fulfilments(ctx).query({ orderBy: { createdAt: "desc" }, limit: 300 });
	const end = dayStart.getTime() + 36 * 3_600_000;
	for (const { data: f } of recent.items) {
		if (!f.at || f.kitchen === "cancelled") continue;
		const t = Date.parse(f.at);
		if (t >= dayStart.getTime() && t < end) out.set(f.at, (out.get(f.at) ?? 0) + 1);
	}
	return out;
}

/* ---- delivery zones ------------------------------------------------------ */

export function matchZone(zones: DeliveryZone[], postcode: string): DeliveryZone | null {
	const pc = postcode.toUpperCase().replace(/\s+/g, "");
	if (!pc) return null;
	let best: { zone: DeliveryZone; len: number } | null = null;
	for (const z of zones) {
		for (const prefix of z.postcodes) {
			if (prefix === "*" ? true : pc.startsWith(prefix)) {
				const len = prefix === "*" ? 0 : prefix.length;
				if (!best || len > best.len) best = { zone: z, len };
			}
		}
	}
	return best?.zone ?? null;
}

/* ---- tables -------------------------------------------------------------- */

export function normalizeTable(input: Record<string, unknown>, existing?: TableRecord): TableRecord {
	const name = String(input.name ?? existing?.name ?? "").trim();
	if (!name) throw PluginRouteError.badRequest("Table name is required");
	const code = String(input.code ?? existing?.code ?? name).trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "");
	if (!code) throw PluginRouteError.badRequest("Table code is required");
	const now = nowIso();
	return {
		name,
		code,
		seats: Math.max(1, Math.floor(num(input.seats, existing?.seats ?? 2))),
		zone: typeof input.zone === "string" ? input.zone.trim() || undefined : existing?.zone,
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

export async function tableByCode(ctx: PluginContext, code: string): Promise<{ id: string; data: TableRecord } | null> {
	const c = code.trim().toUpperCase();
	if (!c) return null;
	const r = await tables(ctx).query({ where: { code: c }, limit: 1 });
	const hit = r.items[0];
	return hit && hit.data.active ? hit : null;
}

export function publicTable(id: string, t: TableRecord) {
	return { id, name: t.name, code: t.code, seats: t.seats, zone: t.zone ?? null, active: t.active };
}

/* ---- staff PIN sessions -------------------------------------------------- */

const SESSION_TTL_MS = 14 * 3_600_000;

async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function siteSalt(ctx: PluginContext): Promise<string> {
	let salt = await ctx.kv.get<string>("staff:salt");
	if (!salt) {
		salt = ulid() + ulid();
		await ctx.kv.set("staff:salt", salt);
	}
	return salt;
}

export async function hashPin(ctx: PluginContext, pin: string): Promise<string> {
	return sha256Hex(`${await siteSalt(ctx)}:${pin}`);
}

export interface StaffSession { staffId: string; userId: string | null; name: string; roles: string[]; expiresAt: string }

export async function staffLogin(ctx: PluginContext, pin: string): Promise<{ token: string; session: StaffSession }> {
	const clean = pin.replace(/\D/g, "");
	if (clean.length < 4) throw PluginRouteError.badRequest("Enter your PIN");
	const hash = await hashPin(ctx, clean);
	const all = await staff(ctx).query({ limit: 200 });
	const hit = all.items.find((m) => m.data.active && m.data.pinHash === hash);
	if (!hit) throw PluginRouteError.forbidden("Wrong PIN");
	const token = ulid() + ulid().toLowerCase();
	const session: StaffSession = { staffId: hit.id, userId: hit.data.userId ?? null, name: hit.data.name, roles: hit.data.roles.length ? hit.data.roles : ["server"], expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
	await ctx.kv.set(`staffsess:${await sha256Hex(token)}`, session);
	return { token, session };
}

export async function staffLogout(ctx: PluginContext, token: string): Promise<void> {
	await ctx.kv.delete(`staffsess:${await sha256Hex(token)}`);
}

/** The sandbox hands routes a plain request snapshot (headers as an object) or a real Request. */
export function headerValue(request: unknown, name: string): string {
	const h = (request as { headers?: unknown } | undefined)?.headers;
	if (!h) return "";
	if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? "";
	const o = h as Record<string, string>;
	return o[name] ?? o[name.toLowerCase()] ?? "";
}

/** Resolves the staff session from the `X-Staff-Token` header (or `staffToken` in the body); throws when missing. */
export async function requireStaff(ctx: PluginContext & { request?: Request; input?: unknown }, role?: string): Promise<StaffSession> {
	const token = headerValue(ctx.request, "x-staff-token") || ((ctx.input as { staffToken?: string } | undefined)?.staffToken ?? "");
	if (!token) throw PluginRouteError.forbidden("Staff sign-in required");
	const session = await ctx.kv.get<StaffSession>(`staffsess:${await sha256Hex(token)}`);
	if (!session || Date.parse(session.expiresAt) < Date.now()) throw PluginRouteError.forbidden("Staff session expired — sign in again");
	if (role && !session.roles.includes(role) && !session.roles.includes("manager")) throw PluginRouteError.forbidden(`This needs the ${role} role`);
	return session;
}

export function normalizeStaff(input: Record<string, unknown>, existing?: StaffRecord): StaffRecord {
	const name = String(input.name ?? existing?.name ?? "").trim();
	if (!name) throw PluginRouteError.badRequest("Name is required");
	const now = nowIso();
	return {
		userId: input.userId === undefined ? (existing?.userId ?? null) : input.userId ? String(input.userId) : null,
		name,
		email: typeof input.email === "string" ? input.email.trim().toLowerCase() || undefined : existing?.email,
		title: typeof input.title === "string" ? input.title : existing?.title,
		roles: input.roles === undefined ? (existing?.roles ?? ["server"]) : (Array.isArray(input.roles) ? input.roles.map(String) : String(input.roles).split(/[,\s]+/)).map((r) => r.trim().toLowerCase()).filter(Boolean),
		pinHash: existing?.pinHash ?? null,
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

/* ---- fulfilment records --------------------------------------------------- */

export function metaOf(order: CommerceOrder): OrderMeta | null {
	const m = order.extensions?.["premium-restaurant"] as OrderMeta | undefined;
	return m && typeof m === "object" && m.mode ? m : null;
}

/** Make (or refresh) the fulfilment record for a Commerce order that carries our meta. */
export async function upsertFulfilment(ctx: PluginContext, id: string, order: CommerceOrder): Promise<FulfilmentRecord | null> {
	const meta = metaOf(order);
	if (!meta) return null;
	const existing = await fulfilments(ctx).get(id);
	const adj = (key: string) => (order.adjustments ?? []).filter((a) => a.provider === "premium-restaurant" && a.key === key).reduce((n, a) => n + a.amount, 0);
	const rec: FulfilmentRecord = {
		orderId: id,
		orderNumber: order.number,
		mode: meta.mode,
		at: meta.at ?? null,
		tableId: meta.tableId ?? null,
		tableName: meta.table ?? null,
		zoneId: meta.zoneId ?? null,
		zoneName: meta.zone ?? null,
		deliveryFee: adj("delivery"),
		serviceCharge: adj("service"),
		tip: adj("tip"),
		payLater: order.status === "awaiting_payment",
		kitchen: existing?.kitchen ?? "new",
		orderStatus: order.status,
		paidVia: order.status === "paid" || order.status === "fulfilled" ? (order.offline ? (order.offline.method === "cash" ? "cash" : "card_terminal") : "online") : "unpaid",
		customerName: order.customerName ?? existing?.customerName ?? null,
		phone: order.phone ?? null,
		note: order.note ?? null,
		driverId: existing?.driverId ?? null,
		driverName: existing?.driverName ?? null,
		staffId: meta.staffId ?? existing?.staffId ?? null,
		staffName: meta.staffName ?? existing?.staffName ?? null,
		shiftId: meta.shiftId ?? existing?.shiftId ?? null,
		ticketsCreated: existing?.ticketsCreated ?? false,
		receiptPrinted: existing?.receiptPrinted ?? false,
		readyAt: existing?.readyAt ?? null,
		completedAt: existing?.completedAt ?? null,
		createdAt: existing?.createdAt ?? order.createdAt ?? nowIso(),
		updatedAt: nowIso(),
	};
	if (order.status === "cancelled" && rec.kitchen !== "cancelled") rec.kitchen = "cancelled";
	await fulfilments(ctx).put(id, rec);
	return rec;
}

export async function saveFulfilment(ctx: PluginContext, id: string, f: FulfilmentRecord): Promise<void> {
	f.updatedAt = nowIso();
	await fulfilments(ctx).put(id, f);
}

/* ---- kitchen tickets ----------------------------------------------------- */

function ticketItems(items: CommerceItem[]): TicketItem[] {
	return items.map((it) => ({
		title: it.title,
		quantity: it.quantity,
		options: it.optionsDisplay?.filter((o) => o.name !== "notes").map((o) => `${o.label}: ${o.value}`).join(", ") || undefined,
		notes: it.optionsDisplay?.find((o) => o.name === "notes")?.value || undefined,
	}));
}

/** One ticket per kitchen station present in the order (products carry `station`; default first station). */
export async function createTickets(ctx: PluginContext, settings: RestaurantSettings, id: string, order: CommerceOrder, f: FulfilmentRecord): Promise<Array<{ id: string; data: TicketRecord }>> {
	const existing = await tickets(ctx).query({ where: { orderId: id }, limit: 20 });
	if (existing.items.length) return existing.items.map((t) => ({ id: t.id, data: t.data }));
	const { products } = await menuProducts(ctx);
	const stationOf = new Map(products.map((p) => [p.id, p.station?.trim().toLowerCase() || ""]));
	const byStation = new Map<string, CommerceItem[]>();
	const fallback = settings.kdsStations[0] ?? "kitchen";
	for (const it of order.items) {
		if (it.provider) continue;
		const st = stationOf.get(it.productId) || fallback;
		byStation.set(st, [...(byStation.get(st) ?? []), it]);
	}
	const ids: Array<{ id: string; data: TicketRecord }> = [];
	for (const [station, items] of byStation) {
		const tid = ulid();
		const rec: TicketRecord = { orderId: id, orderNumber: order.number, station, items: ticketItems(items), status: "new", mode: f.mode, table: f.tableName ?? null, customer: order.customerName ?? null, dueAt: f.at, note: order.note, createdAt: nowIso() };
		await tickets(ctx).put(tid, rec);
		ids.push({ id: tid, data: rec });
	}
	return ids;
}

const KITCHEN_FLOW: Record<TicketRecord["status"], KitchenStatus> = { new: "new", preparing: "preparing", ready: "ready", served: "served", cancelled: "cancelled" };

/** After a ticket changes, roll the order's kitchen status up from its tickets. */
export async function syncOrderKitchen(ctx: PluginContext, orderId: string): Promise<void> {
	const f = await fulfilments(ctx).get(orderId);
	if (!f) return;
	const ts = (await tickets(ctx).query({ where: { orderId }, limit: 20 })).items.map((t) => t.data).filter((t) => t.status !== "cancelled");
	if (!ts.length) return;
	const rank = (s: TicketRecord["status"]) => ["new", "preparing", "ready", "served"].indexOf(s);
	const lowest = ts.reduce((m, t) => Math.min(m, rank(t.status)), 3);
	const next = KITCHEN_FLOW[(["new", "preparing", "ready", "served"] as const)[lowest]!];
	if (["out_for_delivery", "delivered", "completed", "cancelled"].includes(f.kitchen)) return;
	if (f.kitchen !== next) {
		f.kitchen = next;
		if (next === "ready") f.readyAt = nowIso();
		if (next === "served") f.completedAt = nowIso();
		await saveFulfilment(ctx, orderId, f);
	}
}

/* ---- receipts + print jobs ------------------------------------------------ */

const pad = (l: string, r: string, w: number) => {
	const space = Math.max(1, w - l.length - r.length);
	return l.length + r.length >= w ? `${l}\n${" ".repeat(Math.max(0, w - r.length))}${r}` : `${l}${" ".repeat(space)}${r}`;
};
const center = (s: string, w: number) => " ".repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;
const wrap = (s: string, w: number): string[] => {
	const words = s.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		if ((cur + " " + word).trim().length > w) {
			if (cur) lines.push(cur);
			cur = word;
		} else cur = (cur + " " + word).trim();
	}
	if (cur) lines.push(cur);
	return lines;
};

export function formatLocal(iso: string, tz: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
	} catch {
		return iso;
	}
}

function fulfilmentLines(f: FulfilmentRecord, tz: string, w: number): string[] {
	const when = f.at ? formatLocal(f.at, tz) : "ASAP";
	const mode = f.mode === "dine_in" ? `DINE-IN${f.tableName ? ` · ${f.tableName}` : ""}` : f.mode === "delivery" ? "DELIVERY" : f.mode === "pickup" ? "PICKUP" : "POS";
	return [center(`** ${mode} **`, w), center(when, w)];
}

export function kitchenTicketText(t: TicketRecord, f: FulfilmentRecord, settings: RestaurantSettings, width = 32): string {
	const w = width;
	const lines = [
		center(`#${t.orderNumber} · ${t.station.toUpperCase()}`, w),
		...fulfilmentLines(f, settings.timezone, w),
		"-".repeat(w),
		...t.items.flatMap((it) => [`${it.quantity} x ${it.title}`.slice(0, w), ...(it.options ? wrap(`   ${it.options}`, w) : []), ...(it.notes ? wrap(`   ! ${it.notes}`, w) : [])]),
		"-".repeat(w),
		...(t.note ? ["NOTE:", ...wrap(t.note, w)] : []),
		t.customer ? `Guest: ${t.customer}`.slice(0, w) : "",
		formatLocal(t.createdAt, settings.timezone),
	];
	return lines.join("\n") + "\n\n\n";
}

export function receiptText(order: CommerceOrder, f: FulfilmentRecord | null, settings: RestaurantSettings, width = 32): string {
	const w = width;
	const money = (n: number) => formatMoney(n, order.currency);
	const lines: string[] = [
		center(settings.storeName || "Receipt", w),
		...(settings.receiptHeader ? settings.receiptHeader.split("\n").map((l) => center(l.trim(), w)) : []),
		"",
		pad(`Order #${order.number}`, formatLocal(order.createdAt, settings.timezone), w),
		...(f ? fulfilmentLines(f, settings.timezone, w) : []),
		order.customerName ? `Guest: ${order.customerName}`.slice(0, w) : "",
		"-".repeat(w),
		...order.items.flatMap((it) => [pad(`${it.quantity} x ${it.title}`.slice(0, w - 9), money(it.unitAmount * it.quantity), w), ...(it.optionsDisplay?.length ? wrap(`   ${it.optionsDisplay.map((o) => o.value).join(", ")}`, w) : [])]),
		"-".repeat(w),
		pad("Subtotal", money(order.subtotal), w),
		...(order.discount ? [pad("Discount", `-${money(order.discount)}`, w)] : []),
		...(order.adjustments ?? []).filter((a) => a.amount).map((a) => pad(a.label.slice(0, w - 10), money(a.amount), w)),
		...(order.tax ? [pad("Tax", money(order.tax), w)] : []),
		pad("TOTAL", money(order.total), w),
		...(order.offline?.method === "cash" && order.offline.tendered !== undefined ? [pad("Cash", money(order.offline.tendered), w), pad("Change", money(order.offline.change ?? 0), w)] : []),
		pad("Paid", order.status === "awaiting_payment" || order.status === "pending" ? "NOT YET" : order.offline ? order.offline.method.replace("_", " ") : "online", w),
		"",
		...(settings.receiptFooter ? wrap(settings.receiptFooter, w).map((l) => center(l, w)) : []),
	];
	return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n\n\n";
}

/** Queue kitchen tickets and/or a receipt on every matching active printer; PrintNode jobs are pushed immediately. */
export async function queuePrintJobs(ctx: PluginContext, settings: RestaurantSettings, id: string, order: CommerceOrder, f: FulfilmentRecord, ts: Array<{ id: string; data: TicketRecord | null }>, kinds: Array<"kitchen" | "receipt"> = ["kitchen", "receipt"]): Promise<number> {
	const active = (await printers(ctx).query({ where: { active: true }, limit: 50 })).items;
	if (!active.length) return 0;
	let n = 0;
	for (const { id: pid, data: p } of active) {
		if (kinds.includes("kitchen") && p.kinds.includes("kitchen")) {
			for (const t of ts) {
				if (!t.data) continue;
				if (p.stations.length && !p.stations.includes(t.data.station)) continue;
				await enqueue(ctx, settings, pid, p, { kind: "kitchen", orderId: id, orderNumber: order.number, title: `#${order.number} ${t.data.station}`, text: kitchenTicketText(t.data, f, settings, p.width) });
				n++;
			}
		}
		if (kinds.includes("receipt") && p.kinds.includes("receipt")) {
			await enqueue(ctx, settings, pid, p, { kind: "receipt", orderId: id, orderNumber: order.number, title: `#${order.number} receipt`, text: receiptText(order, f, settings, p.width) });
			n++;
		}
	}
	return n;
}

async function enqueue(ctx: PluginContext, settings: RestaurantSettings, printerId: string, printer: PrinterRecord, job: Pick<PrintJobRecord, "kind" | "orderId" | "orderNumber" | "title" | "text">): Promise<string> {
	const id = ulid();
	const rec: PrintJobRecord = { printerId, ...job, status: "queued", attempts: 0, createdAt: nowIso() };
	await printJobs(ctx).put(id, rec);
	if (printer.target === "printnode" && settings.printnodeApiKey && printer.printnodePrinterId) await sendToPrintNode(ctx, settings, id, rec, printer).catch(() => undefined);
	return id;
}

/** PrintNode raw job: plain text + ESC/POS cut, base64. */
export async function sendToPrintNode(ctx: PluginContext, settings: RestaurantSettings, id: string, job: PrintJobRecord, printer: PrinterRecord): Promise<void> {
	if (!ctx.http) return;
	const content = btoa(unescape(encodeURIComponent(`${job.text}\n\n\n\x1dV\x00`)));
	const res = await ctx.http.fetch("https://api.printnode.com/printjobs", {
		method: "POST",
		headers: { Authorization: `Basic ${btoa(`${settings.printnodeApiKey}:`)}`, "Content-Type": "application/json" },
		body: JSON.stringify({ printerId: printer.printnodePrinterId, title: job.title, contentType: "raw_base64", content, source: "PremiumCMS" }),
	});
	const text = await res.text();
	job.attempts++;
	if (res.ok) {
		job.status = "sent";
		job.providerRef = text.replace(/\D/g, "") || null;
	} else {
		job.status = "failed";
		job.error = `PrintNode ${res.status}: ${text.slice(0, 200)}`;
	}
	await printJobs(ctx).put(id, job);
}

/** Once an order is committed (paid online, pay-later placed, or rung up at the POS): tickets + prints, exactly once. */
export async function onOrderCommitted(ctx: PluginContext, settings: RestaurantSettings, id: string, order: CommerceOrder, f: FulfilmentRecord): Promise<void> {
	if (f.ticketsCreated) return;
	const created = await createTickets(ctx, settings, id, order, f);
	await queuePrintJobs(ctx, settings, id, order, f, created, order.status === "paid" ? ["kitchen", "receipt"] : ["kitchen"]).catch((err) => console.error("[restaurant] print queue failed:", err));
	f.ticketsCreated = true;
	f.receiptPrinted = order.status === "paid";
	await saveFulfilment(ctx, id, f);
}

/* ---- cash drawer shifts --------------------------------------------------- */

export async function openShift(ctx: PluginContext, session: StaffSession, float: number, note?: string): Promise<{ id: string; shift: ShiftRecord }> {
	const open = await currentShift(ctx);
	if (open) throw PluginRouteError.conflict(`A drawer is already open (${open.shift.staffName} since ${open.shift.openedAt})`);
	const id = ulid();
	const shift: ShiftRecord = { staffId: session.staffId, staffName: session.name, status: "open", float: Math.max(0, float), cashSales: 0, cardSales: 0, movements: [], orderCount: 0, expectedCash: Math.max(0, float), openedAt: nowIso(), note };
	await shifts(ctx).put(id, shift);
	return { id, shift };
}

export async function currentShift(ctx: PluginContext): Promise<{ id: string; shift: ShiftRecord } | null> {
	const r = await shifts(ctx).query({ where: { status: "open" }, limit: 1 });
	const hit = r.items[0];
	return hit ? { id: hit.id, shift: hit.data } : null;
}

export async function recordShiftMovement(ctx: PluginContext, kind: ShiftMovement["kind"], amount: number, note?: string, orderId?: string): Promise<void> {
	const cur = await currentShift(ctx);
	if (!cur) return;
	cur.shift.movements.push({ at: nowIso(), kind, amount, note, orderId });
	if (kind === "sale") {
		cur.shift.cashSales += amount;
		cur.shift.orderCount++;
	}
	if (kind === "refund") cur.shift.cashSales -= amount;
	cur.shift.expectedCash = cur.shift.float + cur.shift.cashSales + cur.shift.movements.filter((m) => m.kind === "pay_in").reduce((n, m) => n + m.amount, 0) - cur.shift.movements.filter((m) => m.kind === "pay_out").reduce((n, m) => n + m.amount, 0);
	await shifts(ctx).put(cur.id, cur.shift);
}

export async function recordCardSale(ctx: PluginContext, amount: number): Promise<void> {
	const cur = await currentShift(ctx);
	if (!cur) return;
	cur.shift.cardSales += amount;
	cur.shift.orderCount++;
	await shifts(ctx).put(cur.id, cur.shift);
}

export async function closeShift(ctx: PluginContext, counted: number, note?: string): Promise<{ id: string; shift: ShiftRecord }> {
	const cur = await currentShift(ctx);
	if (!cur) throw PluginRouteError.badRequest("No drawer is open");
	cur.shift.status = "closed";
	cur.shift.countedCash = counted;
	cur.shift.difference = counted - cur.shift.expectedCash;
	cur.shift.closedAt = nowIso();
	if (note) cur.shift.note = note;
	await shifts(ctx).put(cur.id, cur.shift);
	return cur;
}

/* ---- public shapes --------------------------------------------------------- */

export function publicFulfilment(f: FulfilmentRecord | null | undefined, tz: string) {
	if (!f) return null;
	return { mode: f.mode, at: f.at, when: f.at ? formatLocal(f.at, tz) : "ASAP", table: f.tableName ?? null, zone: f.zoneName ?? null, deliveryFee: f.deliveryFee, serviceCharge: f.serviceCharge, tip: f.tip, payLater: f.payLater, kitchen: f.kitchen, paidVia: f.paidVia ?? null, driverName: f.driverName ?? null, readyAt: f.readyAt ?? null };
}
