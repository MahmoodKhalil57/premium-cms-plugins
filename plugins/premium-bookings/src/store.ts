/** Storage accessors, record normalisation and public projections. */

import { ulid } from "ulidx";

import { minorUnits } from "./money.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import { formatWhen, TIME_RE } from "./time.js";
import type { BookingRecord, BookingStatus, ResourceKind, ResourceRecord, ServiceRecord, WeeklyRule } from "./types.js";

export const services = (ctx: PluginContext) => ctx.storage.services as StorageCollection<ServiceRecord>;
export const resources = (ctx: PluginContext) => ctx.storage.resources as StorageCollection<ResourceRecord>;
export const bookings = (ctx: PluginContext) => ctx.storage.bookings as StorageCollection<BookingRecord>;

export const newId = () => ulid();
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v: unknown, d: boolean) => (v === undefined || v === null || v === "" ? d : v === true || v === "true");
const list = (v: unknown, d: string[]) => (v === undefined ? d : (Array.isArray(v) ? v.map(String) : String(v).split(/[,\s]+/)).map((x) => x.trim()).filter(Boolean));

/* ---- services ------------------------------------------------------------- */

export function depositFor(service: Pick<ServiceRecord, "price" | "depositType" | "depositAmount">): number {
	if (service.price <= 0 || service.depositType === "none") return 0;
	const dep = service.depositType === "percent" ? (service.price * service.depositAmount) / 100 : service.depositAmount;
	return Math.max(0, Math.min(service.price, Math.round(dep * 100) / 100));
}

