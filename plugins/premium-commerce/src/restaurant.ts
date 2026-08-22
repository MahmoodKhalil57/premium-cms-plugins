/**
 * Restaurant module: opening hours → order/reservation slots, delivery zones,
 * tables (QR ordering), kitchen tickets + display, print jobs (browser agent
 * or PrintNode), staff PIN sessions, cash-drawer shifts and reservations.
 * Everything hangs off the normal commerce order; `fulfilment` on the order
 * says how it reaches the guest.
 */
import { ulid } from "ulidx";
import { formatMoney } from "./money.js";
import { event, orders, saveOrder } from "./orders.js";
import { staff, type StaffRecord, zoned, zonedToUtc } from "./bookings.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import type { DeliveryZone, Fulfilment, FulfilmentMode, KitchenStatus, Order, OrderItem, Product, StoreSettings } from "./types.js";

/* ---- records ------------------------------------------------------------- */

export interface TableRecord {
	name: string;
	/** Short code printed under the QR (e.g. T12). */
	code: string;
	seats: number;
	zone?: string;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}
export interface TicketItem { title: string; quantity: number; notes?: string; options?: string }
export interface TicketRecord {
	orderId: string;
	orderNumber: number;
	station: string;
	items: TicketItem[];
	status: "new" | "preparing" | "ready" | "served" | "cancelled";
	mode: FulfilmentMode;
	table?: string | null;
	customer?: string | null;
	dueAt?: string | null;
	note?: string;
	createdAt: string;
	startedAt?: string | null;
	readyAt?: string | null;
	bumpedAt?: string | null;
}
export interface PrinterRecord {
	name: string;
	/** `agent` = the staff app's printer page prints through the browser; `printnode` = cloud printing. */
	target: "agent" | "printnode";
	printnodePrinterId?: number | null;
	/** Which stations' tickets land here (empty = all). */
	stations: string[];
	/** Job kinds: kitchen (tickets) and/or receipt. */
	kinds: Array<"kitchen" | "receipt">;
	/** Characters per line for the plain-text layout. */
	width: number;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}
export interface PrintJobRecord {
	printerId: string;
	kind: "kitchen" | "receipt";
	orderId: string | null;
	orderNumber: number | null;
	title: string;
	/** Plain text (monospace, `width` columns) — what thermal printers and the browser agent print. */
	text: string;
	status: "queued" | "sent" | "printed" | "failed";
	attempts: number;
	error?: string | null;
	providerRef?: string | null;
	createdAt: string;
	printedAt?: string | null;
}
export interface ShiftMovement { at: string; kind: "pay_in" | "pay_out" | "sale" | "refund"; amount: number; note?: string; orderId?: string }
export interface ShiftRecord {
	staffId: string;
	staffName: string;
	status: "open" | "closed";
	float: number;
	cashSales: number;
	cardSales: number;
	movements: ShiftMovement[];
	orderCount: number;
	expectedCash: number;
	countedCash?: number | null;
	difference?: number | null;
	openedAt: string;
	closedAt?: string | null;
	note?: string;
}
export interface ReservationRecord {
	name: string;
	email: string;
	phone?: string;
	partySize: number;
	at: string;
	endAt: string;
	tableId: string | null;
	tableName: string | null;
	status: "confirmed" | "seated" | "completed" | "cancelled" | "no_show";
	notes?: string;
	accessToken: string;
	source: "online" | "pos";
	createdAt: string;
	updatedAt: string;
}

export const tables = (ctx: PluginContext) => ctx.storage.tables as StorageCollection<TableRecord>;
export const tickets = (ctx: PluginContext) => ctx.storage.tickets as StorageCollection<TicketRecord>;
export const printers = (ctx: PluginContext) => ctx.storage.printers as StorageCollection<PrinterRecord>;
export const printJobs = (ctx: PluginContext) => ctx.storage.printJobs as StorageCollection<PrintJobRecord>;
export const shifts = (ctx: PluginContext) => ctx.storage.shifts as StorageCollection<ShiftRecord>;
export const reservations = (ctx: PluginContext) => ctx.storage.reservations as StorageCollection<ReservationRecord>;

const nowIso = () => new Date().toISOString();
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

export function isOpenNow(settings: StoreSettings, at = new Date()): boolean {
	const z = zoned(at, settings.bookingTimezone);
	const mins = z.hh * 60 + z.mm;
	return windowsFor(parseHours(settings.openingHours), z.dow).some((w) => mins >= w.start && mins < w.end);
}

export interface Slot { at: string; label: string; full?: boolean }

