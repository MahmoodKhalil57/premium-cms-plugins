/**
 * Shared field model for the Forms and Commerce plugins (and the storefront).
 *
 * A form, and a product's configurable options, are both a list of fields:
 * inputs with validation, conditional visibility and — new here — pricing:
 * a choice or a filled field can add to the price (WooCommerce attributes
 * and add-ons expressed as WPForms-style fields). `design` fields hold a
 * structured print design (layers on a print area) that is validated here
 * and can be exported to SVG for production.
 *
 * Everything in this file is authoritative on the server; the storefront
 * only mirrors it for instant feedback.
 */

export const FIELD_TYPES = ["text", "email", "textarea", "number", "tel", "url", "date", "select", "radio", "checkbox", "checkbox-group", "file", "hidden", "swatch", "image-choice", "design", "signature", "consent"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose value is one choice out of `options`. */
export const SINGLE_CHOICE_TYPES: ReadonlySet<string> = new Set(["select", "radio", "swatch", "image-choice"]);

export interface FieldOption {
	label: string;
	value: string;
	/** Price added when chosen (major units of the store currency, e.g. 2.5). */
	priceDelta?: number;
	/** Image URL for image-choice / swatch chips. */
	image?: string;
	/** CSS colour for swatch chips. */
	color?: string;
	sku?: string;
	/** Stock for this choice (null/undefined = not tracked per choice). */
	stock?: number | null;
	description?: string;
}

export interface FieldValidation {
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: string;
	patternMessage?: string;
	/** File types, e.g. ".pdf,.doc" or "image/*" */
	accept?: string;
	maxFileSize?: number;
}

export interface FieldCondition {
	/** Name of the controlling field */
	field: string;
	op: "eq" | "neq" | "filled" | "empty" | "in" | "nin";
	/** For in/nin: comma-separated values */
	value?: string;
}

export interface DesignArea {
	id: string;
	label: string;
	/** Print area size in design units (px at 72 dpi is fine; only ratios matter for preview). */
	width: number;
	height: number;
	/** Garment mockup shown under the print area in the builder. */
	previewImage?: string;
	/** Where the print area sits on the mockup, in % of the image. */
	printBox?: { x: number; y: number; w: number; h: number };
}

export interface DesignPreset {
	id: string;
	label: string;
	image: string;
	priceDelta?: number;
}

export interface DesignConfig {
	areas: DesignArea[];
	presets?: DesignPreset[];
	allowText?: boolean;
	allowUpload?: boolean;
	allowShapes?: boolean;
	/** Font whitelist (defaults to DESIGN_FONTS). */
	fonts?: string[];
	/** Colour swatches offered for text/shapes; any hex colour is still accepted. */
	colors?: string[];
	maxLayers?: number;
	uploadMaxBytes?: number;
	/** Added once when the design has any text layer / any uploaded image. */
	textPriceDelta?: number;
	uploadPriceDelta?: number;
}

export interface FormField {
	id: string;
	type: FieldType;
	label: string;
	/** Input name, unique per form/product */
	name: string;
	placeholder?: string;
	helpText?: string;
	required: boolean;
	validation?: FieldValidation;
	/** For select, radio, checkbox-group, swatch, image-choice */
	options?: FieldOption[];
	defaultValue?: string;
	width: "full" | "half";
	condition?: FieldCondition;
	/** Price added when this field is filled / checked (major units). Choices use FieldOption.priceDelta. */
	priceDelta?: number;
	/** For design fields. */
	design?: DesignConfig;
}

/* ---- design documents ---------------------------------------------------- */

export const DESIGN_FONTS = ["Inter", "Arial", "Arial Black", "Georgia", "Impact", "Courier New", "Trebuchet MS", "Verdana", "Times New Roman"];
export const DESIGN_LIMITS = { maxLayers: 12, maxText: 120, maxSize: 4000, maxFontSize: 400 };

export interface TextLayer {
	id: string;
	type: "text";
	text: string;
	font: string;
	size: number;
	color: string;
	x: number;
	y: number;
	rotation?: number;
	align?: "left" | "center" | "right";
	weight?: "normal" | "bold";
}
export interface ImageLayer {
	id: string;
	type: "image";
	source: { kind: "preset"; id: string } | { kind: "upload"; mediaId: string };
	x: number;
	y: number;
	w: number;
	h: number;
	rotation?: number;
}
export interface ShapeLayer {
	id: string;
	type: "shape";
	shape: "rect" | "circle";
	fill: string;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation?: number;
}
export type DesignLayer = TextLayer | ImageLayer | ShapeLayer;

export interface DesignDoc {
	version: 1;
	area: string;
	width: number;
	height: number;
	background?: string;
	layers: DesignLayer[];
}

/* ---- conditions ------------------------------------------------------------ */

function asStrings(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (v === undefined || v === null || v === "" || v === false) return [];
	if (v === true) return ["true"];
	if (typeof v === "object") return ["[object]"];
	return [String(v)];
}

export function evaluateCondition(c: FieldCondition, data: Record<string, unknown>): boolean {
	const values = asStrings(data[c.field]);
	const filled = values.length > 0;
	switch (c.op) {
		case "filled":
			return filled;
		case "empty":
			return !filled;
		case "eq":
			return values.includes(c.value ?? "");
		case "neq":
			return !values.includes(c.value ?? "");
		case "in": {
			const set = (c.value ?? "").split(",").map((s) => s.trim());
			return values.some((v) => set.includes(v));
		}
		case "nin": {
			const set = (c.value ?? "").split(",").map((s) => s.trim());
			return !values.some((v) => set.includes(v));
		}
		default:
			return true;
	}
}

/** Fields that apply given the current values (hidden-by-condition fields are dropped, in order). */
export function visibleFields(fields: FormField[], data: Record<string, unknown>): FormField[] {
	return fields.filter((f) => !f.condition || evaluateCondition(f.condition, data));
}

/* ---- validation ------------------------------------------------------------ */

export interface ValidationError {
	field: string;
	message: string;
}
export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	/** Sanitized/coerced values of visible fields only. */
	data: Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/;
const TEL_RE = /^[+\d][\d\s()-]*$/;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateFields(fields: FormField[], data: Record<string, unknown>): ValidationResult {
	const errors: ValidationError[] = [];
	const validated: Record<string, unknown> = {};
	for (const field of fields) {
		if (field.condition && !evaluateCondition(field.condition, data)) continue;
		const raw = data[field.name];
		const value = typeof raw === "string" ? raw.trim() : raw;
		const isEmpty = value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0);
		if (field.required && isEmpty) {
			errors.push({ field: field.name, message: `${field.label} is required` });
			continue;
		}
		if (isEmpty) continue;
		const typeError = validateFieldType(field, value);
		if (typeError) {
			errors.push({ field: field.name, message: typeError });
			continue;
		}
		const ruleErrors = validateFieldRules(field, value);
		for (const msg of ruleErrors) errors.push({ field: field.name, message: msg });
		if (ruleErrors.length === 0) validated[field.name] = coerceValue(field, value);
	}
	return { valid: errors.length === 0, errors, data: validated };
}

