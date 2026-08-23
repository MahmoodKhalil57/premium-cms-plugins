/**
 * Admin routes: the bookings list with status changes and rescheduling,
 * services, resources (staff = CMS users, assets = rooms/tables/…),
 * automations, and a small Block Kit page for non-PremiumCMS admins.
 */

import { automations, newAutomationId, normalizeAutomation, runAutomations, TRIGGERS } from "../automations.js";
import { availableSlots, expireHolds, holdSlot } from "../availability.js";
import { loadSettings } from "../settings.js";
import type { PluginContext, RouteContext } from "../shim.js";
import { PluginRouteError } from "../shim.js";
import { bookings, bookingsBetween, depositFor, findByKey, newId, normalizeResource, normalizeService, publicBooking, publicResource, resources, services, setBookingStatus } from "../store.js";
import { formatWhen, zoned } from "../time.js";
import type { BookingRecord, ResourceRecord } from "../types.js";
import { notifyConfirmed } from "./public.js";

const siteUrl = (ctx: PluginContext) => ctx.site?.url?.replace(/\/$/, "") ?? "";

/* ---- bookings ------------------------------------------------------------- */

export async function bookingsListHandler(ctx: RouteContext<{ from?: string; to?: string; status?: string; serviceId?: string; resourceId?: string; kind?: string; limit: number }>) {
	const s = await loadSettings(ctx);
	const from = ctx.input.from ? new Date(ctx.input.from).toISOString() : new Date(Date.now() - 86_400_000).toISOString();
	const to = ctx.input.to ? new Date(ctx.input.to).toISOString() : new Date(Date.now() + 30 * 86_400_000).toISOString();
	const items = (await bookingsBetween(ctx, from, to))
		.filter((b) => (!ctx.input.status || b.data.status === ctx.input.status) && (!ctx.input.serviceId || b.data.serviceId === ctx.input.serviceId) && (!ctx.input.resourceId || b.data.resourceId === ctx.input.resourceId) && (!ctx.input.kind || b.data.serviceKind === ctx.input.kind))
		.sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt))
		.slice(0, ctx.input.limit);
	return { timezone: s.timezone, items: items.map((b) => ({ id: b.id, ...b.data, when: formatWhen(b.data.startsAt, s.timezone) })) };
}

export async function bookingUpdateHandler(ctx: RouteContext<{ id: string; status?: "confirmed" | "seated" | "completed" | "cancelled" | "no_show"; startsAt?: string; resourceId?: string; staffId?: string; notes?: string; partySize?: number }>) {
	const s = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.id);
	if (!b) throw PluginRouteError.notFound("Booking not found");
	const patch: Partial<BookingRecord> = {};
	if (ctx.input.notes !== undefined) patch.notes = ctx.input.notes;
	if (ctx.input.partySize !== undefined) patch.partySize = ctx.input.partySize;
	const resourceId = ctx.input.resourceId ?? ctx.input.staffId;
	if (ctx.input.startsAt || resourceId) {
		// Reschedule: re-check availability for the new slot against other bookings.
		const start = new Date(ctx.input.startsAt ?? b.startsAt);
		const ymd = zoned(start, s.timezone).ymd;
		const { slots } = await availableSlots(ctx, s, b.serviceId, ymd, { resourceId: resourceId ?? (ctx.input.startsAt ? null : b.resourceId), partySize: ctx.input.partySize ?? b.partySize ?? null });
		const slot = slots.find((x) => x.startsAt === start.toISOString() && (!resourceId || x.resourceId === resourceId)) ?? (resourceId && !ctx.input.startsAt ? null : undefined);
		if (!slot && ctx.input.startsAt) throw PluginRouteError.conflict("That slot is not available");
		if (slot) {
			patch.startsAt = slot.startsAt;
			patch.endsAt = slot.endsAt;
			patch.resourceId = slot.resourceId;
			patch.resourceName = slot.resourceName;
		} else if (resourceId) {
			// Moving to another resource at the same time (e.g. another table) without re-validating hours.
			const r = await resources(ctx).get(resourceId);
			if (!r) throw PluginRouteError.notFound("Resource not found");
			patch.resourceId = resourceId;
			patch.resourceName = r.name;
		}
	}
	const status = ctx.input.status ?? b.status;
	const updated = await setBookingStatus(ctx, ctx.input.id, status, ctx.input.status ? "by staff" : "rescheduled", patch);
	return { id: ctx.input.id, ...updated!, when: formatWhen(updated!.startsAt, s.timezone) };
}