/** Order slots for a local date: every interval inside opening windows, after lead time, throttled per slot when configured. */
export async function orderSlots(ctx: PluginContext, settings: StoreSettings, mode: FulfilmentMode, ymd: string): Promise<{ date: string; open: boolean; asap: Slot | null; slots: Slot[] }> {
	const tz = settings.bookingTimezone;
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
	const recent = await orders(ctx).query({ orderBy: { createdAt: "desc" }, limit: 300 });
	const end = dayStart.getTime() + 36 * 3_600_000;
	for (const { data: o } of recent.items) {
		const at = o.fulfilment?.at;
		if (!at || o.status === "cancelled" || o.status === "failed") continue;
		const t = Date.parse(at);
		if (t >= dayStart.getTime() && t < end) out.set(at, (out.get(at) ?? 0) + 1);
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

export interface StaffSession { staffId: string; name: string; roles: string[]; expiresAt: string }

export async function staffLogin(ctx: PluginContext, pin: string): Promise<{ token: string; session: StaffSession }> {
	const clean = pin.replace(/\D/g, "");
	if (clean.length < 4) throw PluginRouteError.badRequest("Enter your PIN");
	const hash = await hashPin(ctx, clean);
	const all = await staff(ctx).query({ limit: 200 });
	const hit = all.items.find((m) => m.data.active && (m.data as StaffRecord & { pinHash?: string }).pinHash === hash);
	if (!hit) throw PluginRouteError.forbidden("Wrong PIN");
	const token = ulid() + ulid().toLowerCase();
	const session: StaffSession = { staffId: hit.id, name: hit.data.name, roles: (hit.data as StaffRecord & { roles?: string[] }).roles ?? ["server"], expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
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

/* ---- kitchen tickets ----------------------------------------------------- */

function ticketItems(items: OrderItem[]): TicketItem[] {
	return items.map((it) => ({
		title: it.title,
		quantity: it.quantity,
		options: it.optionsDisplay?.map((o) => `${o.label}: ${o.value}`).join(", ") || undefined,
	}));
}

/** One ticket per kitchen station present in the order (products carry `station`; default first station). */
export async function createTickets(ctx: PluginContext, settings: StoreSettings, id: string, order: Order, products: Map<string, Product>): Promise<Array<{ id: string; data: TicketRecord }>> {
	const f = order.fulfilment;
	if (!f) return [];
	const existing = await tickets(ctx).query({ where: { orderId: id }, limit: 20 });
	if (existing.items.length) return existing.items.map((t) => ({ id: t.id, data: t.data }));
	const byStation = new Map<string, OrderItem[]>();
	const fallback = settings.kdsStations[0] ?? "kitchen";
	for (const it of order.items) {
		if (it.productId.startsWith("booking:") || it.productId.startsWith("balance:") || it.productId.startsWith("reservation:")) continue;
		const st = products.get(it.productId)?.station?.trim().toLowerCase() || fallback;
		byStation.set(st, [...(byStation.get(st) ?? []), it]);
	}
	const ids: Array<{ id: string; data: TicketRecord }> = [];
	for (const [station, items] of byStation) {
		const tid = ulid();
		const rec: TicketRecord = {
			orderId: id,
			orderNumber: order.number,
			station,
			items: ticketItems(items),
			status: "new",
			mode: f.mode,
			table: f.table?.name ?? null,
			customer: order.customerName ?? null,
			dueAt: f.at,
			note: order.note,
			createdAt: nowIso(),
		};
		await tickets(ctx).put(tid, rec);
		ids.push({ id: tid, data: rec });
	}
	return ids;
}

const KITCHEN_FLOW: Record<TicketRecord["status"], KitchenStatus> = { new: "new", preparing: "preparing", ready: "ready", served: "served", cancelled: "cancelled" };

/** After a ticket changes, roll the order's kitchen status up from its tickets. */
export async function syncOrderKitchen(ctx: PluginContext, orderId: string): Promise<void> {
	const o = await orders(ctx).get(orderId);
	if (!o?.fulfilment) return;
	const ts = (await tickets(ctx).query({ where: { orderId }, limit: 20 })).items.map((t) => t.data).filter((t) => t.status !== "cancelled");
	if (!ts.length) return;
	const rank = (s: TicketRecord["status"]) => ["new", "preparing", "ready", "served"].indexOf(s);
	const lowest = ts.reduce((m, t) => Math.min(m, rank(t.status)), 3);
	const next = KITCHEN_FLOW[(["new", "preparing", "ready", "served"] as const)[lowest]!];
	if (["out_for_delivery", "delivered", "completed", "cancelled"].includes(o.fulfilment.kitchen)) return;
	if (o.fulfilment.kitchen !== next) {
		o.fulfilment.kitchen = next;
		if (next === "ready") o.fulfilment.readyAt = nowIso();
		if (next === "served") o.fulfilment.completedAt = nowIso();
		o.events.push(event("kitchen", next));
		o.updatedAt = nowIso();
		await saveOrder(ctx, orderId, o);
	}
}

/* ---- receipts + print jobs ------------------------------------------------ */

const pad = (l: string, r: string, w: number) => {
	const space = Math.max(1, w - l.length - r.length);
	return l.length + r.length >= w ? `${l}\n${" ".repeat(Math.max(0, w - r.length))}${r}` : `${l}${" ".repeat(space)}${r}`;
};
const center = (s: string, w: number) => {
	const left = Math.max(0, Math.floor((w - s.length) / 2));
	return " ".repeat(left) + s;
};
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

function fulfilmentLines(f: Fulfilment, tz: string, w: number): string[] {
	const when = f.at ? formatLocal(f.at, tz) : "ASAP";
	const mode = f.mode === "dine_in" ? `DINE-IN${f.table ? ` · ${f.table.name}` : ""}` : f.mode === "delivery" ? "DELIVERY" : f.mode === "pickup" ? "PICKUP" : "POS";
	return [center(`** ${mode} **`, w), center(when, w)];
}

export function formatLocal(iso: string, tz: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
	} catch {
		return iso;
	}
}

export function kitchenTicketText(t: TicketRecord, order: Order, settings: StoreSettings, width = 32): string {
	const w = width;
	const lines = [
		center(`#${t.orderNumber} · ${t.station.toUpperCase()}`, w),
		...fulfilmentLines(order.fulfilment!, settings.bookingTimezone, w),
		"-".repeat(w),
		...t.items.flatMap((it) => [`${it.quantity} x ${it.title}`.slice(0, w), ...(it.options ? wrap(`   ${it.options}`, w) : []), ...(it.notes ? wrap(`   ! ${it.notes}`, w) : [])]),
		"-".repeat(w),
		...(order.note ? ["NOTE:", ...wrap(order.note, w)] : []),
		order.customerName ? `Guest: ${order.customerName}`.slice(0, w) : "",
		formatLocal(t.createdAt, settings.bookingTimezone),
	];
	return lines.join("\n") + "\n\n\n";
}

export function receiptText(order: Order, settings: StoreSettings, width = 32): string {
	const w = width;
	const money = (n: number) => formatMoney(n, order.currency);
	const f = order.fulfilment;
	const lines: string[] = [
		center(settings.storeName || "Receipt", w),
		...(settings.receiptHeader ? settings.receiptHeader.split("\n").map((l) => center(l.trim(), w)) : []),
		"",
		pad(`Order #${order.number}`, formatLocal(order.createdAt, settings.bookingTimezone), w),
		...(f ? fulfilmentLines(f, settings.bookingTimezone, w) : []),
		order.customerName ? `Guest: ${order.customerName}`.slice(0, w) : "",
		"-".repeat(w),
		...order.items.flatMap((it) => [pad(`${it.quantity} x ${it.title}`.slice(0, w - 9), money(it.unitAmount * it.quantity), w), ...(it.optionsDisplay?.length ? wrap(`   ${it.optionsDisplay.map((o) => o.value).join(", ")}`, w) : [])]),
		"-".repeat(w),
		pad("Subtotal", money(order.subtotal), w),
		...(order.discount ? [pad("Discount", `-${money(order.discount)}`, w)] : []),
		...(f?.deliveryFee ? [pad("Delivery", money(f.deliveryFee), w)] : []),
		...(f?.serviceCharge ? [pad(`Service ${settings.serviceChargePct}%`, money(f.serviceCharge), w)] : []),
		...(f?.tip ? [pad("Tip", money(f.tip), w)] : []),
		...(order.tax ? [pad("Tax", money(order.tax), w)] : []),
		pad("TOTAL", money(order.total), w),
		...(f?.paidVia === "cash" && f.tendered !== undefined ? [pad("Cash", money(f.tendered), w), pad("Change", money(f.change ?? 0), w)] : []),
		pad("Paid", f?.paidVia === "unpaid" || order.status === "awaiting_payment" ? "NOT YET" : f?.paidVia === "cash" ? "cash" : f?.paidVia === "card_terminal" ? "card" : order.paymentMethod === "manual" ? "pay later" : "online", w),
		"",
		...(settings.receiptFooter ? wrap(settings.receiptFooter, w).map((l) => center(l, w)) : []),
	];
	return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n\n\n";
}

/** Queue kitchen tickets and a receipt on every matching active printer; PrintNode jobs are pushed immediately. */
export async function queuePrintJobs(ctx: PluginContext, settings: StoreSettings, id: string, order: Order, ts: Array<{ id: string; data: TicketRecord | null }>, kinds: Array<"kitchen" | "receipt"> = ["kitchen", "receipt"]): Promise<number> {
	const active = (await printers(ctx).query({ where: { active: true }, limit: 50 })).items;
	if (!active.length) return 0;
	let n = 0;
	for (const { id: pid, data: p } of active) {
		if (kinds.includes("kitchen") && p.kinds.includes("kitchen")) {
			for (const t of ts) {
				if (!t.data) continue;
				if (p.stations.length && !p.stations.includes(t.data.station)) continue;
				await enqueue(ctx, settings, pid, p, { kind: "kitchen", orderId: id, orderNumber: order.number, title: `#${order.number} ${t.data.station}`, text: kitchenTicketText(t.data, order, settings, p.width) });
				n++;
			}
		}
		if (kinds.includes("receipt") && p.kinds.includes("receipt")) {
			await enqueue(ctx, settings, pid, p, { kind: "receipt", orderId: id, orderNumber: order.number, title: `#${order.number} receipt`, text: receiptText(order, settings, p.width) });
			n++;
		}
	}
	return n;
}

async function enqueue(ctx: PluginContext, settings: StoreSettings, printerId: string, printer: PrinterRecord, job: Pick<PrintJobRecord, "kind" | "orderId" | "orderNumber" | "title" | "text">): Promise<string> {
	const id = ulid();
	const rec: PrintJobRecord = { printerId, ...job, status: "queued", attempts: 0, createdAt: nowIso() };
	await printJobs(ctx).put(id, rec);
	if (printer.target === "printnode" && settings.printnodeApiKey && printer.printnodePrinterId) await sendToPrintNode(ctx, settings, id, rec, printer).catch(() => undefined);
	return id;
}

/** PrintNode raw job: plain text + ESC/POS cut, base64. */
export async function sendToPrintNode(ctx: PluginContext, settings: StoreSettings, id: string, job: PrintJobRecord, printer: PrinterRecord): Promise<void> {
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

/* ---- order placed / paid hooks -------------------------------------------- */

/** Called once an order is committed (paid online, pay-later placed, or rung up at the POS): tickets + prints. */
export async function onRestaurantOrderCommitted(ctx: PluginContext, settings: StoreSettings, id: string, order: Order, products: Map<string, Product>): Promise<void> {
	if (!order.fulfilment) return;
	const created = await createTickets(ctx, settings, id, order, products);
	await queuePrintJobs(ctx, settings, id, order, created).catch((err) => console.error("[restaurant] print queue failed:", err));
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

/* ---- reservations --------------------------------------------------------- */

/** Times a party can be seated: opening windows minus turn time, against tables with enough seats that are free. */
export async function reservationAvailability(ctx: PluginContext, settings: StoreSettings, ymd: string, party: number): Promise<{ date: string; slots: Array<{ at: string; label: string; tableId: string }> }> {
	const tz = settings.bookingTimezone;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw PluginRouteError.badRequest("date must be YYYY-MM-DD");
	if (party < 1 || party > settings.maxPartySize) throw PluginRouteError.badRequest(`Parties of ${settings.maxPartySize} or fewer can book online`);
	const dayStart = zonedToUtc(ymd, "00:00", tz);
	const dow = zoned(new Date(dayStart.getTime() + 12 * 3_600_000), tz).dow;
	const windows = windowsFor(parseHours(settings.openingHours), dow);
	const turn = Math.max(30, settings.turnTimeMin) * 60_000;
	const earliest = Date.now() + settings.reservationLeadMin * 60_000;
	const all = (await tables(ctx).query({ limit: 200 })).items.filter((t) => t.data.active && t.data.seats >= party).sort((a, b) => a.data.seats - b.data.seats);
	const dayEnd = dayStart.getTime() + 36 * 3_600_000;
	const booked = (await reservations(ctx).query({ orderBy: { at: "asc" }, limit: 500 })).items.filter((r) => r.data.status !== "cancelled" && r.data.status !== "no_show" && Date.parse(r.data.at) < dayEnd && Date.parse(r.data.endAt) > dayStart.getTime());
	const slots: Array<{ at: string; label: string; tableId: string }> = [];
	const step = 30 * 60_000;
	for (const w of windows) {
		for (let t = dayStart.getTime() + w.start * 60_000; t + turn <= dayStart.getTime() + w.end * 60_000; t += step) {
			if (t < earliest) continue;
			const end = t + turn;
			const table = all.find((tb) => !booked.some((r) => r.data.tableId === tb.id && Date.parse(r.data.at) < end && Date.parse(r.data.endAt) > t));
			if (!table) continue;
			const z = zoned(new Date(t), tz);
			slots.push({ at: new Date(t).toISOString(), label: `${String(z.hh).padStart(2, "0")}:${String(z.mm).padStart(2, "0")}`, tableId: table.id });
		}
	}
	return { date: ymd, slots };
}

export async function createReservation(ctx: PluginContext, settings: StoreSettings, input: { name: string; email: string; phone?: string; partySize: number; at: string; notes?: string; source?: "online" | "pos" }): Promise<{ id: string; reservation: ReservationRecord }> {
	const at = new Date(input.at);
	if (Number.isNaN(at.getTime())) throw PluginRouteError.badRequest("Pick a time");
	const ymd = zoned(at, settings.bookingTimezone).ymd;
	const avail = await reservationAvailability(ctx, settings, ymd, input.partySize);
	const slot = avail.slots.find((s) => s.at === at.toISOString());
	if (!slot) throw PluginRouteError.conflict("That time is no longer available — please pick another");
	const table = await tables(ctx).get(slot.tableId);
	const id = ulid();
	const rec: ReservationRecord = {
		name: input.name.trim(),
		email: input.email.trim().toLowerCase(),
		phone: input.phone?.trim() || undefined,
		partySize: input.partySize,
		at: at.toISOString(),
		endAt: new Date(at.getTime() + Math.max(30, settings.turnTimeMin) * 60_000).toISOString(),
		tableId: slot.tableId,
		tableName: table?.name ?? null,
		status: "confirmed",
		notes: input.notes?.trim() || undefined,
		accessToken: ulid().toLowerCase() + ulid().toLowerCase(),
		source: input.source ?? "online",
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	await reservations(ctx).put(id, rec);
	if (ctx.email && rec.email) {
		const when = formatLocal(rec.at, settings.bookingTimezone);
		await ctx.email.send({ to: rec.email, subject: `Table for ${rec.partySize} at ${settings.storeName || "the restaurant"} — ${when}`, text: `Hi ${rec.name.split(" ")[0]},\n\nYour table for ${rec.partySize} is booked for ${when}.\n\nNeed to change it? Reply to this email or cancel here: ${siteUrlOf(ctx)}/reserve?reservation=${id}&token=${rec.accessToken}\n\nSee you soon!` }).catch(() => undefined);
		if (settings.notifyEmail) await ctx.email.send({ to: settings.notifyEmail, subject: `[reservation] ${rec.name} · ${rec.partySize} · ${when}`, text: `${rec.name} (${rec.email}${rec.phone ? `, ${rec.phone}` : ""}) booked ${rec.tableName ?? "a table"} for ${rec.partySize} at ${when}.${rec.notes ? `\n\nNotes: ${rec.notes}` : ""}` }).catch(() => undefined);
	}
	return { id, reservation: rec };
}

export function publicReservation(id: string, r: ReservationRecord, settings: StoreSettings) {
	return { id, name: r.name, email: r.email, partySize: r.partySize, at: r.at, when: formatLocal(r.at, settings.bookingTimezone), table: r.tableName, status: r.status, notes: r.notes ?? null };
}

function siteUrlOf(ctx: PluginContext): string {
	try {
		return new URL((ctx as { request?: Request }).request?.url ?? "").origin;
	} catch {
		return "";
	}
}

/* ---- public shapes --------------------------------------------------------- */

export function publicFulfilment(f: Fulfilment | null | undefined, tz: string) {
	if (!f) return null;
	return { mode: f.mode, at: f.at, when: f.at ? formatLocal(f.at, tz) : "ASAP", table: f.table?.name ?? null, zone: f.zone?.name ?? null, deliveryFee: f.deliveryFee, serviceCharge: f.serviceCharge, tip: f.tip, payLater: f.payLater, kitchen: f.kitchen, paidVia: f.paidVia ?? null, driverName: f.driverName ?? null, readyAt: f.readyAt ?? null };
}

export function publicTable(id: string, t: TableRecord) {
	return { id, name: t.name, code: t.code, seats: t.seats, zone: t.zone ?? null, active: t.active };
}