function validateFieldType(field: FormField, value: unknown): string | null {
	if (field.type === "design") {
		const errs = validateDesign(value, field.design);
		return errs.length ? `${field.label}: ${errs[0]}` : null;
	}
	if (field.type === "checkbox-group") {
		const values = Array.isArray(value) ? value : [value];
		const valid = new Set((field.options ?? []).map((o) => o.value));
		for (const v of values) if (!valid.has(String(v))) return `${field.label} contains an invalid selection`;
		return null;
	}
	if (field.type === "checkbox") {
		if (value === true || value === false || value === "true" || value === "false" || value === "on" || value === "1" || value === "0" || value === "") return null;
		return `${field.label} has an invalid value`;
	}
	if (field.type === "file") {
		return typeof value === "string" || (typeof value === "object" && value !== null) ? null : `${field.label} has an invalid value`;
	}
	if (field.type === "signature") {
		if (typeof value !== "string" || !value.startsWith("data:image/png;base64,") || value.length > 200_000) return `${field.label} must be a drawn signature`;
		return null;
	}
	if (field.type === "consent") {
		if (value === true || value === "true" || value === "on" || value === "1") return null;
		return field.required ? `${field.label} must be accepted` : value === false || value === "false" || value === "" || value === undefined ? null : `${field.label} has an invalid value`;
	}
	if (typeof value !== "string" && field.type !== "number") return `${field.label} has an invalid value`;
	const str = String(value);
	switch (field.type) {
		case "email":
			return EMAIL_RE.test(str) ? null : `${field.label} must be a valid email address`;
		case "url":
			return URL_RE.test(str) ? null : `${field.label} must be a valid URL`;
		case "tel":
			return TEL_RE.test(str) ? null : `${field.label} must be a valid phone number`;
		case "number":
			return Number.isNaN(Number(value)) ? `${field.label} must be a number` : null;
		case "date":
			return Number.isNaN(Date.parse(str)) ? `${field.label} must be a valid date` : null;
		case "select":
		case "radio":
		case "swatch":
		case "image-choice":
			return field.options && !field.options.some((o) => o.value === str) ? `${field.label} has an invalid selection` : null;
		default:
			return null;
	}
}

