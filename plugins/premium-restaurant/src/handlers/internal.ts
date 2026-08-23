/**
 * Interop: Commerce asks `commerce/checkout` to validate the restaurant part
 * of a storefront checkout (`extensions["premium-restaurant"]`) and to price
 * delivery, service charge and tip; order events then drive tickets, prints
 * and the fulfilment record.
 */
import { minorUnits } from "../money.js";
import { fulfilments, matchZone, onOrderCommitted, queuePrintJobs, saveFulfilment, tableByCode, tickets, upsertFulfilment } from "../restaurant.js";
import { loadSettings } from "../settings.js";
import type { PluginContext, PluginEvent, RouteContext } from "../shim.js";
import { PluginRouteError, requireCaller } from "../shim.js";
import type { CheckoutData, CommerceItem, CommerceOrder, OrderMeta } from "../types.js";

export const COMMERCE = "premium-commerce";

interface CheckoutCall {
	data: CheckoutData;
	method: string;
	items: CommerceItem[];
	subtotal: number;
	currency: string;
	email: string;
	name: string | null;
	phone: string | null;
	shippingAddress: { line1?: string; postalCode?: string } | null;
}

export async function commerceCheckoutHandler(ctx: RouteContext<CheckoutCall>) {
	requireCaller(ctx, COMMERCE);
	const s = await loadSettings(ctx);
	const { data, subtotal, currency, method } = ctx.input;
	const mode = data?.mode;
	if (mode !== "delivery" && mode !== "pickup" && mode !== "dine_in") throw PluginRouteError.badRequest("Choose delivery, pickup or dine-in");
	if (!s.fulfilmentModes.includes(mode)) throw PluginRouteError.badRequest(`${mode.replace("_", "-")} orders are not available`);
	const meta: OrderMeta = { mode, at: null, tableId: null, table: null, zoneId: null, zone: null, payLater: method === "manual" };
	const adjustments: Array<{ label: string; amount: number; key: string }> = [];
	if (mode === "dine_in") {
		if (!data.tableCode) throw PluginRouteError.badRequest("Scan the QR code on your table (or enter its code)");
		const t = await tableByCode(ctx, data.tableCode);
		if (!t) throw PluginRouteError.badRequest("Unknown table code");
		meta.tableId = t.id;
		meta.table = t.data.name;
	}
	if (mode === "delivery") {
		const pc = data.postcode ?? ctx.input.shippingAddress?.postalCode ?? "";
		const z = matchZone(s.deliveryZones, pc);
		if (!z) throw PluginRouteError.badRequest("Sorry, we do not deliver to that postcode");
		if (!ctx.input.shippingAddress?.line1) throw PluginRouteError.badRequest("A delivery address is required");
		if (z.minimum > 0 && subtotal < minorUnits(z.minimum, currency)) throw PluginRouteError.badRequest(`Minimum order for delivery to ${z.name} is ${z.minimum} ${currency.toUpperCase()}`);
		meta.zoneId = z.id;
		meta.zone = z.name;
		if (z.fee > 0) adjustments.push({ label: `Delivery · ${z.name}`, amount: minorUnits(z.fee, currency), key: "delivery" });
	}
	const at = data.at && data.at !== "asap" ? new Date(data.at) : null;
	if (at && Number.isNaN(at.getTime())) throw PluginRouteError.badRequest("Pick a valid time");
	if (at && at.getTime() < Date.now() - 60_000) throw PluginRouteError.badRequest("That time has passed — pick another");
	meta.at = at ? at.toISOString() : null;
	if (mode === "dine_in" && s.serviceChargePct > 0) adjustments.push({ label: `Service charge ${s.serviceChargePct}%`, amount: Math.round((subtotal * s.serviceChargePct) / 100), key: "service" });
	const tip = data.tipAmount !== undefined ? Math.max(0, Math.round(data.tipAmount)) : data.tipPercent ? Math.round((subtotal * Math.min(100, data.tipPercent)) / 100) : 0;
	if (tip > 0) adjustments.push({ label: "Tip", amount: tip, key: "tip" });
	const payLaterOk = mode === "dine_in" ? s.allowPayAtTable : s.allowPayOnCollection;
	if (method === "manual" && !payLaterOk) throw PluginRouteError.badRequest(mode === "dine_in" ? "Pay at the table is not available" : "Pay on collection / delivery is not available");
	return { adjustments, meta, allowPayLater: payLaterOk, requireEmail: mode !== "dine_in", summary: `${mode.replace("_", "-")}${meta.table ? ` · ${meta.table}` : ""}${meta.zone ? ` · ${meta.zone}` : ""}` };
}

interface OrderEventPayload {
	id: string;
	order: CommerceOrder;
}

/** Commerce order events: keep the fulfilment record, tickets and prints in step with the order. */
export async function onCommerceEvent(event: PluginEvent<OrderEventPayload>, ctx: PluginContext): Promise<void> {
	if (event.from !== COMMERCE) return;
	const { id, order } = event.payload ?? ({} as OrderEventPayload);
	if (!id || !order) return;
	const f = await upsertFulfilment(ctx, id, order);
	if (!f) return;
	const kind = event.name.slice(COMMERCE.length + 1);
	const s = await loadSettings(ctx);
	if (kind === "order.created" && order.status === "awaiting_payment") {
		await onOrderCommitted(ctx, s, id, order, f);
	} else if (kind === "order.paid") {
		if (!f.ticketsCreated) await onOrderCommitted(ctx, s, id, order, f);
		else if (!f.receiptPrinted) {
			await queuePrintJobs(ctx, s, id, order, f, [], ["receipt"]).catch(() => undefined);
			f.receiptPrinted = true;
			await saveFulfilment(ctx, id, f);
		}
	} else if (kind === "order.cancelled" || kind === "order.refunded") {
		f.kitchen = "cancelled";
		await saveFulfilment(ctx, id, f);
		for (const t of (await tickets(ctx).query({ where: { orderId: id }, limit: 20 })).items) {
			if (t.data.status === "cancelled") continue;
			t.data.status = "cancelled";
			t.data.bumpedAt = new Date().toISOString();
			await tickets(ctx).put(t.id, t.data);
		}
	} else if (kind === "order.fulfilled") {
		if (!["delivered", "completed", "cancelled"].includes(f.kitchen)) {
			f.kitchen = f.mode === "delivery" ? "delivered" : "completed";
			f.completedAt = new Date().toISOString();
			await saveFulfilment(ctx, id, f);
		}
	}
}

/** Fulfilment state for one order — for sibling plugins / the storefront's receipt page through Commerce. */
export async function internalFulfilmentHandler(ctx: RouteContext<{ id: string }>) {
	requireCaller(ctx);
	const s = await loadSettings(ctx);
	const f = await fulfilments(ctx).get(ctx.input.id);
	return { fulfilment: f ? { ...f, when: f.at ? new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", minute: "2-digit", weekday: "short" }).format(new Date(f.at)) : "ASAP" } : null };
}
