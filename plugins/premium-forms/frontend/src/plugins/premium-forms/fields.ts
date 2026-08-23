/**
 * Field renderer shared by forms and product options: HTML for each field
 * type, value collection, conditional visibility and price labels.
 */
import { type DesignDoc, evaluateCondition, type FormField, SINGLE_CHOICE_TYPES } from "./fields-model";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface RenderOptions {
	idPrefix: string;
	/** Formats a price delta, e.g. 2.5 → "+$2.50". */
	money?: (delta: number) => string;
	values?: Record<string, unknown>;
}

const deltaTag = (delta: number | undefined, money?: (d: number) => string) => (delta && money ? ` <span class="ec-price-delta">${esc(money(delta))}</span>` : "");

export function renderFieldInput(f: FormField, o: RenderOptions): string {
	const id = `${o.idPrefix}-${f.name}`;
	const name = esc(f.name);
	const req = f.required ? " required" : "";
	const val = o.values?.[f.name];
	const current = val === undefined ? (f.defaultValue ?? "") : String(val);
	const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "";
	switch (f.type) {
		case "textarea":
			return `<textarea class="ec-form-input" id="${id}" name="${name}"${ph}${req} rows="3">${esc(current)}</textarea>`;
		case "select":
			return `<select class="ec-form-input" id="${id}" name="${name}"${req}><option value="">${esc(f.placeholder ?? "Choose…")}</option>${(f.options ?? []).map((opt) => `<option value="${esc(opt.value)}"${opt.value === current ? " selected" : ""}>${esc(opt.label)}${opt.priceDelta && o.money ? ` (${esc(o.money(opt.priceDelta))})` : ""}</option>`).join("")}</select>`;
		case "radio":
		case "checkbox-group": {
			const type = f.type === "radio" ? "radio" : "checkbox";
			const chosen = new Set(Array.isArray(val) ? val.map(String) : current ? [current] : []);
			return `<div class="ec-choice-list" role="group">${(f.options ?? [])
				.map(
					(opt, i) =>
						`<label class="ec-choice"><input type="${type}" name="${name}" value="${esc(opt.value)}" id="${id}-${i}"${chosen.has(opt.value) ? " checked" : ""}${f.required && type === "radio" ? " required" : ""}><span class="ec-choice__label">${esc(opt.label)}${deltaTag(opt.priceDelta, o.money)}</span>${opt.description ? `<span class="ec-choice__desc">${esc(opt.description)}</span>` : ""}</label>`,
				)
				.join("")}</div>`;
		}
		case "checkbox":
			return `<label class="ec-choice ec-choice--single"><input type="checkbox" name="${name}" value="true" id="${id}"${val === true ? " checked" : ""}${req}><span class="ec-choice__label">${esc(f.placeholder ?? f.label)}${deltaTag(f.priceDelta, o.money)}</span></label>`;
		case "swatch":
			return `<div class="ec-swatches" role="radiogroup">${(f.options ?? [])
				.map(
					(opt, i) =>
						`<label class="ec-swatch" title="${esc(opt.label)}"><input type="radio" name="${name}" value="${esc(opt.value)}" id="${id}-${i}"${opt.value === current ? " checked" : ""}${req}><span class="ec-swatch__chip" style="${opt.color ? `background:${esc(opt.color)}` : ""}${opt.image ? `;background-image:url('${esc(opt.image)}')` : ""}"></span><span class="ec-swatch__label">${esc(opt.label)}${deltaTag(opt.priceDelta, o.money)}</span></label>`,
				)
				.join("")}</div>`;
		case "image-choice":
			return `<div class="ec-image-choices" role="radiogroup">${(f.options ?? [])
				.map(
					(opt, i) =>
						`<label class="ec-image-choice"><input type="radio" name="${name}" value="${esc(opt.value)}" id="${id}-${i}"${opt.value === current ? " checked" : ""}${req}>${opt.image ? `<img src="${esc(opt.image)}" alt="" loading="lazy">` : `<span class="ec-image-choice__blank"></span>`}<span class="ec-image-choice__label">${esc(opt.label)}${deltaTag(opt.priceDelta, o.money)}</span></label>`,
				)
				.join("")}</div>`;
		case "file":
			return `<input type="file" class="ec-form-input" id="${id}" name="${name}"${req}${f.validation?.accept ? ` accept="${esc(f.validation.accept)}"` : ""}>`;
		case "hidden":
			return `<input type="hidden" name="${name}" value="${esc(current)}">`;
		case "signature":
			return `<div class="ec-signature" data-signature="${name}"><canvas class="ec-signature__pad" width="600" height="200" aria-label="${esc(f.label)} — draw your signature"></canvas><input type="hidden" name="${name}" id="${id}" value="${esc(current)}"${req}><div class="ec-signature__bar"><span class="ec-signature__hint">Sign above with your mouse or finger</span><button type="button" class="ec-signature__clear" data-signature-clear>Clear</button></div></div>`;
		case "consent":
			return `<label class="ec-choice ec-choice--single ec-consent"><input type="checkbox" name="${name}" value="true" id="${id}"${val === true || val === "true" ? " checked" : ""}${req}><span class="ec-choice__label">${esc(f.placeholder ?? f.label)}</span></label>`;
		case "design":
			return `<div class="ec-design" data-design-field="${name}"><button type="button" class="ec-add-to-cart ec-design__open" data-design-open="${name}">Open the design studio</button><div class="ec-design__summary" data-design-summary="${name}"></div></div>`;
		default:
			return `<input type="${f.type === "tel" ? "tel" : f.type}" class="ec-form-input" id="${id}" name="${name}" value="${esc(current)}"${ph}${req}>`;
	}
}

