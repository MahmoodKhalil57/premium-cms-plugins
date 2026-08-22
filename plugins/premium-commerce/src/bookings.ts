/**
 * Bookings: treatments (services) as bookable products, staff as resources
 * with weekly availability and time off, a slot engine in the site's time
 * zone, and bookings that hold a slot while the shopper pays. Payment and
 * deposits go through the normal checkout: a booking is a line item
 * `booking:<id>`; the order's payment confirms it.
 */

import { ulid } from "ulidx";

import { minorUnits } from "./money.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";

export interface WeeklyRule {
	/** 0 = Sunday … 6 = Saturday */
	dow: number;
	/** "09:00" */
	start: string;
	/** "17:00" */
	end: string;
}
export interface TimeOff {
	start: string;
	end: string;
	reason?: string;
}

export interface ServiceRecord {
	title: string;
	slug: string;
	description?: string;
	/** Minutes. */
	durationMin: number;
	/** Minutes kept free after the appointment. */
	bufferMin: number;
	/** Major units; 0 = free / pay at the practice. */
	price: number;
	depositType: "none" | "fixed" | "percent";
	depositAmount: number;
	/** Staff who perform it (ids); empty = anyone. */
	staffIds: string[];
	/** Forms-plugin form id to fill in while booking (intake). */
	intakeFormId?: string | null;
	/** Maximum simultaneous bookings per slot per staff member (group sessions). */
	capacity: number;
	image?: string;
	active: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface StaffRecord {
	name: string;
	email?: string;
	title?: string;
	bio?: string;
	image?: string;
	availability: WeeklyRule[];
	timeOff: TimeOff[];
	active: boolean;
	/** Restaurant staff app: salted hash of the POS PIN and the roles it unlocks (server, kitchen, manager, driver). */
	pinHash?: string | null;
	roles?: string[];
	createdAt: string;
	updatedAt: string;
}

export type BookingStatus = "held" | "pending_payment" | "confirmed" | "cancelled" | "completed" | "no_show";

export interface BookingRecord {
	serviceId: string;
	serviceTitle: string;
	staffId: string;
	staffName: string;
	startsAt: string;
	endsAt: string;
	status: BookingStatus;
	customer: { name: string; email: string; phone?: string; userId?: string | null };
	/** Major units at the time of booking. */
	price: number;
	deposit: number;
	orderId?: string | null;
	intakeSubmissionId?: string | null;
	notes?: string;
	/** Shopper's token for the confirmation page. */
	accessToken: string;
	/** Held slots expire unless paid/confirmed. */
	holdExpiresAt?: string | null;
	/** Automation markers (reminders sent, recall sent …). */
	flags?: Record<string, string>;
	events: Array<{ at: string; type: string; note?: string }>;
	createdAt: string;
	updatedAt: string;
}

export interface BookingSettings {
	timezone: string;
	slotIntervalMin: number;
	leadTimeHours: number;
	horizonDays: number;
	holdMinutes: number;
	currency: string;
}

export const services = (ctx: PluginContext) => ctx.storage.services as StorageCollection<ServiceRecord>;
export const staff = (ctx: PluginContext) => ctx.storage.staff as StorageCollection<StaffRecord>;
export const bookings = (ctx: PluginContext) => ctx.storage.bookings as StorageCollection<BookingRecord>;

/* ---- time zone helpers (no libraries in the sandbox) ------------------------ */

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
	let f = dtfCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
		dtfCache.set(tz, f);
	}
	return f;
}
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a zone. */
export function zoned(date: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; dow: number; ymd: string } {
	const parts = Object.fromEntries(dtf(tz).formatToParts(date).map((p) => [p.type, p.value]));
	const y = Number(parts.year);
	const m = Number(parts.month);
	const d = Number(parts.day);
	return { y, m, d, hh: Number(parts.hour), mm: Number(parts.minute), dow: DOW[parts.weekday!] ?? 0, ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** The instant for a wall-clock time ("2026-09-01", "09:30") in a zone. */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
	const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
	const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
	// Start from the UTC guess, then correct by the zone offset at that instant (twice for DST edges).
	let guess = Date.UTC(y, m - 1, d, hh, mm);
	for (let i = 0; i < 2; i++) {
		const z = zoned(new Date(guess), tz);
		const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm);
		guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
	}
	return new Date(guess);
}

