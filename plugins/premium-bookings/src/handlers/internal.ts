/**
 * Interop with sibling plugins.
 *
 *  - Commerce asks `commerce/line` what a provider line `premium-bookings:<id>`
 *    costs (the deposit, or the full price) and tells us through order events
 *    when it was placed, paid, cancelled or refunded.
 *  - Any plugin (the restaurant, a clinic module …) can mirror its own
 *    records as resources/services (`resources/sync`, `services/sync`) and
 *    read bookings in a window (`bookings/query`).
 */

import { loadSettings } from "../settings.js";
import { minorUnits } from "../money.js";
import type { PluginContext, PluginEvent, RouteContext } from "../shim.js";
import { PluginRouteError, requireCaller } from "../shim.js";
import { bookings, bookingsBetween, findByKey, newId, normalizeResource, normalizeService, occupies, publicBooking, publicResource, resources, services, setBookingStatus } from "../store.js";
import { formatWhen } from "../time.js";
import type { CommerceOrderEvent, ResourceRecord, ServiceRecord } from "../types.js";
import { PLUGIN_ID } from "./public.js";

export const COMMERCE = "premium-commerce";

/** Price a held booking for the Commerce checkout. Minor units of the booking currency. */
export async function commerceLineHandler(ctx: RouteContext<{ ref: string; quantity?: number }>) {
	requireCaller(ctx, COMMERCE);
	const s = await loadSettings(ctx);
	const b = await bookings(ctx).get(ctx.input.ref);
	if (!b || !occupies(b) || (b.status !== "held" && b.status !== "pending_payment")) throw PluginRouteError.conflict("That booking hold has expired — please pick a slot again");
	if (b.orderId && b.status === "pending_payment") {
		// A second checkout for the same hold (the first one was abandoned) is fine; the order events keep the latest.
	}
	if (b.price <= 0) throw PluginRouteError.badRequest("This booking does not need payment");
	const when = formatWhen(b.startsAt, s.timezone);
	const full = minorUnits(b.price, s.currency);
	const dep = b.deposit > 0 ? minorUnits(b.deposit, s.currency) : 0;
	const who = b.serviceKind === "reservation" ? (b.partySize ? `table for ${b.partySize}` : b.resourceName) : `with ${b.resourceName}`;
	return {
		title: `${b.serviceTitle} — ${when} ${who}${dep > 0 ? " (deposit)" : ""}`,
		unitAmount: dep > 0 ? dep : full,
		quantity: 1,
		fullAmount: full,
		depositAmount: dep,
		display: [{ name: "when", label: "When", value: `${when} ${who}` }],
	};
}

/** Commerce order events: attach, confirm or release the bookings an order carries. */
export async function onCommerceEvent(event: PluginEvent<CommerceOrderEvent>, ctx: PluginContext): Promise<void> {
	if (event.from !== COMMERCE) return;
	const { id: orderId, order } = event.payload ?? ({} as CommerceOrderEvent);
	if (!order?.items) return;
	const refs = order.items.filter((it) => it.provider === PLUGIN_ID && it.ref).map((it) => it.ref!);
	if (!refs.length) return;
	const kind = event.name.slice(COMMERCE.length + 1);
	for (const bid of refs) {
		const b = await bookings(ctx).get(bid);
		if (!b) continue;
		const note = `order #${order.number}`;
		if (kind === "order.created") {
			if (b.status === "held" || b.status === "pending_payment") await setBookingStatus(ctx, bid, order.status === "awaiting_payment" ? "confirmed" : "pending_payment", note, { orderId, orderNumber: order.number });
		} else if (kind === "order.paid") {
			if (b.status === "held" || b.status === "pending_payment") await setBookingStatus(ctx, bid, "confirmed", `paid ${note}`, { orderId, orderNumber: order.number });
		} else if (kind === "order.cancelled") {
			if ((b.status === "held" || b.status === "pending_payment") && (!b.orderId || b.orderId === orderId)) await setBookingStatus(ctx, bid, "cancelled", `${note} cancelled`);
		} else if (kind === "order.refunded") {
			if (b.status === "confirmed" && b.orderId === orderId) await setBookingStatus(ctx, bid, "cancelled", `${note} refunded`);
		}
	}
}

