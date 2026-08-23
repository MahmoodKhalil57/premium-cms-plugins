/**
 * Storefront routes: the booking widget (service → day → slot → hold), the
 * customer's confirmation page and cancellations, and a signed-in customer's
 * own bookings.
 */

import { availableSlots, holdSlot } from "../availability.js";
import { loadSettings } from "../settings.js";
import type { PluginContext, RouteContext } from "../shim.js";
import { PluginRouteError } from "../shim.js";
import { bookings, depositFor, publicBooking, publicService, resources, services, setBookingStatus } from "../store.js";
import { zoned } from "../time.js";

export const PLUGIN_ID = "premium-bookings";

export async function resourceNames(ctx: PluginContext): Promise<Map<string, string>> {
	const res = await resources(ctx).query({ where: { active: true }, limit: 200 });
	return new Map(res.items.map((r) => [r.id, r.data.name]));
}

export async function configHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	return { timezone: s.timezone, currency: s.currency, horizonDays: s.horizonDays, businessName: s.businessName, cancelHours: s.cancelHours, managePath: s.managePath };
}

export async function servicesHandler(ctx: RouteContext<{ kind?: string }>) {
	const s = await loadSettings(ctx);
	const [res, names] = await Promise.all([services(ctx).query({ where: { active: true }, limit: 100 }), resourceNames(ctx)]);
	const items = res.items
		.filter((x) => !ctx.input?.kind || x.data.kind === ctx.input.kind)
		.sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.title.localeCompare(b.data.title))
		.map((x) => publicService(x.id, x.data, names, s.currency));
	return { currency: s.currency, timezone: s.timezone, horizonDays: s.horizonDays, services: items };
}

export async function availabilityHandler(ctx: RouteContext<{ serviceId: string; date: string; resourceId?: string; staffId?: string; partySize?: number }>) {
	const s = await loadSettings(ctx);
	const { service, slots } = await availableSlots(ctx, s, ctx.input.serviceId, ctx.input.date, { resourceId: ctx.input.resourceId ?? ctx.input.staffId ?? null, partySize: ctx.input.partySize ?? null });
	return {
		date: ctx.input.date,
		timezone: s.timezone,
		durationMin: service.durationMin,
		slots: slots.map((sl) => ({ ...sl, label: new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(sl.startsAt)), staffId: sl.resourceId, staffName: sl.resourceName })),
	};
}

/** Days in the next N that have at least one slot (calendar dots). One availability pass per day. */
export async function availableDaysHandler(ctx: RouteContext<{ serviceId: string; days?: number; partySize?: number; resourceId?: string }>) {
	const s = await loadSettings(ctx);
	const days = Math.min(62, Math.max(7, Number(ctx.input.days) || 31));
	const out: string[] = [];
	for (let i = 0; i < days; i++) {
		const ymd = zoned(new Date(Date.now() + i * 86_400_000), s.timezone).ymd;
		const { slots } = await availableSlots(ctx, s, ctx.input.serviceId, ymd, { partySize: ctx.input.partySize ?? null, resourceId: ctx.input.resourceId ?? null }).catch(() => ({ slots: [] as unknown[] }));
		if (slots.length) out.push(ymd);
	}
	return { days: out };
}

export async function holdHandler(ctx: RouteContext<{ serviceId: string; resourceId?: string; staffId?: string; startsAt: string; partySize?: number; customer: { name: string; email: string; phone?: string }; notes?: string; intakeSubmissionId?: string }>) {
	const s = await loadSettings(ctx);
	const { id, booking } = await holdSlot(ctx, s, { serviceId: ctx.input.serviceId, resourceId: ctx.input.resourceId ?? ctx.input.staffId ?? null, startsAt: ctx.input.startsAt, partySize: ctx.input.partySize ?? null, customer: { ...ctx.input.customer, userId: ctx.user?.id ?? null }, notes: ctx.input.notes, intakeSubmissionId: ctx.input.intakeSubmissionId ?? null, source: "online" });
	if (booking.status === "confirmed") await notifyConfirmed(ctx, id, booking.serviceTitle, booking.resourceName, booking.startsAt, booking.customer, booking.partySize, booking.accessToken).catch(() => undefined);
	return {
		booking: publicBooking(id, booking, s.timezone),
		token: booking.accessToken,
		holdExpiresAt: booking.holdExpiresAt,
		/** Add this to a Commerce checkout to pay (deposit or full price); null when nothing is due now. */
		checkoutItem: booking.status === "held" ? { productId: `${PLUGIN_ID}:${id}`, quantity: 1 } : null,
	};
}