export function isValidTimeZone(tz: string): boolean {
	try {
		dtf(tz);
		return true;
	} catch {
		return false;
	}
}

/* ---- availability ------------------------------------------------------------- */

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

export interface Slot {
	startsAt: string;
	endsAt: string;
	staffId: string;
	staffName: string;
}

/** Bookings that occupy time: anything not cancelled, and holds that haven't expired. */
export function occupies(b: BookingRecord, now = Date.now()): boolean {
	if (b.status === "cancelled" || b.status === "no_show") return false;
	if (b.status === "held" && b.holdExpiresAt && Date.parse(b.holdExpiresAt) < now) return false;
	return true;
}

export async function bookingsBetween(ctx: PluginContext, startIso: string, endIso: string): Promise<Array<{ id: string; data: BookingRecord }>> {
	// Storage queries are equality-only; scan recent/upcoming bookings ordered by start and filter.
	const out: Array<{ id: string; data: BookingRecord }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 10; page++) {
		const res = await bookings(ctx).query({ orderBy: { startsAt: "desc" }, limit: 100, cursor });
		for (const b of res.items) {
			if (b.data.startsAt >= startIso && b.data.startsAt <= endIso) out.push(b);
		}
		const oldest = res.items[res.items.length - 1]?.data.startsAt;
		if (!res.hasMore || !res.cursor || (oldest && oldest < startIso)) break;
		cursor = res.cursor;
	}
	return out;
}

/**
 * Free slots for a service on a calendar day (in the site zone), per staff
 * member who performs it. Honours weekly rules, time off, existing bookings
 * (with buffers), lead time and the booking horizon.
 */
export async function availableSlots(ctx: PluginContext, settings: BookingSettings, serviceId: string, ymd: string, staffId?: string | null): Promise<{ service: ServiceRecord; slots: Slot[] }> {
	const service = await services(ctx).get(serviceId);
	if (!service || !service.active) throw PluginRouteError.notFound("Treatment not found");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw PluginRouteError.badRequest("Date must be YYYY-MM-DD");
	const tz = settings.timezone;
	const now = Date.now();
	const earliest = now + settings.leadTimeHours * 3_600_000;
	const latest = now + settings.horizonDays * 86_400_000;
	const dayStart = zonedToUtc(ymd, "00:00", tz);
	const dayEnd = new Date(dayStart.getTime() + 36 * 3_600_000);
	const allStaff = await staff(ctx).query({ where: { active: true }, limit: 100 });
	const candidates = allStaff.items.filter((s) => (service.staffIds.length === 0 || service.staffIds.includes(s.id)) && (!staffId || s.id === staffId));
	const existing = (await bookingsBetween(ctx, new Date(dayStart.getTime() - 86_400_000).toISOString(), dayEnd.toISOString())).filter((b) => occupies(b.data, now));
	const dow = zoned(dayStart, tz).dow;
	const step = Math.max(5, settings.slotIntervalMin) * 60_000;
	const need = (service.durationMin + service.bufferMin) * 60_000;
	const slots: Slot[] = [];
	for (const entry of candidates) {
		const member = { id: entry.id, ...entry.data };
		const windows = member.availability.filter((r) => r.dow === dow);
		for (const w of windows) {
			const wStart = zonedToUtc(ymd, w.start, tz).getTime();
			const wEnd = zonedToUtc(ymd, w.end, tz).getTime();
			for (let t = wStart; t + service.durationMin * 60_000 <= wEnd; t += step) {
				const end = t + service.durationMin * 60_000;
				const blockEnd = t + need;
				if (t < earliest || t > latest) continue;
				if (member.timeOff.some((o) => overlaps(t, blockEnd, Date.parse(o.start), Date.parse(o.end)))) continue;
				const clashing = existing.filter((b) => b.data.staffId === member.id && overlaps(t, blockEnd, Date.parse(b.data.startsAt), Date.parse(b.data.endsAt) + 0)).length;
				if (clashing >= Math.max(1, service.capacity)) continue;
				slots.push({ startsAt: new Date(t).toISOString(), endsAt: new Date(end).toISOString(), staffId: member.id, staffName: member.name });
			}
		}
	}
	slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.staffName.localeCompare(b.staffName));
	return { service, slots };
}

