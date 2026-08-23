/**
 * The slot engine: free start times for a service on a calendar day (in the
 * business time zone), per resource that can take it. Honours each resource's
 * weekly hours and time off, existing bookings (with buffers), lead time, the
 * booking horizon and per-slot capacity. Reservations collapse to one slot per
 * time on the smallest free asset that fits the party.
 */

import { bookings, bookingsBetween, newId, occupies, resources, services, randomToken } from "./store.js";
import type { PluginContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import { overlaps, YMD_RE, zoned, zonedToUtc } from "./time.js";
import type { BookingRecord, BookingSettings, ResourceRecord, ServiceRecord, Slot } from "./types.js";

export interface SlotQuery {
	resourceId?: string | null;
	partySize?: number | null;
}

async function candidates(ctx: PluginContext, service: ServiceRecord, q: SlotQuery): Promise<Array<{ id: string; data: ResourceRecord }>> {
	const all = await resources(ctx).query({ where: { active: true }, limit: 200 });
	const party = q.partySize ?? 1;
	return all.items
		.filter((r) => r.data.kind === service.resourceKind)
		.filter((r) => service.resourceIds.length === 0 || service.resourceIds.includes(r.id))
		.filter((r) => !q.resourceId || r.id === q.resourceId)
		.filter((r) => service.kind !== "reservation" || r.data.capacity >= party)
		.sort((a, b) => a.data.capacity - b.data.capacity || a.data.sortOrder - b.data.sortOrder || a.data.name.localeCompare(b.data.name));
}

export async function availableSlots(ctx: PluginContext, settings: BookingSettings, serviceId: string, ymd: string, q: SlotQuery = {}): Promise<{ service: ServiceRecord; slots: Slot[] }> {
	const service = await services(ctx).get(serviceId);
	if (!service || !service.active) throw PluginRouteError.notFound("Service not found");
	if (!YMD_RE.test(ymd)) throw PluginRouteError.badRequest("Date must be YYYY-MM-DD");
	if (service.kind === "reservation") {
		const party = q.partySize ?? service.minPartySize;
		if (party < service.minPartySize || party > service.maxPartySize) throw PluginRouteError.badRequest(`Parties of ${service.minPartySize}–${service.maxPartySize} can book online`);
	}
	const tz = settings.timezone;
	const now = Date.now();
	const earliest = now + (service.leadTimeMin !== null && service.leadTimeMin !== undefined ? service.leadTimeMin * 60_000 : settings.leadTimeHours * 3_600_000);
	const latest = now + settings.horizonDays * 86_400_000;
	const dayStart = zonedToUtc(ymd, "00:00", tz);
	const dayEnd = new Date(dayStart.getTime() + 36 * 3_600_000);
	const pool = await candidates(ctx, service, q);
	const existing = (await bookingsBetween(ctx, new Date(dayStart.getTime() - 86_400_000).toISOString(), dayEnd.toISOString())).filter((b) => occupies(b.data, now));
	const dow = zoned(new Date(dayStart.getTime() + 12 * 3_600_000), tz).dow;
	const step = Math.max(5, service.slotIntervalMin ?? settings.slotIntervalMin) * 60_000;
	const need = (service.durationMin + service.bufferMin) * 60_000;
	const slots: Slot[] = [];
	const taken = new Set<string>();
	for (const entry of pool) {
		const r = entry.data;
		for (const w of r.availability.filter((x) => x.dow === dow)) {
			const wStart = zonedToUtc(ymd, w.start, tz).getTime();
			const wEnd = zonedToUtc(ymd, w.end, tz).getTime();
			for (let t = wStart; t + service.durationMin * 60_000 <= wEnd; t += step) {
				const end = t + service.durationMin * 60_000;
				const blockEnd = t + need;
				if (t < earliest || t > latest) continue;
				const startIso = new Date(t).toISOString();
				if (service.kind === "reservation" && taken.has(startIso)) continue;
				if (r.timeOff.some((o) => overlaps(t, blockEnd, Date.parse(o.start), Date.parse(o.end)))) continue;
				const clashing = existing.filter((b) => b.data.resourceId === entry.id && overlaps(t, blockEnd, Date.parse(b.data.startsAt), Date.parse(b.data.endsAt))).length;
				if (clashing >= Math.max(1, service.capacity)) continue;
				slots.push({ startsAt: startIso, endsAt: new Date(end).toISOString(), resourceId: entry.id, resourceName: r.name });
				if (service.kind === "reservation") taken.add(startIso);
			}
		}
	}
	slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.resourceName.localeCompare(b.resourceName));
	return { service, slots };
}

