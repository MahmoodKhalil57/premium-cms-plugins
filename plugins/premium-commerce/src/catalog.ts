/**
 * Products come from the CMS `products` collection (read-only here); the
 * plugin only keeps sold/reserved counters per product.
 */

import { minorUnits } from "./money.js";
import type { ContentItem, PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import { parseFieldList } from "./fields.js";
import type { InventoryRow, Product } from "./types.js";

export const PRODUCTS_COLLECTION = "products";

export function inventory(ctx: PluginContext): StorageCollection<InventoryRow> {
	return ctx.storage.inventory as StorageCollection<InventoryRow>;
}

const num = (v: unknown): number | undefined => {
	if (v === null || v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

const csvList = (v: unknown): string[] | undefined => {
	const list = (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,\n]+/)).map((x) => x.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
};

/** Portable Text blocks → plain text (first 2000 chars); strings pass through. */
function plainText(v: unknown): string | undefined {
	if (!v) return undefined;
	if (typeof v === "string") return v.slice(0, 2000);
	if (Array.isArray(v)) {
		const text = v
			.map((b) => (Array.isArray((b as { children?: unknown[] })?.children) ? (b as { children: Array<{ text?: string }> }).children.map((c) => c.text ?? "").join("") : ""))
			.filter(Boolean)
			.join("\n");
		return text ? text.slice(0, 2000) : undefined;
	}
	return undefined;
}

export function toProduct(item: ContentItem, currency: string): Product | null {
	const d = item.data ?? {};
	const slug = item.slug ?? (typeof d.slug === "string" ? d.slug : null);
	const status = item.status ?? (typeof d.status === "string" ? d.status : undefined);
	const price = num(d.price);
	if (price === undefined || !slug || (status !== undefined && status !== "published")) return null;
	const stock = num(d.stock);
	const compare = num(d.compare_at_price);
	const sizes = csvList(d.sizes);
	const options = parseFieldList(d.options);
	// A plain `sizes` list is the common case; it becomes a required select unless the options already define a size field.
	if (sizes && !options.some((f) => f.name === "size")) {
		options.unshift({ id: "size", type: "select", label: "Size", name: "size", required: true, width: "full", options: sizes.map((v) => ({ value: v, label: v })) });
	}
	return {
		id: item.id,
		slug,
		title: String(d.title ?? slug),
		unitAmount: minorUnits(price, currency),
		compareAtAmount: compare !== undefined ? minorUnits(compare, currency) : undefined,
		sku: d.sku ? String(d.sku) : undefined,
		stock: stock === undefined ? null : Math.max(0, Math.floor(stock)),
		requiresShipping: d.requires_shipping === undefined || d.requires_shipping === null ? true : Boolean(d.requires_shipping),
		sizes,
		options: options.length ? options : undefined,
		summary: d.summary ? String(d.summary) : undefined,
		image: d.image ?? null,
		category: d.category ? String(d.category) : undefined,
		station: d.station ? String(d.station) : undefined,
		tags: csvList(d.dietary ?? d.tags),
		available: d.available === undefined || d.available === null ? undefined : Boolean(d.available),
		popular: d.popular === undefined || d.popular === null ? undefined : Boolean(d.popular),
		description: plainText(d.description),
	};
}

export async function listProducts(ctx: PluginContext, currency: string): Promise<Product[]> {
	if (!ctx.content) throw PluginRouteError.internal("content access is not available to the plugin");
	const out: Product[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 5; page++) {
		const res = await ctx.content.list(PRODUCTS_COLLECTION, { limit: 100, cursor, where: { status: "published" } });
		for (const item of res.items) {
			const p = toProduct(item, currency);
			if (p) out.push(p);
		}
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	return out;
}

export async function getProduct(ctx: PluginContext, idOrSlug: string, currency: string): Promise<Product | null> {
	if (!ctx.content) throw PluginRouteError.internal("content access is not available to the plugin");
	const byId = await ctx.content.get(PRODUCTS_COLLECTION, idOrSlug).catch(() => null);
	if (byId) return toProduct(byId, currency);
	const all = await listProducts(ctx, currency);
	return all.find((p) => p.slug === idOrSlug || p.id === idOrSlug) ?? null;
}

export async function inventoryFor(ctx: PluginContext, productIds: string[]): Promise<Map<string, InventoryRow>> {
	if (productIds.length === 0) return new Map();
	return inventory(ctx).getMany(productIds);
}

export function available(product: Product, inv: InventoryRow | undefined): number | null {
	if (product.stock === null) return null;
	return Math.max(0, product.stock - (inv?.sold ?? 0) - (inv?.reserved ?? 0));
}

/** Two RPCs regardless of line count: getMany + putMany. */
type StockLine = { productId: string; quantity: number; stockKeys?: string[] };

/** Inventory rows a line draws from: the product itself plus tracked choices ("<product>#<field>=<value>"). */
export const stockKeysOf = (it: StockLine): string[] => (it.stockKeys?.length ? it.stockKeys : [it.productId]);

async function bump(ctx: PluginContext, items: StockLine[], delta: (qty: number) => { sold?: number; reserved?: number }): Promise<void> {
	if (items.length === 0) return;
	const perKey = new Map<string, number>();
	for (const it of items) for (const key of stockKeysOf(it)) perKey.set(key, (perKey.get(key) ?? 0) + it.quantity);
	const rows = await inventory(ctx).getMany([...perKey.keys()]);
	const now = new Date().toISOString();
	const updates = [...perKey].map(([key, quantity]) => {
		const row = rows.get(key) ?? { productId: key, sold: 0, reserved: 0, updatedAt: "" };
		const d = delta(quantity);
		row.sold = Math.max(0, row.sold + (d.sold ?? 0));
		row.reserved = Math.max(0, row.reserved + (d.reserved ?? 0));
		row.updatedAt = now;
		return { id: key, data: row };
	});
	await inventory(ctx).putMany(updates);
}

/** Units left for a tracked choice (its own stock minus sold/reserved on that key). */
export function availableForChoice(choiceStock: number, inv: InventoryRow | undefined): number {
	return Math.max(0, choiceStock - (inv?.sold ?? 0) - (inv?.reserved ?? 0));
}

export const reserveStock = (ctx: PluginContext, items: StockLine[]) => bump(ctx, items, (q) => ({ reserved: q }));
export const releaseStock = (ctx: PluginContext, items: StockLine[]) => bump(ctx, items, (q) => ({ reserved: -q }));
export const commitStock = (ctx: PluginContext, items: StockLine[]) => bump(ctx, items, (q) => ({ reserved: -q, sold: q }));
export const restock = (ctx: PluginContext, items: StockLine[]) => bump(ctx, items, (q) => ({ sold: -q }));