/* ---- holds & lifecycle -------------------------------------------------------- */

export function depositFor(service: Pick<ServiceRecord, "price" | "depositType" | "depositAmount">): number {
	if (service.price <= 0 || service.depositType === "none") return 0;
	const dep = service.depositType === "percent" ? (service.price * service.depositAmount) / 100 : service.depositAmount;
	return Math.max(0, Math.min(service.price, Math.round(dep * 100) / 100));
}

export async function holdSlot(ctx: PluginContext, settings: BookingSettings, input: { serviceId: string; staffId?: string | null; startsAt: string; customer: BookingRecord["customer"]; notes?: string; intakeSubmissionId?: string | null }): Promise<{ id: string; booking: BookingRecord }> {
	const service = await services(ctx).get(input.serviceId);
	if (!service || !service.active) throw PluginRouteError.notFound("Treatment not found");
	const start = new Date(input.startsAt);
	if (Number.isNaN(start.getTime())) throw PluginRouteError.badRequest("Invalid start time");
	const ymd = zoned(start, settings.timezone).ymd;
	const { slots } = await availableSlots(ctx, settings, input.serviceId, ymd, input.staffId ?? null);
	const slot = slots.find((s) => s.startsAt === start.toISOString() && (!input.staffId || s.staffId === input.staffId));
	if (!slot) throw PluginRouteError.conflict("That time is no longer available — please pick another slot");
	const now = new Date();
	const price = service.price;
	const deposit = depositFor(service);
	const id = ulid();
	const record: BookingRecord = {
		serviceId: input.serviceId,
		serviceTitle: service.title,
		staffId: slot.staffId,
		staffName: slot.staffName,
		startsAt: slot.startsAt,
		endsAt: slot.endsAt,
		status: price > 0 ? "held" : "confirmed",
		customer: input.customer,
		price,
		deposit,
		intakeSubmissionId: input.intakeSubmissionId ?? null,
		notes: input.notes,
		accessToken: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""),
		holdExpiresAt: price > 0 ? new Date(now.getTime() + settings.holdMinutes * 60_000).toISOString() : null,
		flags: {},
		events: [{ at: now.toISOString(), type: price > 0 ? "held" : "confirmed", note: price > 0 ? `hold ${settings.holdMinutes} min` : "free booking" }],
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
	await bookings(ctx).put(id, record);
	return { id, booking: record };
}

export async function setBookingStatus(ctx: PluginContext, id: string, status: BookingStatus, note?: string, patch: Partial<BookingRecord> = {}): Promise<BookingRecord | null> {
	const b = await bookings(ctx).get(id);
	if (!b) return null;
	b.status = status;
	if (status !== "held") b.holdExpiresAt = null;
	Object.assign(b, patch);
	b.events.push({ at: new Date().toISOString(), type: status, ...(note ? { note } : {}) });
	b.updatedAt = new Date().toISOString();
	await bookings(ctx).put(id, b);
	return b;
}

/** The checkout line for a held booking: full price, or the deposit when the service takes one. */
export function bookingLine(id: string, b: BookingRecord, currency: string, tz: string): { unitAmount: number; title: string; fullAmount: number; depositAmount: number } {
	const when = formatWhen(b.startsAt, tz);
	const full = minorUnits(b.price, currency);
	const dep = b.deposit > 0 ? minorUnits(b.deposit, currency) : 0;
	return { unitAmount: dep > 0 ? dep : full, title: `${b.serviceTitle} — ${when} with ${b.staffName}${dep > 0 ? " (deposit)" : ""}`, fullAmount: full, depositAmount: dep };
}

export function formatWhen(iso: string, tz: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
	} catch {
		return iso;
	}
}

export function publicBooking(id: string, b: BookingRecord, tz: string) {
	return { id, service: b.serviceTitle, staff: b.staffName, startsAt: b.startsAt, endsAt: b.endsAt, when: formatWhen(b.startsAt, tz), status: b.status, price: b.price, deposit: b.deposit, orderId: b.orderId ?? null, customer: { name: b.customer.name, email: b.customer.email }, notes: b.notes ?? null };
}

