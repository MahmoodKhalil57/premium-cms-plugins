/**
 * Discounts (WooCommerce-style): coupon codes entered at checkout and
 * automatic promotions that need no code. Both can be limited to products,
 * a minimum spend, dates and usage counts. Automatic product discounts show
 * as sale prices on the storefront; coupons are applied to the eligible
 * lines at checkout. Everything is computed server-side from the records —
 * the storefront only previews.
 */

import { ulid } from "ulidx";

import { minorUnits } from "./money.js";
import type { PluginContext, StorageCollection } from "./shim.js";
import { PluginRouteError } from "./shim.js";

export type DiscountType = "percent" | "fixed_product" | "fixed_cart";

export interface DiscountRecord {
	title: string;
	/** Uppercase code; null = automatic (applies by itself). */
	code: string | null;
	type: DiscountType;
	/** Percent (0–100) or major units. */
	amount: number;
	/** Product ids or slugs; empty = every product. */
	products: string[];
	excludeProducts: string[];
	/** Major units; coupon only applies when the eligible subtotal reaches it. */
	minSubtotal?: number | null;
	maxUses?: number | null;
	usesPerCustomer?: number | null;
	usedCount: number;
	startsAt?: string | null;
	endsAt?: string | null;
	freeShipping?: boolean;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface DiscountLine {
	productId: string;
	slug: string;
	quantity: number;
	/** Minor units before discounts. */
	unitAmount: number;
}

export interface AppliedDiscount {
	id: string;
	title: string;
	code: string | null;
	/** Minor units taken off this line (per unit). */
	perUnit: number;
}

export interface DiscountResult {
	lines: Array<DiscountLine & { finalUnitAmount: number; applied: AppliedDiscount[] }>;
	/** Minor units, whole order. */
	discountTotal: number;
	coupon: { id: string; code: string; title: string; freeShipping: boolean } | null;
	/** Why a submitted code did not apply (null when it did or none given). */
	couponError: string | null;
}

export function discounts(ctx: PluginContext): StorageCollection<DiscountRecord> {
	return ctx.storage.discounts as StorageCollection<DiscountRecord>;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

export function isLive(d: DiscountRecord, now = Date.now()): boolean {
	if (!d.active) return false;
	if (d.startsAt && Date.parse(d.startsAt) > now) return false;
	if (d.endsAt && Date.parse(d.endsAt) < now) return false;
	if (typeof d.maxUses === "number" && d.maxUses > 0 && d.usedCount >= d.maxUses) return false;
	return true;
}

export function appliesToProduct(d: DiscountRecord, p: { id?: string; productId?: string; slug: string }): boolean {
	const ids = [p.id, p.productId, p.slug].filter((x): x is string => !!x);
	if (d.excludeProducts.some((x) => ids.includes(x))) return false;
	return d.products.length === 0 || d.products.some((x) => ids.includes(x));
}

/** All live records, cached per isolate for a short while (storefront reads are frequent). */
let cache: { at: number; items: Array<{ id: string; data: DiscountRecord }> } | null = null;
export async function liveDiscounts(ctx: PluginContext): Promise<Array<{ id: string; data: DiscountRecord }>> {
	if (cache && Date.now() - cache.at < 15_000) return cache.items;
	const out: Array<{ id: string; data: DiscountRecord }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 5; page++) {
		const res = await discounts(ctx).query({ where: { active: true }, limit: 100, cursor });
		out.push(...res.items.filter((d) => isLive(d.data)));
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	cache = { at: Date.now(), items: out };
	return out;
}
export function invalidateDiscounts(): void {
	cache = null;
}

function perUnitOff(d: DiscountRecord, unitAmount: number, currency: string): number {
	if (d.type === "percent") return Math.round((unitAmount * Math.min(100, Math.max(0, d.amount))) / 100);
	if (d.type === "fixed_product") return Math.min(unitAmount, minorUnits(d.amount, currency));
	return 0;
}

/** Best automatic product discount for a product (what the storefront shows as the sale price). */
export function automaticSale(all: Array<{ id: string; data: DiscountRecord }>, p: { id?: string; productId?: string; slug: string }, unitAmount: number, currency: string): { unitAmount: number; applied: AppliedDiscount } | null {
	let best: { unitAmount: number; applied: AppliedDiscount } | null = null;
	for (const { id, data } of all) {
		if (data.code || data.type === "fixed_cart" || !appliesToProduct(data, p)) continue;
		const off = perUnitOff(data, unitAmount, currency);
		if (off <= 0) continue;
		if (!best || off > best.applied.perUnit) best = { unitAmount: unitAmount - off, applied: { id, title: data.title, code: null, perUnit: off } };
	}
	return best;
}

/**
 * Apply automatic discounts per line, then one coupon (percent / fixed per
 * product on eligible lines, or a fixed amount spread across the eligible
 * lines in proportion to their value).
 */
export async function applyDiscounts(ctx: PluginContext, lines: DiscountLine[], currency: string, opts: { code?: string | null; customerKey?: string | null }): Promise<DiscountResult> {
	const all = await liveDiscounts(ctx);
	const out: DiscountResult["lines"] = lines.map((l) => {
		const sale = automaticSale(all, l, l.unitAmount, currency);
		return { ...l, finalUnitAmount: sale ? sale.unitAmount : l.unitAmount, applied: sale ? [sale.applied] : [] };
	});
	let coupon: DiscountResult["coupon"] = null;
	let couponError: string | null = null;
	const code = opts.code ? normalizeCode(opts.code) : "";
	if (code) {
		const hit = all.find((d) => d.data.code === code);
		if (!hit) couponError = "That code is not valid or has expired";
		else {
			const d = hit.data;
			if (typeof d.usesPerCustomer === "number" && d.usesPerCustomer > 0 && opts.customerKey) {
				const used = (await ctx.kv.get<number>(`coupon-use:${hit.id}:${opts.customerKey}`)) ?? 0;
				if (used >= d.usesPerCustomer) couponError = "You have already used this code";
			}
			const eligible = out.filter((l) => appliesToProduct(d, l));
			const eligibleSubtotal = eligible.reduce((n, l) => n + l.finalUnitAmount * l.quantity, 0);
			if (!couponError && eligible.length === 0) couponError = "That code does not apply to anything in your bag";
			if (!couponError && typeof d.minSubtotal === "number" && d.minSubtotal > 0 && eligibleSubtotal < minorUnits(d.minSubtotal, currency)) couponError = `Spend at least ${formatMinor(minorUnits(d.minSubtotal, currency), currency)} on eligible items to use this code`;
			if (!couponError) {
				if (d.type === "fixed_cart") {
					let remaining = Math.min(eligibleSubtotal, minorUnits(d.amount, currency));
					const total = eligibleSubtotal || 1;
					for (const [i, l] of eligible.entries()) {
						const lineValue = l.finalUnitAmount * l.quantity;
						const share = i === eligible.length - 1 ? remaining : Math.min(remaining, Math.round((minorUnits(d.amount, currency) * lineValue) / total));
						const perUnit = Math.min(l.finalUnitAmount, Math.floor(share / l.quantity));
						if (perUnit > 0) {
							l.finalUnitAmount -= perUnit;
							l.applied.push({ id: hit.id, title: d.title, code, perUnit });
							remaining -= perUnit * l.quantity;
						}
					}
				} else {
					for (const l of eligible) {
						const off = perUnitOff(d, l.finalUnitAmount, currency);
						if (off > 0) {
							l.finalUnitAmount -= off;
							l.applied.push({ id: hit.id, title: d.title, code, perUnit: off });
						}
					}
				}
				coupon = { id: hit.id, code, title: d.title, freeShipping: d.freeShipping === true };
			}
		}
	}
	const discountTotal = out.reduce((n, l) => n + (l.unitAmount - l.finalUnitAmount) * l.quantity, 0);
	return { lines: out, discountTotal, coupon, couponError };
}

function formatMinor(minor: number, currency: string): string {
	const zero = new Set(["jpy", "krw", "vnd", "clp", "isk", "huf"]);
	const major = zero.has(currency.toLowerCase()) ? minor : minor / 100;
	try {
		return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(major);
	} catch {
		return `${major} ${currency.toUpperCase()}`;
	}
}

/** Count a coupon use once an order is paid (or placed, for pay-later). */
export async function recordCouponUse(ctx: PluginContext, id: string, customerKey: string | null): Promise<void> {
	const rec = await discounts(ctx).get(id);
	if (rec) {
		rec.usedCount = (rec.usedCount ?? 0) + 1;
		rec.updatedAt = new Date().toISOString();
		await discounts(ctx).put(id, rec);
	}
	if (customerKey) {
		const k = `coupon-use:${id}:${customerKey}`;
		await ctx.kv.set(k, ((await ctx.kv.get<number>(k)) ?? 0) + 1);
	}
	invalidateDiscounts();
}

/* ---- admin ---------------------------------------------------------------- */

const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean);
const numOrNull = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const dateOrNull = (v: unknown) => {
	if (v === undefined || v === null || v === "") return null;
	const t = Date.parse(String(v));
	return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export function normalizeDiscount(input: Record<string, unknown>, existing?: DiscountRecord): DiscountRecord {
	const type = String(input.type ?? existing?.type ?? "percent") as DiscountType;
	if (!["percent", "fixed_product", "fixed_cart"].includes(type)) throw PluginRouteError.badRequest("Unknown discount type");
	const amount = Number(input.amount ?? existing?.amount);
	if (!Number.isFinite(amount) || amount <= 0) throw PluginRouteError.badRequest("Amount must be a positive number");
	if (type === "percent" && amount > 100) throw PluginRouteError.badRequest("Percent must be 100 or less");
	const title = String(input.title ?? existing?.title ?? "").trim();
	if (!title) throw PluginRouteError.badRequest("Title is required");
	const rawCode = input.code === undefined ? existing?.code : input.code;
	const code = rawCode ? normalizeCode(String(rawCode)) : null;
	if (code && !/^[A-Z0-9_-]{3,32}$/.test(code)) throw PluginRouteError.badRequest("Codes are 3–32 letters, numbers, - or _");
	if (!code && type === "fixed_cart") throw PluginRouteError.badRequest("Cart-wide fixed discounts need a code (automatic discounts are per product)");
	const now = new Date().toISOString();
	return {
		title,
		code,
		type,
		amount,
		products: input.products === undefined ? (existing?.products ?? []) : list(input.products),
		excludeProducts: input.excludeProducts === undefined ? (existing?.excludeProducts ?? []) : list(input.excludeProducts),
		minSubtotal: input.minSubtotal === undefined ? (existing?.minSubtotal ?? null) : numOrNull(input.minSubtotal),
		maxUses: input.maxUses === undefined ? (existing?.maxUses ?? null) : numOrNull(input.maxUses),
		usesPerCustomer: input.usesPerCustomer === undefined ? (existing?.usesPerCustomer ?? null) : numOrNull(input.usesPerCustomer),
		usedCount: existing?.usedCount ?? 0,
		startsAt: input.startsAt === undefined ? (existing?.startsAt ?? null) : dateOrNull(input.startsAt),
		endsAt: input.endsAt === undefined ? (existing?.endsAt ?? null) : dateOrNull(input.endsAt),
		freeShipping: input.freeShipping === undefined ? (existing?.freeShipping ?? false) : input.freeShipping === true || input.freeShipping === "true",
		active: input.active === undefined ? (existing?.active ?? true) : input.active === true || input.active === "true",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
}

export const newDiscountId = () => ulid();
