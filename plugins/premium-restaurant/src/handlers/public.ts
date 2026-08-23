/**
 * Storefront routes: config, the menu (products grouped by category), order
 * slots, delivery-zone check, QR table lookup and live order tracking.
 */
import { getOrder, menuProducts } from "../commerce.js";
import { reservationServiceId } from "../reservations.js";
import { fulfilments, isOpenNow, matchZone, orderSlots, publicFulfilment, publicTable, tableByCode } from "../restaurant.js";
import { loadSettings } from "../settings.js";
import type { RouteContext } from "../shim.js";
import { PluginRouteError } from "../shim.js";
import type { FulfilmentMode } from "../types.js";

export async function configHandler(ctx: RouteContext) {
	const s = await loadSettings(ctx);
	const reservationService = s.reservationsEnabled ? await reservationServiceId(ctx, s) : null;
	return {
		enabled: true,
		storeName: s.storeName,
		modes: s.fulfilmentModes,
		openNow: isOpenNow(s),
		openingHours: s.openingHours,
		timezone: s.timezone,
		prepTimeMin: s.prepTimeMin,
		tipPresets: s.tipPresets,
		serviceChargePct: s.serviceChargePct,
		payAtTable: s.allowPayAtTable,
		payOnCollection: s.allowPayOnCollection,
		qrOrdering: s.qrOrdering,
		reservations: s.reservationsEnabled && Boolean(reservationService),
		reservationServiceId: reservationService,
		maxPartySize: s.maxPartySize,
		trackPath: s.trackPath,
		zones: s.deliveryZones.map((z) => ({ id: z.id, name: z.name, fee: z.fee, minimum: z.minimum, etaMin: z.etaMin })),
	};
}

/** Menu grouped by category with everything the storefront needs to render dishes and modifiers. */
export async function menuHandler(ctx: RouteContext) {
	const { currency, products } = await menuProducts(ctx);
	const cats = new Map<string, typeof products>();
	for (const p of products.filter((x) => x.available !== false)) cats.set(p.category || "Menu", [...(cats.get(p.category || "Menu") ?? []), p]);
	return {
		currency,
		categories: [...cats.entries()].map(([name, items]) => ({
			name,
			items: items.map((p) => ({ id: p.id, slug: p.slug, title: p.title, unitAmount: p.unitAmount, summary: p.summary ?? null, description: p.description ?? null, image: p.image ?? null, tags: p.tags ?? [], popular: p.popular ?? false, options: p.options ?? [], station: p.station ?? null })),
		})),
	};
}

export async function slotsHandler(ctx: RouteContext<{ mode: FulfilmentMode; date: string }>) {
	const s = await loadSettings(ctx);
	return orderSlots(ctx, s, ctx.input.mode, ctx.input.date);
}

export async function zoneHandler(ctx: RouteContext<{ postcode: string }>) {
	const s = await loadSettings(ctx);
	const z = matchZone(s.deliveryZones, ctx.input.postcode);
	return z ? { zone: { id: z.id, name: z.name, fee: z.fee, minimum: z.minimum, etaMin: z.etaMin } } : { zone: null, message: "Sorry, we do not deliver there yet — pickup is available." };
}

export async function tableHandler(ctx: RouteContext<{ code: string }>) {
	const s = await loadSettings(ctx);
	if (!s.qrOrdering) throw PluginRouteError.badRequest("Table ordering is off");
	const t = await tableByCode(ctx, ctx.input.code);
	if (!t) throw PluginRouteError.notFound("Unknown table code");
	return { table: publicTable(t.id, t.data) };
}

/** Live order status for the tracking page (number + access token). */
export async function trackHandler(ctx: RouteContext<{ order: string | number; token: string }>) {
	const s = await loadSettings(ctx);
	const { id, order } = await getOrder(ctx, { number: ctx.input.order, token: ctx.input.token });
	const f = await fulfilments(ctx).get(id);
	return {
		number: order.number,
		status: order.status,
		total: order.total,
		currency: order.currency,
		fulfilment: publicFulfilment(f, s.timezone),
		items: order.items.map((it) => ({ title: it.title, quantity: it.quantity })),
		events: order.events.filter((e) => e.type === "paid" || e.type === "created").map((e) => ({ at: e.at, type: e.type, note: e.note ?? null })),
	};
}
