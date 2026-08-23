/**
 * Product options on the product page: renders the product's option fields
 * (shared renderer), keeps conditions and the live price in sync, and hands
 * the validated values + design to the add-to-cart flow. The server
 * re-validates and re-prices every line at checkout.
 */
import { applyConditions, getDesign, readValues, renderField, setDesign, showErrors } from "../premium-forms/fields";
import { type DesignDoc, type FormField, priceDeltas, validateFields, visibleFields, displayValue } from "../premium-forms/fields-model";
import { openDesignStudio } from "../premium-forms/print-builder";

export interface ProductOptionsConfig {
	slug: string;
	productId: string;
	basePrice: number;
	currency: string;
	fields: FormField[];
}
export interface CollectedOptions {
	options: Record<string, unknown>;
	optionsDisplay: Array<{ label: string; value: string }>;
	customization?: { design: DesignDoc; previewMediaId?: string; previewDataUrl?: string };
	/** Unit price including option deltas (major units), for display only. */
	price: number;
}

const registry = new Map<string, { cfg: ProductOptionsConfig; el: HTMLElement; refresh?: () => void }>();

/** Catalog sale prices replace the page's base price (automatic discounts). */
export function setBasePrice(slug: string, price: number): void {
	const e = registry.get(slug);
	if (!e || e.cfg.basePrice === price) return;
	e.cfg.basePrice = price;
	e.refresh?.();
}

function money(currency: string): (n: number) => string {
	const zero = new Set(["jpy", "krw", "vnd", "clp", "isk", "huf"]);
	const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: zero.has(currency.toLowerCase()) ? 0 : 2 });
	return (n: number) => fmt.format(n);
}

export function mountProductOptions(el: HTMLElement, uploadUrl: string): void {
	const script = el.querySelector<HTMLScriptElement>("script[type='application/json']");
	if (!script) return;
	let cfg: ProductOptionsConfig;
	try {
		cfg = JSON.parse(script.textContent || "{}") as ProductOptionsConfig;
	} catch {
		return;
	}
	if (!cfg.fields?.length) return;
	const fmt = money(cfg.currency || "usd");
	const deltaFmt = (d: number) => `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}`;
	const form = document.createElement("div");
	form.className = "ec-product-options";
	form.innerHTML = cfg.fields.map((f) => renderField(f, { idPrefix: `po-${cfg.slug}`, money: deltaFmt })).join("");
	el.appendChild(form);
	registry.set(cfg.slug, { cfg, el: form });

	const priceEl = document.querySelector<HTMLElement>(`[data-product-price="${CSS.escape(cfg.slug)}"]`) ?? document.querySelector<HTMLElement>("[data-product-price]");
	const refresh = () => {
		const values = applyConditions(form, cfg.fields, readValues(form, cfg.fields));
		const { total } = priceDeltas(cfg.fields, values);
		if (priceEl) priceEl.textContent = fmt(cfg.basePrice + total);
		for (const f of cfg.fields) {
			if (f.type !== "design") continue;
			const summary = form.querySelector<HTMLElement>(`[data-design-summary="${CSS.escape(f.name)}"]`);
			const d = getDesign(form, f.name);
			if (summary) summary.innerHTML = d ? `${d.previewDataUrl ? `<img class="ec-design__thumb" src="${d.previewDataUrl}" alt="">` : ""}<span>${displayValue(f, d.design)}</span> <button type="button" class="ec-link" data-design-open="${f.name}">Edit</button> <button type="button" class="ec-link" data-design-clear="${f.name}">Remove</button>` : "";
			const open = form.querySelector<HTMLElement>(`.ec-design__open[data-design-open="${CSS.escape(f.name)}"]`);
			if (open) open.hidden = !!d;
		}
	};
	registry.get(cfg.slug)!.refresh = refresh;
	form.addEventListener("input", refresh);
	form.addEventListener("change", refresh);
	form.addEventListener("click", async (e) => {
		const t = (e.target as HTMLElement).closest<HTMLElement>("[data-design-open],[data-design-clear]");
		if (!t) return;
		const name = t.dataset.designOpen ?? t.dataset.designClear!;
		const field = cfg.fields.find((f) => f.name === name && f.type === "design");
		if (!field?.design) return;
		if (t.dataset.designClear !== undefined) {
			setDesign(form, name, null);
			return;
		}
		const existing = getDesign(form, name);
		const result = await openDesignStudio(field.design, existing?.design ?? null, { uploadUrl, money: deltaFmt, title: `${field.label}` });
		if (result) setDesign(form, name, result);
	});
	refresh();
}

/** Validated options for a product (null when the page has no options for it); shows inline errors when invalid. */
export function collectOptions(slug: string): CollectedOptions | { error: string } | null {
	const entry = registry.get(slug);
	if (!entry) return null;
	const { cfg, el } = entry;
	const values = applyConditions(el, cfg.fields, readValues(el, cfg.fields));
	const result = validateFields(cfg.fields, values);
	if (!result.valid) {
		showErrors(el, result.errors);
		return { error: result.errors[0]!.message };
	}
	showErrors(el, []);
	const { total } = priceDeltas(cfg.fields, result.data);
	const options: Record<string, unknown> = { ...result.data };
	let customization: CollectedOptions["customization"];
	for (const f of visibleFields(cfg.fields, result.data)) {
		if (f.type !== "design") continue;
		delete options[f.name];
		const d = getDesign(el, f.name);
		if (d) customization = { design: d.design, previewMediaId: d.previewMediaId, previewDataUrl: d.previewDataUrl };
	}
	const optionsDisplay = visibleFields(cfg.fields, result.data)
		.map((f) => ({ label: f.label, value: displayValue(f, result.data[f.name]) }))
		.filter((d) => d.value);
	return { options, optionsDisplay, customization, price: cfg.basePrice + total };
}

export function initProductOptions(uploadUrl: string): void {
	document.querySelectorAll<HTMLElement>("[data-product-options]").forEach((el) => mountProductOptions(el, uploadUrl));
}