/** Walk-in / phone booking from the admin (or a sibling plugin): confirmed at once, no payment step. */
export async function bookingCreateHandler(ctx: RouteContext<{ serviceId: string; resourceId?: string; startsAt: string; partySize?: number; customer: { name: string; email?: string; phone?: string }; notes?: string; source?: string }>) {
	const s = await loadSettings(ctx);
	const { id, booking } = await holdSlot(ctx, s, { serviceId: ctx.input.serviceId, resourceId: ctx.input.resourceId ?? null, startsAt: ctx.input.startsAt, partySize: ctx.input.partySize ?? null, customer: { name: ctx.input.customer.name, email: ctx.input.customer.email?.trim().toLowerCase() ?? "", phone: ctx.input.customer.phone }, notes: ctx.input.notes, source: ctx.callerPlugin ?? ctx.input.source ?? "admin", confirm: true });
	await notifyConfirmed(ctx, id, booking.serviceTitle, booking.resourceName, booking.startsAt, booking.customer, booking.partySize, booking.accessToken).catch(() => undefined);
	return { id, ...booking, when: formatWhen(booking.startsAt, s.timezone), public: publicBooking(id, booking, s.timezone) };
}

/* ---- services ------------------------------------------------------------- */

export async function servicesListHandler(ctx: RouteContext<{ kind?: string }>) {
	const res = await services(ctx).query({ limit: 200 });
	return { items: res.items.filter((x) => !ctx.input?.kind || x.data.kind === ctx.input.kind).sort((a, b) => a.data.sortOrder - b.data.sortOrder).map((x) => ({ id: x.id, ...x.data, deposit: depositFor(x.data) })) };
}

export async function serviceSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	// Seeds and theme snapshots reference resources by NAME — ids differ across sites.
	if (Array.isArray(ctx.input.record.resourceNames)) {
		const byName = new Map((await resources(ctx).query({ limit: 500 })).items.map((r) => [r.data.name.toLowerCase(), r.id]));
		ctx.input.record.resourceIds = (ctx.input.record.resourceNames as unknown[]).map((n) => byName.get(String(n).toLowerCase())).filter((x): x is string => Boolean(x));
		delete ctx.input.record.resourceNames;
	}
	const match = ctx.input.id ? null : await findByKey(services(ctx), "slug", ctx.input.record.slug ?? (ctx.input.record.title ? String(ctx.input.record.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : undefined));
	const existing = ctx.input.id ? await services(ctx).get(ctx.input.id) : (match?.data ?? null);
	const rec = normalizeService({ ...ctx.input.record, ...(ctx.callerPlugin ? { managedBy: ctx.callerPlugin } : {}) }, existing ?? undefined);
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newId());
	await services(ctx).put(id, rec);
	return { id, ...rec, deposit: depositFor(rec) };
}

export async function serviceDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await services(ctx).delete(ctx.input.id) };
}

/* ---- resources ------------------------------------------------------------- */

export async function resourcesListHandler(ctx: RouteContext<{ kind?: string }>) {
	const res = await resources(ctx).query({ limit: 200 });
	return { items: res.items.filter((x) => !ctx.input?.kind || x.data.kind === ctx.input.kind).sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.name.localeCompare(b.data.name)).map((x) => publicResource(x.id, x.data)) };
}