/** Expire stale holds (cron). */
export async function expireHolds(ctx: PluginContext): Promise<number> {
	const res = await bookings(ctx).query({ where: { status: "held" }, limit: 100 });
	let n = 0;
	for (const b of res.items) {
		if (b.data.holdExpiresAt && Date.parse(b.data.holdExpiresAt) < Date.now()) {
			await setBookingStatus(ctx, b.id, "cancelled", "hold expired");
			n++;
		}
	}
	return n;
}

/* ---- admin normalization --------------------------------------------------- */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export function normalizeService(input: Record<string, unknown>, existing?: ServiceRecord): ServiceRecord {
	const title = String(input.title ?? existing?.title ?? "").trim();
	if (!title) throw PluginRouteError.badRequest("Title is required");
	const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));
	const durationMin = num(input.durationMin, existing?.durationMin ?? 30);
	if (!(durationMin >= 5 && durationMin <= 24 * 60)) throw PluginRouteError.badRequest("Duration must be 5–1440 minutes");
	const depositType = String(input.depositType ?? existing?.depositType ?? "none") as ServiceRecord["depositType"];
	if (!["none", "fixed", "percent"].includes(depositType)) throw PluginRouteError.badRequest("Unknown deposit type");
	const now = new Date().toISOString();
	return {
		title,
		slug: existing?.slug ?? (slugify(String(input.slug ?? title)) || ulid().toLowerCase()),
		description: typeof input.description === "string" ? input.description : existing?.description,
		durationMin,
		bufferMin: Math.max(0, num(input.bufferMin, existing?.bufferMin ?? 0)),
		price: Math.max(0, num(input.price, existing?.price ?? 0)),
		depositType,
		depositAmount: Math.max(0, num(input.depositAmount, existing?.depositAmount ?? 0)),
		staffIds: input.staffIds === undefined ? (existing?.staffIds ?? []) : (Array.isArray(input.staffIds) ? input.staffIds.map(String) : String(input.staffIds).split(/[,\s]+/)).filter(Boolean),
		intakeFormId: input.intakeFormId === undefined ? (existing?.intakeFormId ?? null) : input.intakeFormId ? String(input.intakeFormId) : null,
		capacity: Math.max(1, num(input.capacity, existing?.capacity ?? 1)),
		image: typeof input.image === "string" ? input.image : existing?.image,
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		sortOrder: num(input.sortOrder, existing?.sortOrder ?? 0),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function normalizeStaff(input: Record<string, unknown>, existing?: StaffRecord): StaffRecord {
	const name = String(input.name ?? existing?.name ?? "").trim();
	if (!name) throw PluginRouteError.badRequest("Name is required");
	let availability = existing?.availability ?? [];
	if (input.availability !== undefined) {
		const raw = Array.isArray(input.availability) ? input.availability : [];
		availability = raw
			.map((r) => r as Record<string, unknown>)
			.filter((r) => TIME_RE.test(String(r.start)) && TIME_RE.test(String(r.end)) && String(r.start) < String(r.end))
			.map((r) => ({ dow: Math.max(0, Math.min(6, Number(r.dow))), start: String(r.start), end: String(r.end) }));
	}
	let timeOff = existing?.timeOff ?? [];
	if (input.timeOff !== undefined) {
		const raw = Array.isArray(input.timeOff) ? input.timeOff : [];
		timeOff = raw
			.map((r) => r as Record<string, unknown>)
			.filter((r) => !Number.isNaN(Date.parse(String(r.start))) && !Number.isNaN(Date.parse(String(r.end))))
			.map((r) => ({ start: new Date(String(r.start)).toISOString(), end: new Date(String(r.end)).toISOString(), ...(r.reason ? { reason: String(r.reason) } : {}) }));
	}
	const now = new Date().toISOString();
	return {
		name,
		email: typeof input.email === "string" ? input.email.trim() || undefined : existing?.email,
		title: typeof input.title === "string" ? input.title : existing?.title,
		bio: typeof input.bio === "string" ? input.bio : existing?.bio,
		image: typeof input.image === "string" ? input.image : existing?.image,
		availability,
		timeOff,
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		pinHash: existing?.pinHash ?? null,
		roles: input.roles === undefined ? (existing?.roles ?? []) : (Array.isArray(input.roles) ? input.roles.map(String) : String(input.roles).split(/[,\s]+/)).map((r) => r.trim().toLowerCase()).filter(Boolean),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}
