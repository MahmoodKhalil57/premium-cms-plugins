/**
 * Table reservations live in the Bookings plugin: every table is mirrored as
 * an asset resource (seats = capacity, opening hours = availability) and one
 * "Table reservation" service carries turn time, party size and lead time.
 * The storefront books against Bookings directly; this module only keeps the
 * mirror fresh and tells the storefront which service to use.
 */

import { bookingsCall, PLUGIN_ID } from "./commerce.js";
import { parseHours, tables } from "./restaurant.js";
import type { PluginContext } from "./shim.js";
import type { RestaurantSettings, TableRecord } from "./types.js";

export const RESERVATION_SLUG = "table-reservation";
const SYNC_TTL_MS = 10 * 60_000;

export const tableExternalId = (id: string) => `${PLUGIN_ID}:table:${id}`;

export async function syncTable(ctx: PluginContext, settings: RestaurantSettings, id: string, t: TableRecord): Promise<void> {
	await bookingsCall(ctx, "resources/sync", {
		externalId: tableExternalId(id),
		record: { kind: "asset", name: t.name, capacity: t.seats, availability: parseHours(settings.openingHours), tags: t.zone ? [t.zone] : [], active: t.active, sortOrder: t.seats },
	});
}

export async function unsyncTable(ctx: PluginContext, id: string): Promise<void> {
	await bookingsCall(ctx, "resources/unsync", { externalId: tableExternalId(id) }).catch(() => undefined);
}

/** Push every table and the reservation service to Bookings. Returns the service id (null when Bookings is not installed). */
export async function syncReservations(ctx: PluginContext, settings: RestaurantSettings): Promise<string | null> {
	const svc = await bookingsCall<{ id: string }>(ctx, "services/sync", {
		slug: RESERVATION_SLUG,
		record: { title: "Table reservation", kind: "reservation", resourceKind: "asset", durationMin: Math.max(30, settings.turnTimeMin), bufferMin: 0, price: 0, depositType: "none", minPartySize: 1, maxPartySize: settings.maxPartySize, slotIntervalMin: 30, leadTimeMin: settings.reservationLeadMin, capacity: 1, active: settings.reservationsEnabled, description: `A table for your party at ${settings.storeName || "the restaurant"}.` },
	});
	if (!svc) return null;
	const all = (await tables(ctx).query({ limit: 200 })).items;
	for (const t of all) await syncTable(ctx, settings, t.id, t.data).catch((err) => console.error("[restaurant] table sync failed:", err));
	await ctx.kv.set("reservations:sync", { at: new Date().toISOString(), serviceId: svc.id });
	return svc.id;
}

/** The reservation service id, refreshing the mirror every few minutes (one KV read otherwise). */
export async function reservationServiceId(ctx: PluginContext, settings: RestaurantSettings): Promise<string | null> {
	const marker = await ctx.kv.get<{ at: string; serviceId: string }>("reservations:sync");
	if (marker && Date.now() - Date.parse(marker.at) < SYNC_TTL_MS) return marker.serviceId;
	try {
		return await syncReservations(ctx, settings);
	} catch (err) {
		console.error("[restaurant] reservation sync failed:", err);
		return marker?.serviceId ?? null;
	}
}