export async function resourceSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const rec0 = { ...ctx.input.record };
	// Staff are CMS users: fill in name/email from the account when only the user id is given.
	if (rec0.userId && ctx.users && (!rec0.name || !rec0.email)) {
		const u = await ctx.users.get(String(rec0.userId)).catch(() => null);
		if (u) {
			rec0.name = rec0.name || u.name || u.email;
			rec0.email = rec0.email || u.email;
			rec0.kind = rec0.kind ?? "staff";
		}
	}
	let match: { id: string; data: ResourceRecord } | null = null;
	if (!ctx.input.id) {
		if (rec0.externalId) match = await findByKey(resources(ctx), "externalId", rec0.externalId);
		if (!match && rec0.userId) match = await findByKey(resources(ctx), "userId", rec0.userId);
		if (!match) match = await findByKey(resources(ctx), "name", rec0.name);
	}
	const existing = ctx.input.id ? await resources(ctx).get(ctx.input.id) : (match?.data ?? null);
	const rec = normalizeResource(rec0, existing ?? undefined);
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newId());
	await resources(ctx).put(id, rec);
	return publicResource(id, rec);
}

export async function resourceDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await resources(ctx).delete(ctx.input.id) };
}

/** CMS users, for the "add staff" picker (needs the users:read capability). */
export async function usersListHandler(ctx: RouteContext) {
	if (!ctx.users) return { items: [] };
	const res = await ctx.users.list({ limit: 100 });
	const linked = new Map((await resources(ctx).query({ limit: 200 })).items.filter((r) => r.data.userId).map((r) => [r.data.userId!, r.id]));
	return { items: res.items.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, resourceId: linked.get(u.id) ?? null })) };
}

/* ---- automations ----------------------------------------------------------- */

export async function automationsListHandler(ctx: RouteContext) {
	const res = await automations(ctx).query({ limit: 100 });
	return { triggers: TRIGGERS, items: res.items.map((a) => ({ id: a.id, ...a.data })) };
}
export async function automationSaveHandler(ctx: RouteContext<{ id?: string; record: Record<string, unknown> }>) {
	const match = ctx.input.id ? null : await findByKey(automations(ctx), "title", ctx.input.record.title);
	const existing = ctx.input.id ? await automations(ctx).get(ctx.input.id) : (match?.data ?? null);
	const rec = normalizeAutomation(ctx.input.record, existing ?? undefined);
	const id = existing && ctx.input.id ? ctx.input.id : (match?.id ?? newAutomationId());
	await automations(ctx).put(id, rec);
	return { id, ...rec };
}
export async function automationDeleteHandler(ctx: RouteContext<{ id: string }>) {
	return { deleted: await automations(ctx).delete(ctx.input.id) };
}
export async function automationRunHandler(ctx: RouteContext<{ id?: string; dryRun: boolean }>) {
	const s = await loadSettings(ctx);
	return runAutomations(ctx, s, siteUrl(ctx), { dryRun: ctx.input.dryRun, onlyId: ctx.input.id });
}

/* ---- stats / cron ------------------------------------------------------------ */

export async function statsHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	const now = Date.now();
	const upcoming = (await bookingsBetween(ctx, new Date(now).toISOString(), new Date(now + 7 * 86_400_000).toISOString())).filter((b) => b.data.status === "confirmed" || b.data.status === "pending_payment" || b.data.status === "held");
	const today = zoned(new Date(), s.timezone).ymd;
	const todayCount = upcoming.filter((b) => zoned(new Date(b.data.startsAt), s.timezone).ymd === today).length;
	const [svc, res] = await Promise.all([services(ctx).count({ active: true }), resources(ctx).count({ active: true })]);
	return { timezone: s.timezone, currency: s.currency, today: todayCount, next7Days: upcoming.length, awaitingPayment: upcoming.filter((b) => b.data.status === "pending_payment" || b.data.status === "held").length, services: svc, resources: res, next: upcoming.sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt)).slice(0, 8).map((b) => publicBooking(b.id, b.data, s.timezone)) };
}

/** Cron: expire holds and run automations. */
export async function bookingsTick(ctx: PluginContext): Promise<void> {
	await expireHolds(ctx).catch((err) => console.error("[bookings] expire holds failed:", err));
	const s = await loadSettings(ctx);
	await runAutomations(ctx, s, siteUrl(ctx)).catch((err) => console.error("[bookings] automations failed:", err));
}

/* ---- Block Kit (any EmDash admin) ---------------------------------------------- */

