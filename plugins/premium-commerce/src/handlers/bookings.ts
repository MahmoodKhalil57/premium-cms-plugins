/**
 * Booking routes: the storefront picker (services → day → slot → hold),
 * the shopper's appointments, and the practice's admin (calendar list,
 * status changes, services, staff, automations).
 */

import { type AutomationRecord, automations, newAutomationId, normalizeAutomation, runAutomations, TRIGGERS } from "../automations.js";
import { availableSlots, type BookingRecord, bookings, bookingsBetween, depositFor, holdSlot, normalizeService, normalizeStaff, publicBooking, type ServiceRecord, services, setBookingStatus, staff, type StaffRecord, zoned, zonedToUtc } from "../bookings.js";
import { loadSettings } from "../settings.js";
import type { PluginContext, RouteContext } from "../shim.js";
import { hashPin } from "../restaurant.js";
import { PluginRouteError } from "../shim.js";
import type { StoreSettings } from "../types.js";
import { ulid } from "ulidx";

const bookingSettings = (s: StoreSettings) => ({ timezone: s.bookingTimezone, slotIntervalMin: s.slotIntervalMin, leadTimeHours: s.leadTimeHours, horizonDays: s.horizonDays, holdMinutes: s.holdMinutes, currency: s.currency });

function publicService(id: string, s: ServiceRecord, staffNames: Map<string, string>) {
	return { id, slug: s.slug, title: s.title, description: s.description ?? "", durationMin: s.durationMin, price: s.price, deposit: depositFor(s), depositType: s.depositType, intakeFormId: s.intakeFormId ?? null, image: s.image ?? null, staff: (s.staffIds.length ? s.staffIds : [...staffNames.keys()]).map((sid) => ({ id: sid, name: staffNames.get(sid) ?? "" })).filter((x) => x.name) };
}

async function staffNames(ctx: PluginContext): Promise<Map<string, string>> {
	const res = await staff(ctx).query({ where: { active: true }, limit: 100 });
	return new Map(res.items.map((s) => [s.id, s.data.name]));
}

/* ---- public ---------------------------------------------------------------- */

export async function servicesHandler(ctx: RouteContext) {
	const settings = await loadSettings(ctx);
	const [res, names] = await Promise.all([services(ctx).query({ where: { active: true }, limit: 100 }), staffNames(ctx)]);
	const items = res.items.sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.title.localeCompare(b.data.title)).map((s) => publicService(s.id, s.data, names));
	return { currency: settings.currency, timezone: settings.bookingTimezone, horizonDays: settings.horizonDays, services: items };
}

export async function availabilityHandler(ctx: RouteContext<{ serviceId: string; date: string; staffId?: string }>) {
	const settings = await loadSettings(ctx);
	const { service, slots } = await availableSlots(ctx, bookingSettings(settings), ctx.input.serviceId, ctx.input.date, ctx.input.staffId ?? null);
	return { date: ctx.input.date, timezone: settings.bookingTimezone, durationMin: service.durationMin, slots };
}

/** Days in the next N that have at least one slot (calendar dots). Cheap: one availability pass per day. */
export async function availableDaysHandler(ctx: RouteContext<{ serviceId: string; days?: number }>) {
	const settings = await loadSettings(ctx);
	const days = Math.min(62, Math.max(7, Number(ctx.input.days) || 31));
	const out: string[] = [];
	const tz = settings.bookingTimezone;
	for (let i = 0; i < days; i++) {
		const ymd = zoned(new Date(Date.now() + i * 86_400_000), tz).ymd;
		const { slots } = await availableSlots(ctx, bookingSettings(settings), ctx.input.serviceId, ymd).catch(() => ({ slots: [] as unknown[] }));
		if (slots.length) out.push(ymd);
	}
	return { days: out };
}

export async function holdHandler(ctx: RouteContext<{ serviceId: string; staffId?: string; startsAt: string; customer: { name: string; email: string; phone?: string }; notes?: string; intakeSubmissionId?: string }>) {
	const settings = await loadSettings(ctx);
	const { id, booking } = await holdSlot(ctx, bookingSettings(settings), { serviceId: ctx.input.serviceId, staffId: ctx.input.staffId ?? null, startsAt: ctx.input.startsAt, customer: { ...ctx.input.customer, userId: ctx.user?.id ?? null }, notes: ctx.input.notes, intakeSubmissionId: ctx.input.intakeSubmissionId ?? null });
	return { booking: publicBooking(id, booking, settings.bookingTimezone), token: booking.accessToken, holdExpiresAt: booking.holdExpiresAt, checkoutItem: booking.price > 0 ? { productId: `booking:${id}`, quantity: 1 } : null };
}

