/**
 * Automations (AutomateWoo-style): workflows that send an email when
 * something happens to a booking or order — or at a time relative to it
 * (reminder before, recall months after, no-show follow-up). The cron runner
 * evaluates triggers idempotently (one run per workflow per entity).
 */

import { ulid } from "ulidx";

import { type BookingRecord, bookings, formatWhen } from "./bookings.js";
import { formatMoney } from "./money.js";
import { orders } from "./orders.js";
import { reservations } from "./restaurant.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import type { Order, StoreSettings } from "./types.js";

export type TriggerType = "booking_confirmed" | "booking_reminder" | "booking_completed" | "booking_recall" | "booking_no_show" | "order_paid" | "reservation_confirmed" | "reservation_reminder" | "reservation_no_show";

export interface AutomationRecord {
	title: string;
	trigger: TriggerType;
	/** booking_reminder: hours before start; booking_recall: days after completion. */
	offset: number;
	/** Only these services (ids); empty = all. */
	serviceIds: string[];
	action: "email";
	subject: string;
	body: string;
	/** Also notify the practice (settings.notifyEmail). */
	notifyPractice: boolean;
	active: boolean;
	runCount: number;
	lastRunAt?: string | null;
	createdAt: string;
	updatedAt: string;
}

export const automations = (ctx: PluginContext) => ctx.storage.automations as StorageCollection<AutomationRecord>;

export const TRIGGERS: Record<TriggerType, string> = {
	booking_confirmed: "Booking confirmed",
	booking_reminder: "Reminder before an appointment",
	booking_completed: "After an appointment (thank you, aftercare)",
	booking_recall: "Recall — some days after an appointment",
	booking_no_show: "Missed appointment follow-up",
	order_paid: "Order paid",
	reservation_confirmed: "Table reservation confirmed",
	reservation_reminder: "Reminder before a reservation",
	reservation_no_show: "Missed reservation follow-up",
};

