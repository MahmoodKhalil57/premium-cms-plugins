/**
 * One-shot import from Commerce 0.9.x, which used to bundle the restaurant:
 * tables, printers, shifts and staff PIN holders (with the PIN salt, so
 * existing PINs keep working). Open tickets / print jobs are not carried
 * over. Idempotent — imported ids are remembered.
 */

import type { PluginContext, RouteContext } from "../shim.js";
import { newId, normalizeStaff, normalizeTable, printers, shifts, staff, tables } from "../restaurant.js";
import { syncReservations } from "../reservations.js";
import { loadSettings } from "../settings.js";
import type { PrinterRecord, ShiftRecord, TableRecord } from "../types.js";

const COMMERCE = "premium-commerce";

async function exportAll<T = Record<string, unknown>>(ctx: PluginContext, collection: string): Promise<{ items: Array<{ id: string; data: T }>; salt: string | null }> {
	if (!ctx.plugins) return { items: [], salt: null };
	const out: Array<{ id: string; data: T }> = [];
	let salt: string | null = null;
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		let r: { items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean; salt?: string | null };
		try {
			r = await ctx.plugins.call(COMMERCE, "internal/legacy-export", { collection, cursor });
		} catch {
			return { items: out, salt };
		}
		out.push(...r.items);
		salt = r.salt ?? salt;
		if (!r.hasMore || !r.cursor) break;
		cursor = r.cursor;
	}
	return { items: out, salt };
}

export async function migrateFromCommerceHandler(ctx: RouteContext) {
	const done = (await ctx.kv.get<Record<string, string>>("migrate:commerce")) ?? {};
	const result = { tables: 0, printers: 0, shifts: 0, staff: 0, skipped: 0 };
	const remember = async (oldId: string, id: string) => {
		done[oldId] = id;
		await ctx.kv.set("migrate:commerce", done);
	};
	for (const { id: oldId, data } of (await exportAll(ctx, "tables")).items) {
		if (done[oldId]) {
			result.skipped++;
			continue;
		}
		const d = data as Record<string, unknown>;
		const dup = (await tables(ctx).query({ where: { code: String(d.code ?? "").toUpperCase() }, limit: 1 })).items[0];
		const id = dup?.id ?? oldId;
		await tables(ctx).put(id, normalizeTable(d, dup?.data as TableRecord | undefined));
		await remember(oldId, id);
		result.tables++;
	}
	for (const { id: oldId, data } of (await exportAll(ctx, "printers")).items) {
		if (done[oldId]) {
			result.skipped++;
			continue;
		}
		const d = data as unknown as PrinterRecord;
		const dup = (await printers(ctx).query({ limit: 50 })).items.find((p) => p.data.name.toLowerCase() === String(d.name).toLowerCase());
		const id = dup?.id ?? oldId;
		await printers(ctx).put(id, { ...d, updatedAt: new Date().toISOString() });
		await remember(oldId, id);
		result.printers++;
	}
	for (const { id: oldId, data } of (await exportAll(ctx, "shifts")).items) {
		if (done[oldId]) {
			result.skipped++;
			continue;
		}
		await shifts(ctx).put(oldId, data as unknown as ShiftRecord);
		await remember(oldId, oldId);
		result.shifts++;
	}
	const staffExport = await exportAll(ctx, "staff");
	if (staffExport.salt && !(await ctx.kv.get<string>("staff:salt"))) await ctx.kv.set("staff:salt", staffExport.salt);
	for (const { id: oldId, data } of staffExport.items) {
		if (done[oldId]) {
			result.skipped++;
			continue;
		}
		const d = data as Record<string, unknown>;
		if (!d.pinHash && !(Array.isArray(d.roles) && d.roles.length)) {
			// Pure bookings staff (a dentist) belong to the Bookings plugin, not the till.
			await remember(oldId, "-");
			continue;
		}
		const dup = (await staff(ctx).query({ limit: 200 })).items.find((m) => m.data.name.toLowerCase() === String(d.name).trim().toLowerCase());
		const id = dup?.id ?? newId();
		const rec = normalizeStaff({ name: d.name, email: d.email, title: d.title, roles: d.roles, active: d.active }, dup?.data);
		if (typeof d.pinHash === "string" && d.pinHash) rec.pinHash = d.pinHash;
		await staff(ctx).put(id, rec);
		await remember(oldId, id);
		result.staff++;
	}
	const s = await loadSettings(ctx);
	await syncReservations(ctx, s).catch(() => null);
	return result;
}