export async function bookingLookupHandler(ctx: RouteContext<{ id: string; token?: string }>) {
	const settings = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.id);
	if (!b) throw PluginRouteError.notFound("Booking not found");
	const mine = ctx.user && b.customer.userId === ctx.user.id;
	if (!mine && (!ctx.input.token || ctx.input.token !== b.accessToken)) throw PluginRouteError.forbidden("Booking not found");
	return { booking: publicBooking(ctx.input.id, b, settings.bookingTimezone) };
}

export async function bookingCancelHandler(ctx: RouteContext<{ id: string; token?: string }>) {
	const settings = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.id);
	if (!b) throw PluginRouteError.notFound("Booking not found");
	const mine = ctx.user && b.customer.userId === ctx.user.id;
	if (!mine && (!ctx.input.token || ctx.input.token !== b.accessToken)) throw PluginRouteError.forbidden("Booking not found");
	if (Date.parse(b.startsAt) - Date.now() < settings.leadTimeHours * 3_600_000) throw PluginRouteError.badRequest("This appointment can no longer be cancelled online — please contact the practice");
	const updated = await setBookingStatus(ctx, ctx.input.id, "cancelled", "cancelled by customer");
	return { booking: publicBooking(ctx.input.id, updated!, settings.bookingTimezone) };
}

export async function accountBookingsHandler(ctx: RouteContext) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in to continue");
	const settings = await loadSettings(ctx);
	const res = await bookings(ctx).query({ orderBy: { startsAt: "desc" }, limit: 200 });
	const mine = res.items.filter((b) => b.data.customer.userId === ctx.user!.id || b.data.customer.email.toLowerCase() === ctx.user!.email.toLowerCase());
	return { bookings: mine.map((b) => publicBooking(b.id, b.data, settings.bookingTimezone)) };
}

/* ---- admin ------------------------------------------------------------------ */

export async function bookingsListHandler(ctx: RouteContext<{ from?: string; to?: string; status?: string; limit: number }>) {
	const settings = await loadSettings(ctx);
	const from = ctx.input.from ? new Date(ctx.input.from).toISOString() : new Date(Date.now() - 86_400_000).toISOString();
	const to = ctx.input.to ? new Date(ctx.input.to).toISOString() : new Date(Date.now() + 30 * 86_400_000).toISOString();
	const items = (await bookingsBetween(ctx, from, to)).filter((b) => !ctx.input.status || b.data.status === ctx.input.status).sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt)).slice(0, ctx.input.limit);
	return { timezone: settings.bookingTimezone, items: items.map((b) => ({ id: b.id, ...b.data })) };
}

export async function bookingUpdateHandler(ctx: RouteContext<{ id: string; status?: "confirmed" | "cancelled" | "completed" | "no_show"; startsAt?: string; staffId?: string; notes?: string }>) {
	const settings = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.id);
	if (!b) throw PluginRouteError.notFound("Booking not found");
	const patch: Partial<BookingRecord> = {};
	if (ctx.input.notes !== undefined) patch.notes = ctx.input.notes;
	if (ctx.input.startsAt || ctx.input.staffId) {
		// Reschedule: re-check availability for the new slot (ignoring this booking itself is not needed — it checks other staff bookings).
		const start = new Date(ctx.input.startsAt ?? b.startsAt);
		const ymd = zoned(start, settings.bookingTimezone).ymd;
		const { service, slots } = await availableSlots(ctx, bookingSettings(settings), b.serviceId, ymd, ctx.input.staffId ?? b.staffId);
		const slot = slots.find((s) => s.startsAt === start.toISOString());
		if (!slot && ctx.input.startsAt) throw PluginRouteError.conflict("That slot is not available");
		if (slot) {
			patch.startsAt = slot.startsAt;
			patch.endsAt = slot.endsAt;
			patch.staffId = slot.staffId;
			patch.staffName = slot.staffName;
		}
		void service;
	}
	const status = ctx.input.status ?? b.status;
	const updated = await setBookingStatus(ctx, ctx.input.id, status, ctx.input.status ? "by staff" : "rescheduled", patch);
	return { id: ctx.input.id, ...updated! };
}