export function normalizeService(input: Record<string, unknown>, existing?: ServiceRecord): ServiceRecord {
	const title = String(input.title ?? existing?.title ?? "").trim();
	if (!title) throw PluginRouteError.badRequest("Title is required");
	const durationMin = num(input.durationMin, existing?.durationMin ?? 30);
	if (!(durationMin >= 5 && durationMin <= 24 * 60)) throw PluginRouteError.badRequest("Duration must be 5–1440 minutes");
	const depositType = String(input.depositType ?? existing?.depositType ?? "none") as ServiceRecord["depositType"];
	if (!["none", "fixed", "percent"].includes(depositType)) throw PluginRouteError.badRequest("Unknown deposit type");
	const kind = String(input.kind ?? existing?.kind ?? "appointment") as ServiceRecord["kind"];
	if (kind !== "appointment" && kind !== "reservation") throw PluginRouteError.badRequest("Unknown service kind");
	const resourceKind = String(input.resourceKind ?? existing?.resourceKind ?? (kind === "reservation" ? "asset" : "staff")) as ResourceKind;
	if (resourceKind !== "staff" && resourceKind !== "asset") throw PluginRouteError.badRequest("Unknown resource kind");
	const now = new Date().toISOString();
	// Older records / seeds use `staffIds`; keep accepting it.
	const resourceIds = input.resourceIds !== undefined ? list(input.resourceIds, []) : input.staffIds !== undefined ? list(input.staffIds, []) : (existing?.resourceIds ?? []);
	return {
		title,
		slug: existing?.slug ?? (slugify(String(input.slug ?? title)) || ulid().toLowerCase()),
		kind,
		description: typeof input.description === "string" ? input.description : existing?.description,
		durationMin,
		bufferMin: Math.max(0, num(input.bufferMin, existing?.bufferMin ?? 0)),
		price: Math.max(0, num(input.price, existing?.price ?? 0)),
		depositType,
		depositAmount: Math.max(0, num(input.depositAmount, existing?.depositAmount ?? 0)),
		resourceIds,
		resourceKind,
		intakeFormId: input.intakeFormId === undefined ? (existing?.intakeFormId ?? null) : input.intakeFormId ? String(input.intakeFormId) : null,
		capacity: Math.max(1, num(input.capacity, existing?.capacity ?? 1)),
		minPartySize: Math.max(1, num(input.minPartySize, existing?.minPartySize ?? 1)),
		maxPartySize: Math.max(1, num(input.maxPartySize, existing?.maxPartySize ?? (kind === "reservation" ? 8 : 1))),
		slotIntervalMin: input.slotIntervalMin === undefined ? (existing?.slotIntervalMin ?? null) : input.slotIntervalMin === null || input.slotIntervalMin === "" ? null : Math.max(5, num(input.slotIntervalMin, 15)),
		leadTimeMin: input.leadTimeMin === undefined ? (existing?.leadTimeMin ?? null) : input.leadTimeMin === null || input.leadTimeMin === "" ? null : Math.max(0, num(input.leadTimeMin, 0)),
		image: typeof input.image === "string" ? input.image : existing?.image,
		active: bool(input.active, existing?.active ?? true),
		sortOrder: num(input.sortOrder, existing?.sortOrder ?? 0),
		managedBy: input.managedBy === undefined ? (existing?.managedBy ?? null) : input.managedBy ? String(input.managedBy) : null,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

export function publicService(id: string, s: ServiceRecord, resourceNames: Map<string, string>, currency: string) {
	const ids = s.resourceIds.length ? s.resourceIds : [...resourceNames.keys()];
	const pick = s.resourceKind === "staff" ? ids.map((rid) => ({ id: rid, name: resourceNames.get(rid) ?? "" })).filter((x) => x.name) : [];
	return {
		id,
		slug: s.slug,
		title: s.title,
		kind: s.kind,
		description: s.description ?? "",
		durationMin: s.durationMin,
		price: s.price,
		priceMinor: minorUnits(s.price, currency),
		deposit: depositFor(s),
		depositType: s.depositType,
		intakeFormId: s.intakeFormId ?? null,
		image: s.image ?? null,
		minPartySize: s.minPartySize,
		maxPartySize: s.maxPartySize,
		resourceKind: s.resourceKind,
		/** Who the customer may pick (staff only; assets are assigned automatically). */
		resources: pick,
		/** Alias kept for storefronts written against the old commerce bookings. */
		staff: pick,
	};
}

/* ---- resources ------------------------------------------------------------- */

export function normalizeRules(raw: unknown): WeeklyRule[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((r) => r as Record<string, unknown>)
		.filter((r) => TIME_RE.test(String(r.start)) && TIME_RE.test(String(r.end)) && String(r.start) < String(r.end))
		.map((r) => ({ dow: Math.max(0, Math.min(6, Number(r.dow))), start: String(r.start), end: String(r.end) }));
}

export function normalizeResource(input: Record<string, unknown>, existing?: ResourceRecord): ResourceRecord {
	const name = String(input.name ?? existing?.name ?? "").trim();
	if (!name) throw PluginRouteError.badRequest("Name is required");
	const kind = String(input.kind ?? existing?.kind ?? (input.userId ? "staff" : "asset")) as ResourceKind;
	if (kind !== "staff" && kind !== "asset") throw PluginRouteError.badRequest("Unknown resource kind");
	let availability = existing?.availability ?? [];
	if (input.availability !== undefined) availability = normalizeRules(input.availability);
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
		kind,
		name,
		userId: input.userId === undefined ? (existing?.userId ?? null) : input.userId ? String(input.userId) : null,
		email: typeof input.email === "string" ? input.email.trim().toLowerCase() || undefined : existing?.email,
		title: typeof input.title === "string" ? input.title : existing?.title,
		bio: typeof input.bio === "string" ? input.bio : existing?.bio,
		image: typeof input.image === "string" ? input.image : existing?.image,
		capacity: kind === "staff" ? 1 : Math.max(1, Math.floor(num(input.capacity ?? input.seats, existing?.capacity ?? 1))),
		availability,
		timeOff,
		tags: list(input.tags, existing?.tags ?? []),
		externalId: input.externalId === undefined ? (existing?.externalId ?? null) : input.externalId ? String(input.externalId) : null,
		managedBy: input.managedBy === undefined ? (existing?.managedBy ?? null) : input.managedBy ? String(input.managedBy) : null,
		active: bool(input.active, existing?.active ?? true),
		sortOrder: num(input.sortOrder, existing?.sortOrder ?? 0),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

export function publicResource(id: string, r: ResourceRecord) {
	return { id, kind: r.kind, name: r.name, userId: r.userId ?? null, email: r.email ?? null, title: r.title ?? null, bio: r.bio ?? null, image: r.image ?? null, capacity: r.capacity, availability: r.availability, timeOff: r.timeOff, tags: r.tags, externalId: r.externalId ?? null, managedBy: r.managedBy ?? null, active: r.active, sortOrder: r.sortOrder, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

/** Seeds and imports send records without ids; match an existing row so re-runs update instead of duplicating. */
export async function findByKey<T>(col: StorageCollection<T>, key: string, value: unknown): Promise<{ id: string; data: T } | null> {
	if (typeof value !== "string" || !value) return null;
	const all = await col.query({ limit: 500 });
	return all.items.find((i) => String((i.data as Record<string, unknown>)[key] ?? "").toLowerCase() === value.toLowerCase()) ?? null;
}

/* ---- bookings --------------------------------------------------------------- */

/** Bookings that occupy time: anything not cancelled, and holds that haven't expired. */
export function occupies(b: BookingRecord, now = Date.now()): boolean {
	if (b.status === "cancelled" || b.status === "no_show") return false;
	if (b.status === "held" && b.holdExpiresAt && Date.parse(b.holdExpiresAt) < now) return false;
	return true;
}

export async function bookingsBetween(ctx: PluginContext, startIso: string, endIso: string): Promise<Array<{ id: string; data: BookingRecord }>> {
	// Storage queries are equality-only; scan bookings ordered by start and filter.
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

export function publicBooking(id: string, b: BookingRecord, tz: string) {
	return {
		id,
		service: b.serviceTitle,
		serviceId: b.serviceId,
		kind: b.serviceKind,
		resource: b.resourceName,
		resourceId: b.resourceId,
		/** Alias kept for older storefronts. */
		staff: b.resourceName,
		startsAt: b.startsAt,
		endsAt: b.endsAt,
		when: formatWhen(b.startsAt, tz),
		status: b.status,
		partySize: b.partySize ?? null,
		price: b.price,
		deposit: b.deposit,
		orderId: b.orderId ?? null,
		orderNumber: b.orderNumber ?? null,
		customer: { name: b.customer.name, email: b.customer.email, phone: b.customer.phone ?? null },
		notes: b.notes ?? null,
	};
}

export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
