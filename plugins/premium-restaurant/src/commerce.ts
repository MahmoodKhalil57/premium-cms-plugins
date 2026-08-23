/** Calls into the Commerce plugin (orders and the menu = products). */

import type { PluginContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import type { CommerceOrder, CommerceProduct } from "./types.js";

export const COMMERCE = "premium-commerce";
export const BOOKINGS = "premium-bookings";
export const PLUGIN_ID = "premium-restaurant";

function plugins(ctx: PluginContext) {
	if (!ctx.plugins) throw PluginRouteError.internal("Plugin interop is not available on this site");
	return ctx.plugins;
}

export async function commerceCall<T>(ctx: PluginContext, route: string, input?: unknown): Promise<T> {
	try {
		return await plugins(ctx).call<T>(COMMERCE, route, input);
	} catch (err) {
		const e = err as Error & { status?: number; code?: string };
		if (e.code === "NOT_FOUND" && /not enabled|not found/i.test(e.message)) throw PluginRouteError.internal("The Commerce plugin must be installed and active for restaurant ordering");
		throw new PluginRouteError(e.code ?? "COMMERCE_ERROR", e.message, e.status ?? 400);
	}
}

export async function bookingsCall<T>(ctx: PluginContext, route: string, input?: unknown): Promise<T | null> {
	try {
		return await plugins(ctx).call<T>(BOOKINGS, route, input);
	} catch (err) {
		const e = err as Error & { status?: number; code?: string };
		if (e.code === "NOT_FOUND" && /not enabled|not found/i.test(e.message)) return null;
		throw new PluginRouteError(e.code ?? "BOOKINGS_ERROR", e.message, e.status ?? 400);
	}
}

let catalogCache: { at: number; currency: string; products: CommerceProduct[] } | null = null;

/** Published products (the menu) with kitchen station / category; cached briefly per isolate. */
export async function menuProducts(ctx: PluginContext): Promise<{ currency: string; products: CommerceProduct[] }> {
	if (catalogCache && Date.now() - catalogCache.at < 20_000) return catalogCache;
	const r = await commerceCall<{ currency: string; products: CommerceProduct[] }>(ctx, "internal/catalog");
	catalogCache = { at: Date.now(), currency: r.currency, products: r.products };
	return catalogCache;
}

export async function commerceConfig(ctx: PluginContext): Promise<{ currency: string; storeName: string; online: boolean; allowManualPayment: boolean; successPath: string }> {
	return commerceCall(ctx, "internal/config");
}

export async function getOrder(ctx: PluginContext, q: { id?: string; number?: number | string; token?: string }): Promise<{ id: string; order: CommerceOrder }> {
	return commerceCall(ctx, "internal/order", q);
}

export async function recentOrders(ctx: PluginContext, q: { status?: string; limit?: number; sinceHours?: number } = {}): Promise<Array<{ id: string; order: CommerceOrder }>> {
	const r = await commerceCall<{ items: Array<{ id: string; order: CommerceOrder }> }>(ctx, "internal/orders", { limit: q.limit ?? 200, sinceHours: q.sinceHours ?? 48, status: q.status });
	return r.items;
}