export function renderField(f: FormField, o: RenderOptions): string {
	const id = `${o.idPrefix}-${f.name}`;
	const labelled = f.type !== "checkbox" && f.type !== "hidden" && f.type !== "consent";
	const priced = !SINGLE_CHOICE_TYPES.has(f.type) && f.type !== "checkbox-group" && f.type !== "checkbox" && f.priceDelta ? deltaTag(f.priceDelta, o.money) : "";
	return `<div class="ec-form-field ec-form-field--${esc(f.type)}${f.width === "half" ? " ec-form-field--half" : ""}" data-field="${esc(f.name)}"${f.condition ? ` data-condition='${esc(JSON.stringify(f.condition))}'` : ""}>${
		labelled ? `<label class="ec-form-label" for="${id}">${esc(f.label)}${f.required ? ' <span class="ec-form-required">*</span>' : ""}${priced}</label>` : ""
	}${renderFieldInput(f, o)}${f.helpText ? `<p class="ec-form-help">${esc(f.helpText)}</p>` : ""}<p class="ec-form-error" data-error-for="${esc(f.name)}"></p></div>`;
}

/** Design documents live outside the DOM inputs; the studio stores them here by container + field name. */
const designStore = new WeakMap<HTMLElement, Map<string, { design: DesignDoc; previewMediaId?: string; previewDataUrl?: string }>>();
export function setDesign(container: HTMLElement, field: string, value: { design: DesignDoc; previewMediaId?: string; previewDataUrl?: string } | null): void {
	let map = designStore.get(container);
	if (!map) designStore.set(container, (map = new Map()));
	if (value) map.set(field, value);
	else map.delete(field);
	container.dispatchEvent(new Event("input", { bubbles: true }));
}
export function getDesign(container: HTMLElement, field: string) {
	return designStore.get(container)?.get(field) ?? null;
}

/** Current values of the rendered fields (checkbox → boolean, checkbox-group → string[], design → document). */
export function readValues(container: HTMLElement, fields: FormField[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		if (f.type === "design") {
			const d = getDesign(container, f.name);
			if (d) out[f.name] = d.design;
			continue;
		}
		if (f.type === "file") continue;
		const inputs = Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${CSS.escape(f.name)}"]`));
		if (inputs.length === 0) continue;
		if (f.type === "checkbox") out[f.name] = (inputs[0] as HTMLInputElement).checked;
		else if (f.type === "checkbox-group") out[f.name] = inputs.filter((i) => (i as HTMLInputElement).checked).map((i) => i.value);
		else if (inputs[0] instanceof HTMLInputElement && inputs[0].type === "radio") out[f.name] = inputs.find((i) => (i as HTMLInputElement).checked)?.value ?? "";
		else out[f.name] = inputs[0].value;
	}
	return out;
}

/** Show/hide fields by their conditions; returns the values of the visible ones. */
export function applyConditions(container: HTMLElement, fields: FormField[], values: Record<string, unknown>): Record<string, unknown> {
	const visible: Record<string, unknown> = {};
	for (const f of fields) {
		const wrap = container.querySelector<HTMLElement>(`[data-field="${CSS.escape(f.name)}"]`);
		const on = !f.condition || evaluateCondition(f.condition, values);
		if (wrap) {
			wrap.hidden = !on;
			wrap.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((i) => (i.disabled = !on));
		}
		if (on && values[f.name] !== undefined) visible[f.name] = values[f.name];
	}
	return visible;
}

export function showErrors(container: HTMLElement, errors: Array<{ field: string; message: string }>): void {
	container.querySelectorAll<HTMLElement>("[data-error-for]").forEach((el) => (el.textContent = ""));
	for (const e of errors) {
		const el = container.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(e.field)}"]`);
		if (el) el.textContent = e.message;
	}
	const first = container.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(errors[0]?.field ?? "")}"]`);
	first?.closest<HTMLElement>("[data-field]")?.scrollIntoView({ block: "center", behavior: "smooth" });
}