export interface HoldInput {
	serviceId: string;
	resourceId?: string | null;
	startsAt: string;
	partySize?: number | null;
	customer: BookingRecord["customer"];
	notes?: string;
	intakeSubmissionId?: string | null;
	source?: string;
	/** Admin/plugin bookings: skip the hold and confirm at once even when the service is paid. */
	confirm?: boolean;
}

export async function holdSlot(ctx: PluginContext, settings: BookingSettings, input: HoldInput): Promise<{ id: string; booking: BookingRecord }> {
	const service = await services(ctx).get(input.serviceId);
	if (!service || !service.active) throw PluginRouteError.notFound("Service not found");
	const start = new Date(input.startsAt);
	if (Number.isNaN(start.getTime())) throw PluginRouteError.badRequest("Invalid start time");
	const ymd = zoned(start, settings.timezone).ymd;
	const { slots } = await availableSlots(ctx, settings, input.serviceId, ymd, { resourceId: input.resourceId ?? null, partySize: input.partySize ?? null });
	const slot = slots.find((s) => s.startsAt === start.toISOString() && (!input.resourceId || s.resourceId === input.resourceId));
	if (!slot) throw PluginRouteError.conflict("That time is no longer available — please pick another slot");
	const now = new Date();
	const price = service.price;
	const deposit = price > 0 && service.depositType !== "none" ? Math.max(0, Math.min(price, service.depositType === "percent" ? Math.round(price * service.depositAmount) / 100 : service.depositAmount)) : 0;
	const needsPayment = price > 0 && !input.confirm;
	const id = newId();
	const record: BookingRecord = {
		serviceId: input.serviceId,
		serviceTitle: service.title,
		serviceKind: service.kind,
		resourceId: slot.resourceId,
		resourceName: slot.resourceName,
		startsAt: slot.startsAt,
		endsAt: slot.endsAt,
		status: needsPayment ? "held" : "confirmed",
		customer: input.customer,
		...(service.kind === "reservation" ? { partySize: input.partySize ?? service.minPartySize } : {}),
		price,
		deposit,
		intakeSubmissionId: input.intakeSubmissionId ?? null,
		notes: input.notes,
		source: input.source ?? "online",
		accessToken: randomToken(),
		holdExpiresAt: needsPayment ? new Date(now.getTime() + settings.holdMinutes * 60_000).toISOString() : null,
		flags: {},
		events: [{ at: now.toISOString(), type: needsPayment ? "held" : "confirmed", note: needsPayment ? `hold ${settings.holdMinutes} min` : price > 0 ? "confirmed without payment" : "free booking" }],
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
	await bookings(ctx).put(id, record);
	return { id, booking: record };
}

/** Expire stale holds (cron). */
export async function expireHolds(ctx: PluginContext): Promise<number> {
	const res = await bookings(ctx).query({ where: { status: "held" }, limit: 100 });
	let n = 0;
	for (const b of res.items) {
		if (b.data.holdExpiresAt && Date.parse(b.data.holdExpiresAt) < Date.now()) {
			b.data.status = "cancelled";
			b.data.holdExpiresAt = null;
			b.data.events.push({ at: new Date().toISOString(), type: "cancelled", note: "hold expired" });
			b.data.updatedAt = new Date().toISOString();
			await bookings(ctx).put(b.id, b.data);
			n++;
		}
	}
	return n;
}
