/**
 * One-shot import from Commerce 0.9.x, which used to bundle bookings:
 * services → services, staff → staff resources, bookings → bookings,
 * automations → automations, and restaurant reservations → bookings on the
 * "table-reservation" service (tables are matched by name). Idempotent —
 * every imported record remembers its old id, so the theme seed can call
 * this on every deploy.
 */

import { automations, normalizeAutomation } from "../automations.js";
import type { PluginContext, RouteContext } from "../shim.js";
import { bookings, findByKey, newId, normalizeResource, normalizeService, resources, services } from "../store.js";
import type { BookingRecord, ResourceRecord, ServiceRecord } from "../types.js";

const COMMERCE = "premium-commerce";

async function exportAll<T = Record<string, unknown>>(ctx: PluginContext, collection: string): Promise<Array<{ id: string; data: T }>> {
	if (!ctx.plugins) return [];
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		let r: { items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean };
		try {
			r = await ctx.plugins.call(COMMERCE, "internal/legacy-export", { collection, cursor });
		} catch {
			return out;
		}
		out.push(...r.items);
		if (!r.hasMore || !r.cursor) break;
		cursor = r.cursor;
	}
	return out;
}

export async function migrateFromCommerceHandler(ctx: RouteContext) {
	const done = (await ctx.kv.get<Record<string, string>>("migrate:commerce")) ?? {};
	const result = { services: 0, resources: 0, bookings: 0, automations: 0, reservations: 0, skipped: 0 };
	const remember = async (oldId: string, id: string) => {
		done[oldId] = id;
		await ctx.kv.set("migrate:commerce", done);
	};

	// Staff → staff resources (matched by name so a re-run or a seed never duplicates).
	const staffMap = new Map<string, string>();
	for (const { id: oldId, data } of await exportAll(ctx, "staff")) {
		const d = data as Record<string, unknown>;
		let id = done[oldId];
		if (!id) {
			const match = await findByKey<ResourceRecord>(resources(ctx), "name", d.name);
			id = match?.id ?? newId();
			const rec = normalizeResource({ kind: "staff", name: d.name, email: d.email, title: d.title, bio: d.bio, image: d.image, availability: d.availability, timeOff: d.timeOff, active: d.active }, match?.data);
			await resources(ctx).put(id, rec);
			await remember(oldId, id);
			result.resources++;
		} else result.skipped++;
		staffMap.set(oldId, id);
	}

	// Services → services (matched by slug).
	const serviceMap = new Map<string, string>();
	for (const { id: oldId, data } of await exportAll(ctx, "services")) {
		const d = data as Record<string, unknown>;
		let id = done[oldId];
		if (!id) {
			const match = await findByKey<ServiceRecord>(services(ctx), "slug", d.slug);
			id = match?.id ?? newId();
			const resourceIds = (Array.isArray(d.staffIds) ? d.staffIds : []).map((x) => staffMap.get(String(x)) ?? String(x));
			const rec = normalizeService({ ...d, kind: "appointment", resourceKind: "staff", resourceIds, staffIds: undefined }, match?.data);
			await services(ctx).put(id, rec);
			await remember(oldId, id);
			result.services++;
		} else result.skipped++;
		serviceMap.set(oldId, id);
	}

	// Bookings → bookings (same ids are kept so customer confirmation links stay valid).
	for (const { id: oldId, data } of await exportAll(ctx, "bookings")) {
		if (done[oldId]) {
			result.skipped++;
			continue;
		}
		const d = data as Record<string, unknown> & { customer?: BookingRecord["customer"]; events?: BookingRecord["events"] };
		const rec: BookingRecord = {
			serviceId: serviceMap.get(String(d.serviceId)) ?? String(d.serviceId),
			serviceTitle: String(d.serviceTitle ?? ""),
			serviceKind: "appointment",
			resourceId: staffMap.get(String(d.staffId)) ?? String(d.staffId),
			resourceName: String(d.staffName ?? ""),
			startsAt: String(d.startsAt),
			endsAt: String(d.endsAt),
			status: (d.status as BookingRecord["status"]) ?? "confirmed",
			customer: d.customer ?? { name: "", email: "" },
			price: Number(d.price) || 0,
			deposit: Number(d.deposit) || 0,
			orderId: (d.orderId as string | null) ?? null,
			intakeSubmissionId: (d.intakeSubmissionId as string | null) ?? null,
			notes: typeof d.notes === "string" ? d.notes : undefined,
			source: "online",
			accessToken: String(d.accessToken ?? newId()),
			holdExpiresAt: (d.holdExpiresAt as string | null) ?? null,
			flags: (d.flags as Record<string, string>) ?? {},
			events: [...(d.events ?? []), { at: new Date().toISOString(), type: "migrated", note: "from Commerce" }],
			createdAt: String(d.createdAt ?? new Date().toISOString()),
			updatedAt: new Date().toISOString(),
		};
		await bookings(ctx).put(oldId, rec);
		await remember(oldId, oldId);
		result.bookings++;
	}

	// Automations (matched by title; reservation_* triggers map to booking_*).
	for (const { id: oldId, data } of await exportAll(ctx, "automations")) {
		const d = data as Record<string, unknown>;
		if (done[oldId]) {
			result.skipped++;
			continue;
		}
		if (d.trigger === "order_paid") {
			await remember(oldId, "-");
			continue;
		}
		const match = await findByKey(automations(ctx), "title", d.title);
		const id = match?.id ?? newId();
		const serviceIds = (Array.isArray(d.serviceIds) ? d.serviceIds : []).map((x) => serviceMap.get(String(x)) ?? String(x));
		await automations(ctx).put(id, normalizeAutomation({ ...d, serviceIds, notifyBusiness: d.notifyPractice }, match?.data));
		await remember(oldId, id);
		result.automations++;
	}

	// Restaurant reservations → bookings on the table-reservation service (present once the Restaurant plugin has synced).
	const reservationService = await findByKey<ServiceRecord>(services(ctx), "slug", "table-reservation");
	if (reservationService) {
		const tables = (await resources(ctx).query({ limit: 200 })).items.filter((r) => r.data.kind === "asset");
		for (const { id: oldId, data } of await exportAll(ctx, "reservations")) {
			if (done[oldId]) {
				result.skipped++;
				continue;
			}
			const d = data as Record<string, unknown>;
			const table = tables.find((t) => t.data.name === d.tableName) ?? tables[0];
			const status = String(d.status ?? "confirmed") as BookingRecord["status"];
			const rec: BookingRecord = {
				serviceId: reservationService.id,
				serviceTitle: reservationService.data.title,
				serviceKind: "reservation",
				resourceId: table?.id ?? "",
				resourceName: table?.data.name ?? String(d.tableName ?? ""),
				startsAt: String(d.at),
				endsAt: String(d.endAt),
				status: ["confirmed", "seated", "completed", "cancelled", "no_show"].includes(status) ? status : "confirmed",
				customer: { name: String(d.name ?? ""), email: String(d.email ?? ""), phone: typeof d.phone === "string" ? d.phone : undefined },
				partySize: Number(d.partySize) || 2,
				price: 0,
				deposit: 0,
				notes: typeof d.notes === "string" ? d.notes : undefined,
				source: d.source === "pos" ? "premium-restaurant" : "online",
				accessToken: String(d.accessToken ?? newId()),
				holdExpiresAt: null,
				flags: {},
				events: [{ at: new Date().toISOString(), type: "migrated", note: "reservation from Commerce" }],
				createdAt: String(d.createdAt ?? new Date().toISOString()),
				updatedAt: new Date().toISOString(),
			};
			await bookings(ctx).put(oldId, rec);
			await remember(oldId, oldId);
			result.reservations++;
		}
	}
	return result;
}