function validateFieldRules(field: FormField, value: unknown): string[] {
	const out: string[] = [];
	const v = field.validation;
	if (!v) {
		if ((field.type === "text" || field.type === "textarea") && String(value).length > 5000) out.push(`${field.label} is too long`);
		return out;
	}
	if (typeof value === "string") {
		if (v.minLength !== undefined && value.length < v.minLength) out.push(`${field.label} must be at least ${v.minLength} characters`);
		if (v.maxLength !== undefined && value.length > v.maxLength) out.push(`${field.label} must be at most ${v.maxLength} characters`);
		if (v.pattern) {
			try {
				if (!new RegExp(v.pattern).test(value)) out.push(v.patternMessage ?? `${field.label} has an invalid format`);
			} catch {
				/* bad pattern in the definition — don't block the user */
			}
		}
	}
	if (field.type === "number") {
		const n = Number(value);
		if (v.min !== undefined && n < v.min) out.push(`${field.label} must be at least ${v.min}`);
		if (v.max !== undefined && n > v.max) out.push(`${field.label} must be at most ${v.max}`);
	}
	return out;
}

function coerceValue(field: FormField, value: unknown): unknown {
	switch (field.type) {
		case "number":
			return Number(value);
		case "checkbox":
			return value === true || value === "true" || value === "on" || value === "1";
		case "checkbox-group":
			return (Array.isArray(value) ? value : [value]).map(String);
		case "design":
			return value;
		default:
			return typeof value === "string" ? value : String(value);
	}
}

/* ---- pricing --------------------------------------------------------------- */

export interface PriceLine {
	field: string;
	label: string;
	/** Major units. */
	delta: number;
}

/** Price added by the chosen options (major units), one line per contributing field. */
export function priceDeltas(fields: FormField[], data: Record<string, unknown>): { total: number; lines: PriceLine[] } {
	const lines: PriceLine[] = [];
	for (const field of visibleFields(fields, data)) {
		const value = data[field.name];
		const empty = value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0);
		if (empty) continue;
		let delta = 0;
		if (SINGLE_CHOICE_TYPES.has(field.type)) {
			delta = field.options?.find((o) => o.value === String(value))?.priceDelta ?? 0;
		} else if (field.type === "checkbox-group") {
			const chosen = new Set((Array.isArray(value) ? value : [value]).map(String));
			delta = (field.options ?? []).filter((o) => chosen.has(o.value)).reduce((n, o) => n + (o.priceDelta ?? 0), 0);
		} else if (field.type === "design") {
			delta = designPriceDelta(value as DesignDoc, field);
		} else {
			delta = field.priceDelta ?? 0;
		}
		if (delta) lines.push({ field: field.name, label: field.label, delta });
	}
	return { total: lines.reduce((n, l) => n + l.delta, 0), lines };
}