/* ---- mirrored records from other plugins -------------------------------------- */

/** Upsert a resource owned by the caller (`externalId` = `<caller>:<kind>:<id>`). The caller owns name/capacity/hours. */
export async function resourcesSyncHandler(ctx: RouteContext<{ externalId: string; record: Record<string, unknown> }>) {
	const from = requireCaller(ctx);
	const externalId = ctx.input.externalId.startsWith(`${from}:`) ? ctx.input.externalId : `${from}:${ctx.input.externalId}`;
	const match = await findByKey<ResourceRecord>(resources(ctx), "externalId", externalId);
	const rec = normalizeResource({ ...ctx.input.record, externalId, managedBy: from }, match?.data);
	const id = match?.id ?? newId();
	await resources(ctx).put(id, rec);
	return publicResource(id, rec);
}

export async function resourcesUnsyncHandler(ctx: RouteContext<{ externalId: string }>) {
	const from = requireCaller(ctx);
	const externalId = ctx.input.externalId.startsWith(`${from}:`) ? ctx.input.externalId : `${from}:${ctx.input.externalId}`;
	const match = await findByKey<ResourceRecord>(resources(ctx), "externalId", externalId);
	if (!match) return { deleted: false };
	return { deleted: await resources(ctx).delete(match.id) };
}

/** Upsert a service the caller keeps in sync (matched by slug). */
export async function servicesSyncHandler(ctx: RouteContext<{ slug: string; record: Record<string, unknown> }>) {
	const from = requireCaller(ctx);
	const match = await findByKey<ServiceRecord>(services(ctx), "slug", ctx.input.slug);
	const rec = normalizeService({ ...ctx.input.record, slug: ctx.input.slug, managedBy: from }, match?.data);
	const id = match?.id ?? newId();
	await services(ctx).put(id, rec);
	return { id, ...rec };
}

export async function bookingsQueryHandler(ctx: RouteContext<{ from?: string; to?: string; serviceId?: string; resourceId?: string; externalId?: string; kind?: string; status?: string }>) {
	requireCaller(ctx);
	const s = await loadSettings(ctx);
	const from = ctx.input.from ? new Date(ctx.input.from).toISOString() : new Date(Date.now() - 6 * 3_600_000).toISOString();
	const to = ctx.input.to ? new Date(ctx.input.to).toISOString() : new Date(Date.now() + 14 * 86_400_000).toISOString();
	let resourceId = ctx.input.resourceId;
	if (!resourceId && ctx.input.externalId) resourceId = (await findByKey<ResourceRecord>(resources(ctx), "externalId", ctx.input.externalId))?.id;
	const items = (await bookingsBetween(ctx, from, to))
		.filter((b) => (!ctx.input.serviceId || b.data.serviceId === ctx.input.serviceId) && (!resourceId || b.data.resourceId === resourceId) && (!ctx.input.kind || b.data.serviceKind === ctx.input.kind) && (!ctx.input.status || b.data.status === ctx.input.status))
		.sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt));
	return { timezone: s.timezone, items: items.map((b) => ({ ...publicBooking(b.id, b.data, s.timezone), source: b.data.source })) };
}

export async function internalConfigHandler(ctx: RouteContext) {
	requireCaller(ctx);
	const s = await loadSettings(ctx);
	const svc = (await services(ctx).query({ limit: 200 })).items.map((x) => ({ id: x.id, slug: x.data.slug, kind: x.data.kind, title: x.data.title, active: x.data.active, managedBy: x.data.managedBy ?? null }));
	return { ...s, services: svc };
}
