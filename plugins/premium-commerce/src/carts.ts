/**
 * Server-side carts: one active cart per signed-in shopper (id `u:<userId>`)
 * and token-addressed guest carts (id `g:<token>`). The storefront keeps a
 * local copy for speed and syncs here so carts survive devices and show up
 * for the merchant (abandoned-cart view). Converted carts keep the order id.
 */

import type { CartLine, CartRecord } from "./types.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";

export const CART_TTL_DAYS = 30;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function carts(ctx: PluginContext): StorageCollection<CartRecord> {
	return ctx.storage.carts as StorageCollection<CartRecord>;
}

export const userCartId = (userId: string) => `u:${userId}`;
export function guestCartId(token: string): string {
	if (!TOKEN_RE.test(token)) throw PluginRouteError.badRequest("invalid cart token");
	return `g:${token}`;
}

export function normalizeLines(raw: unknown): CartLine[] {
	if (!Array.isArray(raw)) return [];
	const out: CartLine[] = [];
	for (const item of raw.slice(0, 50)) {
		if (!item || typeof item !== "object") continue;
		const l = item as Record<string, unknown>;
		const productId = String(l.productId ?? "").slice(0, 200);
		const quantity = Math.min(999, Math.max(1, Math.floor(Number(l.quantity) || 0)));
		if (!productId || !quantity) continue;
		const line: CartLine = { productId, quantity };
		if (l.options && typeof l.options === "object") line.options = l.options as Record<string, unknown>;
		if (l.customization && typeof l.customization === "object") {
			const c = l.customization as Record<string, unknown>;
			line.customization = { design: c.design, ...(typeof c.previewMediaId === "string" ? { previewMediaId: c.previewMediaId } : {}) };
		}
		out.push(line);
	}
	return out;
}

export async function loadCart(ctx: PluginContext, id: string): Promise<CartRecord | null> {
	const cart = await carts(ctx).get(id);
	if (!cart || cart.status !== "active") return null;
	if (cart.expiresAt && Date.parse(cart.expiresAt) < Date.now()) return null;
	return cart;
}

export async function storeCart(ctx: PluginContext, id: string, patch: Partial<CartRecord> & { lines: CartLine[] }, identity: { userId?: string | null; token?: string | null }): Promise<CartRecord> {
	const now = new Date();
	const existing = await carts(ctx).get(id);
	const cart: CartRecord = {
		userId: identity.userId ?? existing?.userId ?? null,
		token: identity.token ?? existing?.token ?? null,
		currency: patch.currency ?? existing?.currency ?? "usd",
		lines: patch.lines,
		email: patch.email ?? existing?.email,
		status: "active",
		createdAt: existing?.createdAt ?? now.toISOString(),
		updatedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + CART_TTL_DAYS * 86_400_000).toISOString(),
	};
	await carts(ctx).put(id, cart);
	return cart;
}

/** Merge a guest cart into the signed-in shopper's cart (quantities add up for identical lines). */
export function mergeLines(base: CartLine[], incoming: CartLine[]): CartLine[] {
	const key = (l: CartLine) => `${l.productId}|${JSON.stringify(Object.entries(l.options ?? {}).sort())}|${l.customization ? JSON.stringify(l.customization.design) : ""}`;
	const map = new Map(base.map((l) => [key(l), { ...l }]));
	for (const l of incoming) {
		const k = key(l);
		const cur = map.get(k);
		if (cur) cur.quantity = Math.min(999, cur.quantity + l.quantity);
		else map.set(k, { ...l });
	}
	return [...map.values()];
}

export async function markConverted(ctx: PluginContext, id: string | null | undefined, orderId: string): Promise<void> {
	if (!id) return;
	const cart = await carts(ctx).get(id);
	if (!cart) return;
	cart.status = "converted";
	cart.convertedOrderId = orderId;
	cart.updatedAt = new Date().toISOString();
	await carts(ctx).put(id, cart);
}
