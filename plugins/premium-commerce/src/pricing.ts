/**
 * Resolves a checkout line against the product's option fields: validates
 * the submitted values (conditions, choices, design documents), recomputes
 * the unit price from the definition's price deltas, and derives the stock
 * keys (product + tracked choices). The client never sets a price.
 */

import { type DesignDoc, designUploads, displayValue, type FormField, priceDeltas, SINGLE_CHOICE_TYPES, validateFields, visibleFields } from "./fields.js";
import { minorUnits } from "./money.js";
import type { PluginContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import type { Customization, OrderItem, Product } from "./types.js";

export interface ResolvedLine {
	unitAmount: number;
	baseUnitAmount: number;
	options?: Record<string, unknown>;
	optionsDisplay?: Array<{ name: string; label: string; value: string }>;
	extras?: Array<{ label: string; amount: number }>;
	customization?: Customization;
	stockKeys: string[];
}

export const choiceStockKey = (productId: string, field: string, value: string) => `${productId}#${field}=${value}`;

/** Uploads referenced by a line must have come through this store's upload route. */
async function verifyUploads(ctx: PluginContext, mediaIds: string[]): Promise<Map<string, { url: string; storageKey: string }>> {
	const out = new Map<string, { url: string; storageKey: string }>();
	for (const id of new Set(mediaIds)) {
		const rec = await ctx.kv.get<{ url: string; storageKey: string }>(`upload:${id}`);
		if (!rec) throw PluginRouteError.badRequest("An uploaded image is no longer available — please re-upload it");
		out.set(id, rec);
	}
	return out;
}

export async function resolveLine(ctx: PluginContext, product: Product, currency: string, rawOptions: Record<string, unknown> | undefined, customization: { design?: unknown; previewMediaId?: string } | undefined): Promise<ResolvedLine> {
	const fields: FormField[] = product.options ?? [];
	const data: Record<string, unknown> = { ...(rawOptions ?? {}) };
	const designField = fields.find((f) => f.type === "design");
	if (designField) data[designField.name] = customization?.design;

	if (fields.length === 0 && !customization?.design) {
		return { unitAmount: product.unitAmount, baseUnitAmount: product.unitAmount, stockKeys: [product.id] };
	}

	const result = validateFields(fields, data);
	if (!result.valid) throw PluginRouteError.badRequest(`${product.title}: ${result.errors[0]!.message}`);
	const values = result.data;

	const pricing = priceDeltas(fields, values);
	const extras = pricing.lines.map((l) => ({ label: l.label, amount: minorUnits(l.delta, currency) }));
	const unitAmount = product.unitAmount + extras.reduce((n, e) => n + e.amount, 0);
	if (unitAmount < 0) throw PluginRouteError.badRequest(`${product.title}: invalid price`);

	const visible = visibleFields(fields, values);
	const optionsDisplay = visible
		.map((f) => ({ name: f.name, label: f.label, value: displayValue(f, values[f.name]) }))
		.filter((d) => d.value !== "");

	const stockKeys = [product.id];
	for (const f of visible) {
		if (!SINGLE_CHOICE_TYPES.has(f.type)) continue;
		const choice = f.options?.find((o) => o.value === String(values[f.name] ?? ""));
		if (choice && typeof choice.stock === "number") stockKeys.push(choiceStockKey(product.id, f.name, choice.value));
	}

	let custom: Customization | undefined;
	const options: Record<string, unknown> = { ...values };
	if (designField) {
		const doc = values[designField.name] as DesignDoc | undefined;
		delete options[designField.name];
		if (doc) {
			const uploads = await verifyUploads(ctx, [...designUploads(doc), ...(customization?.previewMediaId ? [customization.previewMediaId] : [])]);
			const preview = customization?.previewMediaId ? uploads.get(customization.previewMediaId) : undefined;
			custom = { field: designField.name, design: doc, previewMediaId: customization?.previewMediaId, previewUrl: preview?.url, uploads: Object.fromEntries([...uploads].map(([id, u]) => [id, u.url])) };
		}
	}

	return {
		unitAmount,
		baseUnitAmount: product.unitAmount,
		options: Object.keys(options).length ? options : undefined,
		optionsDisplay: optionsDisplay.length ? optionsDisplay : undefined,
		extras: extras.length ? extras : undefined,
		customization: custom,
		stockKeys,
	};
}

/** " (Size M, Collar V-neck)" for summaries; falls back to raw options. */
export function lineSummary(item: Pick<OrderItem, "optionsDisplay" | "options" | "customization">): string {
	const parts = item.optionsDisplay?.map((d) => `${d.label}: ${d.value}`) ?? Object.entries(item.options ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`);
	if (item.customization && !item.optionsDisplay) parts.push("custom design");
	return parts.length ? ` (${parts.join(", ")})` : "";
}