export async function servicesListHandler(ctx: RouteContext) {
	const res = await services(ctx).query({ limit: 200 });
	return { items: res.items.sort((a, b) => a.data.sortOrder - b.data.sortOrder).map((s) => ({ id: s.id, ...s.data, deposit: depositFor(s.data) })) };
}
/** Seeds and imports send records without ids; match an existing row by slug (or name) so re-runs update instead of duplicating. */
async function findByKey<T extends Record<string, unknown>>(col: { query(o: { limit: number }): Promise<{ items: Array<{ id: string; data: T }> }> }, key: "slug" | "name" | "title", value: unknown): Promise<{ id: string; data: T } | null> {
	if (typeof value !== "string" || !value) return null;
	const all = await col.query({ limit: 500 });
	return all.items.find((i) => String(i.data[key] ?? "").toLowerCase() === value.toLowerCase()) ?? null;
}

export async function serviceSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const match = ctx.input.id ? null : await findByKey(services(ctx) as never, "slug", ctx.input.record.slug);
	const existing = ctx.input.id ? await services(ctx).get(ctx.input.id) : ((match?.data as ServiceRecord | undefined) ?? null);
	const rec = normalizeService(ctx.input.record, existing ?? undefined);
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? ulid());
	await services(ctx).put(id, rec);
	return { id, ...rec };
}
export async function serviceDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await services(ctx).delete(ctx.input.id) };
}

export async function staffListHandler(ctx: RouteContext) {
	const res = await staff(ctx).query({ limit: 200 });
	return { items: res.items.map((s) => ({ id: s.id, ...s.data, pinHash: undefined, hasPin: Boolean(s.data.pinHash) })) };
}
export async function staffSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const match = ctx.input.id ? null : await findByKey(staff(ctx) as never, "name", ctx.input.record.name);
	const existing = ctx.input.id ? await staff(ctx).get(ctx.input.id) : ((match?.data as StaffRecord | undefined) ?? null);
	const rec = normalizeStaff(ctx.input.record, existing ?? undefined);
	// Seeds and imports may carry a plain PIN; only its salted hash is stored.
	if (typeof ctx.input.record.pin === "string" && ctx.input.record.pin.replace(/\D/g, "").length >= 4) rec.pinHash = await hashPin(ctx, ctx.input.record.pin.replace(/\D/g, ""));
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? ulid());
	await staff(ctx).put(id, rec);
	return { id, ...rec, pinHash: undefined, hasPin: Boolean(rec.pinHash) };
}
export async function staffDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await staff(ctx).delete(ctx.input.id) };
}

export async function automationsListHandler(ctx: RouteContext) {
	const res = await automations(ctx).query({ limit: 100 });
	return { triggers: TRIGGERS, items: res.items.map((a) => ({ id: a.id, ...a.data })) };
}
export async function automationSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const match = ctx.input.id ? null : await findByKey(automations(ctx) as never, "title", ctx.input.record.title);
	const existing = ctx.input.id ? await automations(ctx).get(ctx.input.id) : ((match?.data as AutomationRecord | undefined) ?? null);
	const rec: AutomationRecord = normalizeAutomation(ctx.input.record, existing ?? undefined);
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newAutomationId());
	await automations(ctx).put(id, rec);
	return { id, ...rec };
}
export async function automationDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await automations(ctx).delete(ctx.input.id) };
}
export async function automationRunHandler(ctx: RouteContext<{ id?: string; dryRun: boolean }>) {
	const settings = await loadSettings(ctx);
	return runAutomations(ctx, settings, ctx.site?.url?.replace(/\/$/, "") ?? "", { dryRun: ctx.input.dryRun, onlyId: ctx.input.id });
}

/** Cron: expire holds and run automations. */
export async function bookingsTick(ctx: PluginContext): Promise<void> {
	const { expireHolds } = await import("../bookings.js");
	await expireHolds(ctx).catch((err) => console.error("[bookings] expire holds failed:", err));
	const settings = await loadSettings(ctx);
	await runAutomations(ctx, settings, ctx.site?.url?.replace(/\/$/, "") ?? "").catch((err) => console.error("[automations] run failed:", err));
}

export { zonedToUtc };