function designPriceDelta(doc: DesignDoc, field: FormField): number {
	const cfg = field.design;
	let delta = field.priceDelta ?? 0;
	if (!doc || !cfg) return delta;
	const presets = new Set<string>();
	let hasText = false;
	let hasUpload = false;
	for (const layer of doc.layers ?? []) {
		if (layer.type === "text") hasText = true;
		if (layer.type === "image" && layer.source.kind === "preset") presets.add(layer.source.id);
		if (layer.type === "image" && layer.source.kind === "upload") hasUpload = true;
	}
	for (const id of presets) delta += cfg.presets?.find((p) => p.id === id)?.priceDelta ?? 0;
	if (hasText) delta += cfg.textPriceDelta ?? 0;
	if (hasUpload) delta += cfg.uploadPriceDelta ?? 0;
	return delta;
}

/** Human-readable value for summaries (cart lines, emails, admin). */
export function displayValue(field: FormField, value: unknown): string {
	if (value === undefined || value === null || value === "" || value === false) return "";
	if (SINGLE_CHOICE_TYPES.has(field.type)) return field.options?.find((o) => o.value === String(value))?.label ?? String(value);
	if (field.type === "checkbox-group") {
		const chosen = new Set((Array.isArray(value) ? value : [value]).map(String));
		return (field.options ?? []).filter((o) => chosen.has(o.value)).map((o) => o.label).join(", ");
	}
	if (field.type === "checkbox") return value === true ? "Yes" : "";
	if (field.type === "design") {
		const doc = value as DesignDoc;
		const n = doc?.layers?.length ?? 0;
		const area = doc?.area ? ` on ${doc.area}` : "";
		return `Custom design${area} (${n} layer${n === 1 ? "" : "s"})`;
	}
	if (field.type === "file") return typeof value === "string" ? value : "file";
	if (field.type === "signature") return typeof value === "string" && value.startsWith("data:image/png") ? "Signed" : "";
	if (field.type === "consent") return value === true || value === "true" || value === "on" ? "Accepted" : "Not accepted";
	return String(value);
}

/* ---- design validation ------------------------------------------------------ */