type Block = Record<string, unknown>;
export async function adminHandler(ctx: RouteContext<{ type?: string; page?: string }>) {
	const s = await loadSettings(ctx);
	const page = ctx.input?.page ?? "";
	if (page.startsWith("widget:")) {
		const st = await statsHandler(ctx);
		return { blocks: [{ type: "stats", items: [{ label: "Today", value: st.today }, { label: "Next 7 days", value: st.next7Days }] }, { type: "table", columns: [{ key: "when", label: "When" }, { key: "service", label: "Service" }, { key: "customer", label: "Customer" }, { key: "status", label: "Status", format: "badge" }], rows: st.next.map((b) => ({ when: b.when, service: b.service, customer: b.customer.name, status: b.status })) }] };
	}
	const list = await bookingsListHandler({ ...ctx, input: { limit: 100 } } as never);
	const blocks: Block[] = [
		{ type: "header", text: "Bookings" },
		{ type: "context", text: `Upcoming bookings (times in ${s.timezone}). The PremiumCMS admin adds the full calendar, services, staff & resources and automations on top of these routes.` },
		list.items.length
			? { type: "table", columns: [{ key: "when", label: "When" }, { key: "service", label: "Service" }, { key: "resource", label: "With / where" }, { key: "customer", label: "Customer" }, { key: "status", label: "Status", format: "badge" }], rows: list.items.map((b) => ({ when: b.when, service: b.serviceTitle, resource: b.resourceName, customer: `${b.customer.name} <${b.customer.email}>`, status: b.status })) }
			: { type: "context", text: "No bookings yet." },
	];
	return { blocks };
}

/* ---- config export (theme snapshots) ---------------------------------------- */

const EXPORT_SETTING_KEYS = ["timezone", "slotIntervalMin", "leadTimeHours", "horizonDays", "holdMinutes", "cancelHours", "businessName", "currency", "managePath"];

/**
 * The plugin's current setup as a theme-seed `plugins.<id>` fragment
 * ({ settings, calls }): what bin/snapshot-theme.sh in the themes repo turns a
 * live project into. Site-specific values (record ids, linked users, sync
 * mirrors, the notify email) and secrets are left out; services reference
 * staff by NAME (`resourceNames`, resolved by services/save on the target).
 */
export async function configExportHandler(ctx: RouteContext) {
	const rows = (await ctx.kv.list("settings:").catch(() => null)) ?? [];
	const bag: Record<string, unknown> = Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
	const settings: Record<string, unknown> = {};
	for (const k of EXPORT_SETTING_KEYS) {
		const v = bag[k];
		if (v !== undefined && v !== null && v !== "") settings[k] = v;
	}
	const calls: Array<{ route: string; body?: unknown; ignoreErrors?: boolean }> = [];
	const strip = (data: unknown, drop: string[]): Record<string, unknown> => {
		const d = { ...(data as Record<string, unknown>) };
		for (const k of drop) delete d[k];
		return d;
	};
	const res = (await resources(ctx).query({ limit: 500 })).items.filter((r) => !r.data.managedBy);
	const names = new Map(res.map((r) => [r.id, r.data.name]));
	for (const r of [...res].sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.name.localeCompare(b.data.name))) {
		calls.push({ route: "resources/save", body: { record: strip(r.data, ["userId", "externalId", "managedBy", "createdAt", "updatedAt"]) } });
	}
	const svc = (await services(ctx).query({ limit: 500 })).items.filter((s) => !s.data.managedBy);
	for (const s of [...svc].sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.title.localeCompare(b.data.title))) {
		const rec = strip(s.data, ["resourceIds", "managedBy", "createdAt", "updatedAt"]);
		rec.resourceNames = (s.data.resourceIds ?? []).map((rid) => names.get(rid)).filter(Boolean);
		calls.push({ route: "services/save", body: { record: rec } });
	}
	for (const a of (await automations(ctx).query({ limit: 100 })).items) {
		calls.push({ route: "automations/save", body: { record: strip(a.data, ["createdAt", "updatedAt"]) } });
	}
	return { settings, calls };
}
