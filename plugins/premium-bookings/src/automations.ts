/**
 * Automations: emails that go out by themselves when something happens to a
 * booking — or at a time relative to it (reminder before, recall months
 * after, no-show follow-up). The cron runner evaluates triggers idempotently
 * (one run per workflow per booking).
 */

import { ulid } from "ulidx";

import { bookings } from "./store.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import { formatWhen } from "./time.js";
import type { AutomationRecord, BookingRecord, BookingSettings, TriggerType } from "./types.js";

export const automations = (ctx: PluginContext) => ctx.storage.automations as StorageCollection<AutomationRecord>;

export const TRIGGERS: Record<TriggerType, string> = {
	booking_confirmed: "Booking confirmed",
	booking_reminder: "Reminder before a booking",
	booking_completed: "After a booking (thank you, aftercare)",
	booking_recall: "Recall — some days after a booking",
	booking_no_show: "Missed booking follow-up",
};

/** Older seeds used reservation_* names; they are the same triggers on a reservation service. */
const LEGACY: Record<string, TriggerType> = { reservation_confirmed: "booking_confirmed", reservation_reminder: "booking_reminder", reservation_no_show: "booking_no_show" };

export function normalizeAutomation(input: Record<string, unknown>, existing?: AutomationRecord): AutomationRecord {
	const title = String(input.title ?? existing?.title ?? "").trim();
	if (!title) throw PluginRouteError.badRequest("Title is required");
	const rawTrigger = String(input.trigger ?? existing?.trigger ?? "booking_confirmed");
	const trigger = (LEGACY[rawTrigger] ?? rawTrigger) as TriggerType;
	if (!(trigger in TRIGGERS)) throw PluginRouteError.badRequest("Unknown trigger");
	const subject = String(input.subject ?? existing?.subject ?? "").trim();
	const body = String(input.body ?? existing?.body ?? "").trim();
	if (!subject || !body) throw PluginRouteError.badRequest("Subject and message are required");
	const now = new Date().toISOString();
	const notify = input.notifyBusiness ?? input.notifyPractice;
	return {
		title,
		trigger,
		offset: Math.max(0, Number(input.offset ?? existing?.offset ?? (trigger === "booking_reminder" ? 24 : trigger === "booking_recall" ? 180 : 0)) || 0),
		serviceIds: input.serviceIds === undefined ? (existing?.serviceIds ?? []) : (Array.isArray(input.serviceIds) ? input.serviceIds.map(String) : String(input.serviceIds).split(/[,\s]+/)).filter(Boolean),
		action: "email",
		subject,
		body,
		notifyBusiness: notify === undefined ? (existing?.notifyBusiness ?? false) : notify === true || notify === "true",
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		runCount: existing?.runCount ?? 0,
		lastRunAt: existing?.lastRunAt ?? null,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

/** {{first_name}} {{name}} {{email}} {{service}} {{resource}} {{staff}} {{when}} {{party_size}} {{store}} {{site_url}} {{manage_url}} */
export function renderTemplate(text: string, vars: Record<string, string>): string {
	return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => vars[k.toLowerCase()] ?? "");
}

export function bookingVars(id: string, b: BookingRecord, settings: BookingSettings, siteUrl: string): Record<string, string> {
	const first = b.customer.name.split(/\s+/)[0] ?? b.customer.name;
	return {
		name: b.customer.name,
		first_name: first,
		email: b.customer.email,
		service: b.serviceTitle,
		resource: b.resourceName,
		staff: b.resourceName,
		when: formatWhen(b.startsAt, settings.timezone),
		party_size: b.partySize ? String(b.partySize) : "",
		store: settings.businessName || "us",
		site_url: siteUrl,
		manage_url: `${siteUrl}${settings.managePath}?booking=${id}&token=${b.accessToken}`,
	};
}

async function send(ctx: PluginContext, settings: BookingSettings, wf: AutomationRecord, to: string, vars: Record<string, string>): Promise<void> {
	if (!ctx.email) return;
	const subject = renderTemplate(wf.subject, vars);
	const text = renderTemplate(wf.body, vars);
	await ctx.email.send({ to, subject, text });
	if (wf.notifyBusiness && settings.notifyEmail) await ctx.email.send({ to: settings.notifyEmail, subject: `[automation] ${subject}`, text: `To: ${to}\n\n${text}` }).catch(() => undefined);
}

const marker = (wfId: string, bookingId: string) => `auto:${wfId}:${bookingId}`;

/** Evaluate every active workflow against recent and upcoming bookings; returns how many emails went out. */
export async function runAutomations(ctx: PluginContext, settings: BookingSettings, siteUrl: string, opts: { dryRun?: boolean; onlyId?: string } = {}): Promise<{ sent: number; considered: number }> {
	const all = (await automations(ctx).query({ where: { active: true }, limit: 100 })).items.filter((w) => !opts.onlyId || w.id === opts.onlyId);
	if (all.length === 0) return { sent: 0, considered: 0 };
	const now = Date.now();
	let sent = 0;
	let considered = 0;
	// Recent and upcoming bookings (two years back for recalls).
	const recent = await bookings(ctx).query({ orderBy: { startsAt: "desc" }, limit: 500 });
	for (const { id, data: b } of recent.items) {
		if (!b.customer.email) continue;
		for (const { id: wfId, data: wf } of all) {
			if (wf.serviceIds.length && !wf.serviceIds.includes(b.serviceId)) continue;
			const start = Date.parse(b.startsAt);
			let due = false;
			if (wf.trigger === "booking_confirmed") due = b.status === "confirmed" || b.status === "seated" || b.status === "completed";
			else if (wf.trigger === "booking_reminder") due = b.status === "confirmed" && start - now <= wf.offset * 3_600_000 && start > now;
			else if (wf.trigger === "booking_completed") due = b.status === "completed";
			else if (wf.trigger === "booking_recall") due = b.status === "completed" && now - start >= wf.offset * 86_400_000;
			else if (wf.trigger === "booking_no_show") due = b.status === "no_show";
			if (!due) continue;
			considered++;
			const k = marker(wfId, id);
			if (await ctx.kv.get(k)) continue;
			if (!opts.dryRun) {
				await send(ctx, settings, wf, b.customer.email, bookingVars(id, b, settings, siteUrl));
				await ctx.kv.set(k, new Date().toISOString());
				wf.runCount++;
				wf.lastRunAt = new Date().toISOString();
				await automations(ctx).put(wfId, wf);
			}
			sent++;
		}
	}
	return { sent, considered };
}

export const newAutomationId = () => ulid();