export async function bookingLookupHandler(ctx: RouteContext<{ id: string; token?: string }>) {
	const s = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.id);
	if (!b) throw PluginRouteError.notFound("Booking not found");
	const mine = ctx.user && b.customer.userId === ctx.user.id;
	if (!mine && (!ctx.input.token || ctx.input.token !== b.accessToken)) throw PluginRouteError.forbidden("Booking not found");
	return { booking: publicBooking(ctx.input.id, b, s.timezone) };
}

export async function bookingCancelHandler(ctx: RouteContext<{ id: string; token?: string }>) {
	const s = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.id);
	if (!b) throw PluginRouteError.notFound("Booking not found");
	const mine = ctx.user && b.customer.userId === ctx.user.id;
	if (!mine && (!ctx.input.token || ctx.input.token !== b.accessToken)) throw PluginRouteError.forbidden("Booking not found");
	if (b.status === "cancelled") return { booking: publicBooking(ctx.input.id, b, s.timezone) };
	if (Date.parse(b.startsAt) - Date.now() < s.cancelHours * 3_600_000) throw PluginRouteError.badRequest("This booking can no longer be cancelled online — please contact us");
	const updated = await setBookingStatus(ctx, ctx.input.id, "cancelled", "cancelled by customer");
	if (s.notifyEmail && ctx.email) await ctx.email.send({ to: s.notifyEmail, subject: `[cancelled] ${b.serviceTitle} · ${b.customer.name}`, text: `${b.customer.name} (${b.customer.email}) cancelled ${b.serviceTitle} with ${b.resourceName} at ${b.startsAt}.` }).catch(() => undefined);
	return { booking: publicBooking(ctx.input.id, updated!, s.timezone) };
}

export async function accountBookingsHandler(ctx: RouteContext) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in to continue");
	const s = await loadSettings(ctx);
	const res = await bookings(ctx).query({ orderBy: { startsAt: "desc" }, limit: 200 });
	const mine = res.items.filter((b) => b.data.customer.userId === ctx.user!.id || b.data.customer.email.toLowerCase() === ctx.user!.email.toLowerCase());
	return { bookings: mine.map((b) => publicBooking(b.id, b.data, s.timezone)) };
}

/** Confirmation email for bookings confirmed without payment (free services, admin bookings). Paid ones are confirmed by the order. */
export async function notifyConfirmed(ctx: PluginContext, id: string, service: string, resource: string, startsAt: string, customer: { name: string; email: string; phone?: string }, partySize: number | undefined, token: string): Promise<void> {
	if (!ctx.email || !customer.email) return;
	const s = await loadSettings(ctx);
	const when = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(startsAt));
	const site = ctx.site?.url?.replace(/\/$/, "") ?? "";
	const what = partySize ? `${service} for ${partySize}` : service;
	await ctx.email.send({ to: customer.email, subject: `${what} — ${when}${s.businessName ? ` · ${s.businessName}` : ""}`, text: `Hi ${customer.name.split(/\s+/)[0] ?? customer.name},\n\nYour ${what}${resource ? ` (${resource})` : ""} is booked for ${when}.\n\nNeed to change it? ${site}${s.managePath}?booking=${id}&token=${token}\n\nSee you soon${s.businessName ? `,\n${s.businessName}` : "!"}` });
	if (s.notifyEmail) await ctx.email.send({ to: s.notifyEmail, subject: `[booking] ${what} · ${customer.name} · ${when}`, text: `${customer.name} (${customer.email}${customer.phone ? `, ${customer.phone}` : ""}) booked ${what}${resource ? ` with ${resource}` : ""} at ${when}.` }).catch(() => undefined);
}

export { depositFor };