export function normalizeAutomation(input: Record<string, unknown>, existing?: AutomationRecord): AutomationRecord {
	const title = String(input.title ?? existing?.title ?? "").trim();
	if (!title) throw PluginRouteError.badRequest("Title is required");
	const trigger = String(input.trigger ?? existing?.trigger ?? "booking_confirmed") as TriggerType;
	if (!(trigger in TRIGGERS)) throw PluginRouteError.badRequest("Unknown trigger");
	const subject = String(input.subject ?? existing?.subject ?? "").trim();
	const body = String(input.body ?? existing?.body ?? "").trim();
	if (!subject || !body) throw PluginRouteError.badRequest("Subject and message are required");
	const now = new Date().toISOString();
	return {
		title,
		trigger,
		offset: Math.max(0, Number(input.offset ?? existing?.offset ?? (trigger === "booking_reminder" ? 24 : trigger === "booking_recall" ? 180 : 0)) || 0),
		serviceIds: input.serviceIds === undefined ? (existing?.serviceIds ?? []) : (Array.isArray(input.serviceIds) ? input.serviceIds.map(String) : String(input.serviceIds).split(/[,\s]+/)).filter(Boolean),
		action: "email",
		subject,
		body,
		notifyPractice: input.notifyPractice === undefined ? (existing?.notifyPractice ?? false) : input.notifyPractice === true || input.notifyPractice === "true",
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		runCount: existing?.runCount ?? 0,
		lastRunAt: existing?.lastRunAt ?? null,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

/** {{first_name}} {{name}} {{service}} {{staff}} {{when}} {{order_number}} {{total}} {{store}} {{site_url}} {{manage_url}} */
export function renderTemplate(text: string, vars: Record<string, string>): string {
	return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => vars[k.toLowerCase()] ?? "");
}

function bookingVars(id: string, b: BookingRecord, settings: StoreSettings, siteUrl: string): Record<string, string> {
	return {
		name: b.customer.name,
		first_name: b.customer.name.split(/\s+/)[0] ?? b.customer.name,
		email: b.customer.email,
		service: b.serviceTitle,
		staff: b.staffName,
		when: formatWhen(b.startsAt, settings.bookingTimezone),
		store: settings.storeName || "our practice",
		site_url: siteUrl,
		manage_url: `${siteUrl}/book?booking=${id}&token=${b.accessToken}`,
	};
}
function orderVars(o: Order, settings: StoreSettings, siteUrl: string): Record<string, string> {
	return {
		name: o.customerName ?? o.email,
		first_name: (o.customerName ?? o.email).split(/\s+/)[0] ?? "",
		email: o.email,
		order_number: String(o.number),
		total: formatMoney(o.total, o.currency),
		store: settings.storeName || "our store",
		site_url: siteUrl,
		manage_url: `${siteUrl}${settings.successPath}?order=${o.number}&token=${o.accessToken}`,
	};
}

async function send(ctx: PluginContext, settings: StoreSettings, wf: AutomationRecord, to: string, vars: Record<string, string>): Promise<void> {
	if (!ctx.email) return;
	const subject = renderTemplate(wf.subject, vars);
	const text = renderTemplate(wf.body, vars);
	await ctx.email.send({ to, subject, text });
	if (wf.notifyPractice && settings.notifyEmail) await ctx.email.send({ to: settings.notifyEmail, subject: `[automation] ${subject}`, text: `To: ${to}\n\n${text}` }).catch(() => undefined);
}

const marker = (wfId: string, entityId: string) => `auto:${wfId}:${entityId}`;

/** Evaluate every active workflow against current bookings/orders; returns how many emails went out. */
export async function runAutomations(ctx: PluginContext, settings: StoreSettings, siteUrl: string, opts: { dryRun?: boolean; onlyId?: string } = {}): Promise<{ sent: number; considered: number }> {
	const all = (await automations(ctx).query({ where: { active: true }, limit: 100 })).items.filter((w) => !opts.onlyId || w.id === opts.onlyId);
	if (all.length === 0) return { sent: 0, considered: 0 };
	const now = Date.now();
	let sent = 0;
	let considered = 0;
	const bookingWorkflows = all.filter((w) => w.data.trigger.startsWith("booking_"));
	if (bookingWorkflows.length) {
		// Recent and upcoming bookings (two years back for recalls).
		const recent = await bookings(ctx).query({ orderBy: { startsAt: "desc" }, limit: 500 });
		for (const { id, data: b } of recent.items) {
			for (const { id: wfId, data: wf } of bookingWorkflows) {
				if (wf.serviceIds.length && !wf.serviceIds.includes(b.serviceId)) continue;
				const start = Date.parse(b.startsAt);
				let due = false;
				if (wf.trigger === "booking_confirmed") due = b.status === "confirmed" || b.status === "completed";
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
	}
	const reservationWorkflows = all.filter((w) => w.data.trigger.startsWith("reservation_"));
	if (reservationWorkflows.length) {
		const recent = await reservations(ctx).query({ orderBy: { at: "desc" }, limit: 300 });
		for (const { id, data: r } of recent.items) {
			if (!r.email) continue;
			for (const { id: wfId, data: wf } of reservationWorkflows) {
				const start = Date.parse(r.at);
				let due = false;
				if (wf.trigger === "reservation_confirmed") due = r.status === "confirmed";
				else if (wf.trigger === "reservation_reminder") due = r.status === "confirmed" && start - now <= wf.offset * 3_600_000 && start > now;
				else if (wf.trigger === "reservation_no_show") due = r.status === "no_show";
				if (!due) continue;
				considered++;
				const k = marker(wfId, id);
				if (await ctx.kv.get(k)) continue;
				if (!opts.dryRun) {
					await send(ctx, settings, wf, r.email, { name: r.name, first_name: r.name.split(/\s+/)[0] ?? r.name, email: r.email, service: `table for ${r.partySize}`, staff: r.tableName ?? "", when: formatWhen(r.at, settings.bookingTimezone), store: settings.storeName || "the restaurant", site_url: siteUrl, manage_url: `${siteUrl}/reserve?reservation=${id}&token=${r.accessToken}` });
					await ctx.kv.set(k, new Date().toISOString());
					wf.runCount++;
					wf.lastRunAt = new Date().toISOString();
					await automations(ctx).put(wfId, wf);
				}
				sent++;
			}
		}
	}
	const orderWorkflows = all.filter((w) => w.data.trigger === "order_paid");
	if (orderWorkflows.length) {
		const paid = await orders(ctx).query({ where: { status: "paid" }, orderBy: { createdAt: "desc" }, limit: 200 });
		const fulfilled = await orders(ctx).query({ where: { status: "fulfilled" }, orderBy: { createdAt: "desc" }, limit: 200 });
		for (const { id, data: o } of [...paid.items, ...fulfilled.items]) {
			if (!o.email) continue;
			for (const { id: wfId, data: wf } of orderWorkflows) {
				considered++;
				const k = marker(wfId, id);
				if (await ctx.kv.get(k)) continue;
				if (!opts.dryRun) {
					await send(ctx, settings, wf, o.email, orderVars(o, settings, siteUrl));
					await ctx.kv.set(k, new Date().toISOString());
					wf.runCount++;
					wf.lastRunAt = new Date().toISOString();
					await automations(ctx).put(wfId, wf);
				}
				sent++;
			}
		}
	}
	return { sent, considered };
}

export const newAutomationId = () => ulid();