const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export function validateDesign(value: unknown, cfg: DesignConfig | undefined): string[] {
	const errors: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return ["design is not an object"];
	const doc = value as Partial<DesignDoc>;
	if (doc.version !== 1) errors.push("unsupported design version");
	const areas = cfg?.areas ?? [];
	const area = areas.find((a) => a.id === doc.area);
	if (!area) errors.push("unknown print area");
	if (!num(doc.width, 1, DESIGN_LIMITS.maxSize) || !num(doc.height, 1, DESIGN_LIMITS.maxSize)) errors.push("invalid size");
	if (area && (doc.width !== area.width || doc.height !== area.height)) errors.push("size does not match the print area");
	if (doc.background !== undefined && !(typeof doc.background === "string" && HEX_RE.test(doc.background))) errors.push("invalid background colour");
	const layers = Array.isArray(doc.layers) ? doc.layers : null;
	if (!layers) return [...errors, "layers missing"];
	const maxLayers = Math.min(cfg?.maxLayers ?? DESIGN_LIMITS.maxLayers, DESIGN_LIMITS.maxLayers);
	if (layers.length > maxLayers) errors.push(`at most ${maxLayers} layers`);
	if (layers.length === 0) errors.push("the design is empty");
	const fonts = cfg?.fonts?.length ? cfg.fonts : DESIGN_FONTS;
	const w = typeof doc.width === "number" ? doc.width : DESIGN_LIMITS.maxSize;
	const h = typeof doc.height === "number" ? doc.height : DESIGN_LIMITS.maxSize;
	const ids = new Set<string>();
	for (const [i, layer] of layers.entries()) {
		const at = `layer ${i + 1}`;
		if (!layer || typeof layer !== "object") {
			errors.push(`${at} is invalid`);
			continue;
		}
		const l = layer as unknown as Record<string, unknown>;
		if (typeof l.id !== "string" || !ID_RE.test(l.id) || ids.has(l.id)) errors.push(`${at} has an invalid id`);
		else ids.add(l.id);
		if (!num(l.x, -w, 2 * w) || !num(l.y, -h, 2 * h)) errors.push(`${at} is out of bounds`);
		if (l.rotation !== undefined && !num(l.rotation, -360, 360)) errors.push(`${at} has an invalid rotation`);
		if (l.type === "text") {
			if (cfg && cfg.allowText === false) errors.push("text is not allowed in this design");
			if (typeof l.text !== "string" || l.text.trim().length === 0 || l.text.length > DESIGN_LIMITS.maxText) errors.push(`${at} text must be 1–${DESIGN_LIMITS.maxText} characters`);
			if (typeof l.font !== "string" || !fonts.includes(l.font)) errors.push(`${at} uses an unavailable font`);
			if (!num(l.size, 4, DESIGN_LIMITS.maxFontSize)) errors.push(`${at} has an invalid font size`);
			if (typeof l.color !== "string" || !HEX_RE.test(l.color)) errors.push(`${at} has an invalid colour`);
			if (l.align !== undefined && !["left", "center", "right"].includes(String(l.align))) errors.push(`${at} has an invalid alignment`);
			if (l.weight !== undefined && !["normal", "bold"].includes(String(l.weight))) errors.push(`${at} has an invalid weight`);
		} else if (l.type === "image") {
			const src = l.source as Record<string, unknown> | undefined;
			if (!src || typeof src !== "object") errors.push(`${at} has no source`);
			else if (src.kind === "preset") {
				if (typeof src.id !== "string" || !(cfg?.presets ?? []).some((p) => p.id === src.id)) errors.push(`${at} uses an unknown preset`);
			} else if (src.kind === "upload") {
				if (cfg && cfg.allowUpload === false) errors.push("uploads are not allowed in this design");
				if (typeof src.mediaId !== "string" || !ID_RE.test(src.mediaId)) errors.push(`${at} has an invalid upload reference`);
			} else errors.push(`${at} has an invalid source`);
			if (!num(l.w, 1, 2 * w) || !num(l.h, 1, 2 * h)) errors.push(`${at} has an invalid size`);
		} else if (l.type === "shape") {
			if (cfg && cfg.allowShapes === false) errors.push("shapes are not allowed in this design");
			if (!["rect", "circle"].includes(String(l.shape))) errors.push(`${at} has an invalid shape`);
			if (typeof l.fill !== "string" || !HEX_RE.test(l.fill)) errors.push(`${at} has an invalid colour`);
			if (!num(l.w, 1, 2 * w) || !num(l.h, 1, 2 * h)) errors.push(`${at} has an invalid size`);
		} else errors.push(`${at} has an unknown type`);
	}
	return errors;
}

/** Upload references used by a design (to verify they came through the store's upload route). */
export function designUploads(doc: DesignDoc | undefined | null): string[] {
	const out: string[] = [];
	for (const layer of doc?.layers ?? []) if (layer.type === "image" && layer.source.kind === "upload") out.push(layer.source.mediaId);
	return out;
}

/* ---- SVG export ------------------------------------------------------------- */

const escXml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export interface DesignAssetResolver {
	presetUrl(id: string): string | null;
	uploadUrl(mediaId: string): string | null;
}

/** Production-ready SVG of a validated design (images by reference). */
export function designToSvg(doc: DesignDoc, resolve: DesignAssetResolver): string {
	const parts: string[] = [];
	if (doc.background) parts.push(`<rect width="${doc.width}" height="${doc.height}" fill="${escXml(doc.background)}"/>`);
	for (const layer of doc.layers) {
		const rot = layer.rotation ? ` transform="rotate(${layer.rotation} ${layer.x} ${layer.y})"` : "";
		if (layer.type === "text") {
			const anchor = layer.align === "center" ? "middle" : layer.align === "right" ? "end" : "start";
			parts.push(`<text x="${layer.x}" y="${layer.y}" font-family="${escXml(layer.font)}" font-size="${layer.size}" font-weight="${layer.weight ?? "normal"}" fill="${escXml(layer.color)}" text-anchor="${anchor}" dominant-baseline="hanging"${rot}>${escXml(layer.text)}</text>`);
		} else if (layer.type === "image") {
			const href = layer.source.kind === "preset" ? resolve.presetUrl(layer.source.id) : resolve.uploadUrl(layer.source.mediaId);
			if (href) parts.push(`<image href="${escXml(href)}" x="${layer.x}" y="${layer.y}" width="${layer.w}" height="${layer.h}" preserveAspectRatio="xMidYMid meet"${rot}/>`);
		} else if (layer.type === "shape") {
			parts.push(
				layer.shape === "circle"
					? `<ellipse cx="${layer.x + layer.w / 2}" cy="${layer.y + layer.h / 2}" rx="${layer.w / 2}" ry="${layer.h / 2}" fill="${escXml(layer.fill)}"${rot}/>`
					: `<rect x="${layer.x}" y="${layer.y}" width="${layer.w}" height="${layer.h}" fill="${escXml(layer.fill)}"${rot}/>`,
			);
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">${parts.join("")}</svg>`;
}

/* ---- loose parsing of definitions stored as JSON on content ------------------ */

/** Parse a product's `options` field (array or JSON string) into fields, dropping malformed entries. */
export function parseFieldList(raw: unknown): FormField[] {
	let list: unknown = raw;
	if (typeof raw === "string") {
		try {
			list = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(list)) return [];
	const out: FormField[] = [];
	const names = new Set<string>();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const f = item as Record<string, unknown>;
		const type = String(f.type ?? "");
		const name = String(f.name ?? f.id ?? "");
		if (!(FIELD_TYPES as readonly string[]).includes(type) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || names.has(name)) continue;
		names.add(name);
		const options = Array.isArray(f.options)
			? (f.options as unknown[])
					.filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string")
					.map((o) => ({
						value: String(o.value),
						label: String(o.label ?? o.value),
						...(typeof o.priceDelta === "number" ? { priceDelta: o.priceDelta } : {}),
						...(typeof o.image === "string" ? { image: o.image } : {}),
						...(typeof o.color === "string" ? { color: o.color } : {}),
						...(typeof o.sku === "string" ? { sku: o.sku } : {}),
						...(typeof o.stock === "number" ? { stock: o.stock } : {}),
						...(typeof o.description === "string" ? { description: o.description } : {}),
					}))
			: undefined;
		out.push({
			id: String(f.id ?? name),
			type: type as FieldType,
			label: String(f.label ?? name),
			name,
			placeholder: typeof f.placeholder === "string" ? f.placeholder : undefined,
			helpText: typeof f.helpText === "string" ? f.helpText : undefined,
			required: f.required === true,
			validation: f.validation && typeof f.validation === "object" ? (f.validation as FieldValidation) : undefined,
			options,
			defaultValue: typeof f.defaultValue === "string" ? f.defaultValue : undefined,
			width: f.width === "half" ? "half" : "full",
			condition: f.condition && typeof f.condition === "object" ? (f.condition as FieldCondition) : undefined,
			priceDelta: typeof f.priceDelta === "number" ? f.priceDelta : undefined,
			design: type === "design" && f.design && typeof f.design === "object" ? (f.design as DesignConfig) : undefined,
		});
	}
	return out;
}
