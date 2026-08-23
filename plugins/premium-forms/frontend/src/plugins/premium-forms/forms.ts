/**
 * Forms on the frontend (premium-forms plugin).
 *
 * Two ways to put a form on a page:
 *   1. `<CmsForm id="contact" />` in an Astro page — pre-rendered at build.
 *   2. `<div data-cms-form="contact"></div>` anywhere — including page-builder
 *      sections — hydrated here at runtime from the plugin's public definition.
 * Either way, this script handles AJAX submission, inline errors, conditional
 * fields, honeypot pass-through and Turnstile. Progressive: without JS a
 * pre-rendered form still posts normally.
 */
import { getDesign, renderField, setDesign } from "./fields";
import { openDesignStudio } from "./print-builder";
import type { FormField } from "./fields-model";
import { CMS_URL } from "../../config";

// The platform serves this frontend on the site's own domain(s) (the
// worker proxies the Pages build), so the CMS is same-origin everywhere
// except off-domain previews (github.io, localhost) which use CMS_URL.
const offDomain = typeof location !== "undefined" && /(^|\.)github\.io$|^localhost$|^127\.|^0\.0\.0\.0$/.test(location.hostname);
const API = offDomain ? CMS_URL : "";
const BASE = `${API}/_emdash/api/plugins/premium-forms`;

interface Field {
	name: string; label: string; type: string; required?: boolean; placeholder?: string; helpText?: string;
	defaultValue?: string; options?: Array<{ label: string; value: string }>; width?: string;
	validation?: { minLength?: number; maxLength?: number; min?: number; max?: number; pattern?: string; accept?: string };
	condition?: { field: string; op: string; value?: string };
}
interface Definition {
	name: string; slug: string; pages: Array<{ title?: string; fields: Field[] }>;
	settings: { spamProtection: string; submitLabel?: string; nextLabel?: string; prevLabel?: string };
	_turnstileSiteKey?: string | null;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function unwrap<T>(body: unknown): T {
	const b = body as { data?: T; success?: boolean };
	return (b && typeof b === "object" && "data" in b ? b.data : body) as T;
}

/* ---- render (shared by runtime hydration; CmsForm.astro mirrors this markup) ---- */

export function renderForm(def: Definition, formId: string): string {
	const multi = def.pages.length > 1;
	const pages = def.pages
		.map(
			(p, i) =>
				`<fieldset class="ec-form-page" data-page="${i}" aria-label="${esc(p.title || `Page ${i + 1}`)}">${multi && p.title ? `<legend class="ec-form-page-title">${esc(p.title)}</legend>` : ""}${(p.fields as unknown as FormField[])
					.map((f) => renderField(f, { idPrefix: formId }))
					.join("")}</fieldset>`,
		)
		.join("");
	// Design fields need their configuration at runtime (the studio); it travels with the form.
	const designFields = def.pages.flatMap((p) => p.fields as unknown as FormField[]).filter((f) => f.type === "design" && f.design);
	const designConfigs = designFields.map((f) => `<script type="application/json" data-design-config="${esc(f.name)}">${JSON.stringify(f.design).replace(/</g, "\\u003c")}</script>`).join("");
	const honeypot = def.settings.spamProtection === "honeypot" ? `<div class="ec-form-field" style="position:absolute;left:-9999px" aria-hidden="true"><label for="${formId}-_hp">Leave blank</label><input type="text" id="${formId}-_hp" name="_hp" tabindex="-1" autocomplete="off"></div>` : "";
	const turnstile = def.settings.spamProtection === "turnstile" && def._turnstileSiteKey ? `<div class="ec-form-turnstile" data-ec-turnstile data-sitekey="${esc(def._turnstileSiteKey)}"></div>` : "";
	return `<form class="ec-form" method="POST" action="${BASE}/submit" data-form-id="${esc(formId)}" data-ec-form data-submit-label="${esc(def.settings.submitLabel || "Submit")}" data-design-fields="${esc(designFields.map((f) => f.name).join(","))}">${pages}${designConfigs}${honeypot}${turnstile}<input type="hidden" name="formId" value="${esc(formId)}"><div class="ec-form-nav"><button type="submit" class="ec-form-submit">${esc(def.settings.submitLabel || "Submit")}</button></div><div class="ec-form-status" data-form-status aria-live="polite"></div></form>`;
}

/* ---- runtime hydration of placeholders ---- */

async function hydratePlaceholders() {
	for (const el of document.querySelectorAll<HTMLElement>("[data-cms-form]")) {
		if (el.dataset.cmsFormReady) continue;
		el.dataset.cmsFormReady = "1";
		const slug = el.dataset.cmsForm!;
		try {
			// A cold CMS isolate can answer 404 on its very first request while it
			// loads marketplace plugins — retry once before giving up.
			let res = await fetch(`${BASE}/definition?id=${encodeURIComponent(slug)}`);
			if (res.status === 404) {
				await new Promise((r) => setTimeout(r, 1500));
				res = await fetch(`${BASE}/definition?id=${encodeURIComponent(slug)}`);
			}
			if (!res.ok) throw new Error(String(res.status));
			const def = unwrap<Definition>(await res.json());
			el.innerHTML = renderForm(def, slug);
			initForm(el.querySelector<HTMLFormElement>("[data-ec-form]")!);
		} catch {
			el.innerHTML = `<p class="ec-form-status ec-form-status--error">This form is not available right now.</p>`;
		}
	}
}

/* ---- behaviour ---- */

function initDesignFields(form: HTMLFormElement) {
	form.addEventListener("click", async (e) => {
		const t = (e.target as HTMLElement).closest<HTMLElement>("[data-design-open],[data-design-clear]");
		if (!t) return;
		e.preventDefault();
		const name = t.dataset.designOpen ?? t.dataset.designClear!;
		const cfgEl = form.querySelector<HTMLScriptElement>(`script[data-design-config="${CSS.escape(name)}"]`);
		if (!cfgEl) return;
		const summary = form.querySelector<HTMLElement>(`[data-design-summary="${CSS.escape(name)}"]`);
		if (t.dataset.designClear !== undefined) {
			setDesign(form, name, null);
			if (summary) summary.textContent = "";
			return;
		}
		const existing = getDesign(form, name);
		const result = await openDesignStudio(JSON.parse(cfgEl.textContent || "{}"), existing?.design ?? null, { uploadUrl: `${API}/_emdash/api/plugins/premium-commerce/upload` });
		if (result) {
			setDesign(form, name, result);
			if (summary) summary.innerHTML = `${result.previewDataUrl ? `<img class="ec-design__thumb" src="${result.previewDataUrl}" alt="">` : ""}<span>Design added (${result.design.layers.length} layers)</span> <button type="button" class="ec-link" data-design-open="${esc(name)}">Edit</button> <button type="button" class="ec-link" data-design-clear="${esc(name)}">Remove</button>`;
		}
	});
}

/** Draw-to-sign pads: the PNG data URL lands in the hidden input the form posts. */
export function initSignaturePads(container: ParentNode) {
	container.querySelectorAll<HTMLElement>("[data-signature]").forEach((wrap) => {
		if (wrap.dataset.ready) return;
		wrap.dataset.ready = "1";
		const canvas = wrap.querySelector<HTMLCanvasElement>("canvas")!;
		const input = wrap.querySelector<HTMLInputElement>("input[type=hidden]")!;
		const ctx = canvas.getContext("2d")!;
		const fit = () => {
			const w = wrap.clientWidth || 600;
			const ratio = window.devicePixelRatio || 1;
			canvas.width = Math.round(w * ratio);
			canvas.height = Math.round((w / 3) * ratio);
			canvas.style.width = `${w}px`;
			canvas.style.height = `${w / 3}px`;
			ctx.scale(ratio, ratio);
			ctx.lineWidth = 2.2;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.strokeStyle = "#111";
		};
		fit();
		let drawing = false;
		let strokes = 0;
		const pos = (e: PointerEvent) => {
			const r = canvas.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		canvas.addEventListener("pointerdown", (e) => {
			drawing = true;
			canvas.setPointerCapture(e.pointerId);
			const p = pos(e);
			ctx.beginPath();
			ctx.moveTo(p.x, p.y);
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!drawing) return;
			const p = pos(e);
			ctx.lineTo(p.x, p.y);
			ctx.stroke();
			strokes++;
		});
		const end = () => {
			if (!drawing) return;
			drawing = false;
			if (strokes > 0) {
				input.value = canvas.toDataURL("image/png");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		};
		canvas.addEventListener("pointerup", end);
		canvas.addEventListener("pointercancel", end);
		canvas.addEventListener("pointerleave", end);
		wrap.querySelector("[data-signature-clear]")?.addEventListener("click", () => {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			strokes = 0;
			input.value = "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		if (input.required) {
			input.type = "text";
			input.setAttribute("tabindex", "-1");
			input.setAttribute("aria-hidden", "true");
			input.classList.add("ec-signature__value");
			input.setCustomValidity("");
		}
	});
}

/** Drafts survive accidental navigation: plain inputs are saved per form in localStorage until submitted. */
function initAutosave(form: HTMLFormElement) {
	const key = `pcx-form-draft:${form.dataset.formId ?? form.action}`;
	const skip = (el: Element) => el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "file" || el.type === "password" || el.classList.contains("ec-signature__value"));
	try {
		const saved = JSON.parse(localStorage.getItem(key) || "null") as Record<string, unknown> | null;
		if (saved) {
			for (const [name, v] of Object.entries(saved)) {
				const els = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${CSS.escape(name)}"]`);
				els.forEach((el) => {
					if (skip(el)) return;
					if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) el.checked = Array.isArray(v) ? v.includes(el.value) : v === el.value || v === true;
					else el.value = String(v ?? "");
				});
			}
			evaluateConditions(form);
		}
	} catch {}
	let t: ReturnType<typeof setTimeout> | undefined;
	form.addEventListener("input", () => {
		clearTimeout(t);
		t = setTimeout(() => {
			const data: Record<string, unknown> = {};
			form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach((el) => {
				if (!el.name || skip(el)) return;
				if (el instanceof HTMLInputElement && el.type === "radio") {
					if (el.checked) data[el.name] = el.value;
				} else if (el instanceof HTMLInputElement && el.type === "checkbox") {
					const cur = data[el.name];
					if (el.checked) data[el.name] = Array.isArray(cur) ? [...cur, el.value] : cur ? [cur, el.value] : el.value;
				} else data[el.name] = el.value;
			});
			try {
				localStorage.setItem(key, JSON.stringify(data));
			} catch {}
		}, 400);
	});
	form.addEventListener("pcx:submitted", () => {
		try {
			localStorage.removeItem(key);
		} catch {}
	});
}

function initForm(form: HTMLFormElement) {
	if (form.dataset.designFields) initDesignFields(form);
	if (!form || form.dataset.ecInitialized) return;
	form.dataset.ecInitialized = "1";
	initSignaturePads(form);
	initAutosave(form);
	evaluateConditions(form);
	form.addEventListener("input", () => evaluateConditions(form));
	form.addEventListener("change", () => evaluateConditions(form));
	initTurnstile(form);
}

async function handleSubmit(e: Event) {
	const form = (e.target as HTMLElement).closest<HTMLFormElement>("[data-ec-form]");
	if (!form) return;
	e.preventDefault();
	let valid = true;
	form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach((input) => {
		if (!input.disabled && !input.checkValidity()) {
			valid = false;
			showFieldError(form, input.name, input.validationMessage);
		}
	});
	if (!valid) return;
	const btn = form.querySelector<HTMLButtonElement>(".ec-form-submit");
	if (btn) {
		btn.disabled = true;
		btn.textContent = "Submitting…";
	}
	form.querySelectorAll("[data-error-for]").forEach((el) => (el.textContent = ""));
	showStatus(form, "", "success");
	try {
		const formData = new FormData(form);
		let formId = form.dataset.formId ?? "";
		const data: Record<string, unknown> = {};
		const seen = new Set<string>();
		for (const [key, val] of formData) {
			if (typeof val !== "string") continue;
			if (key === "formId") formId = val;
			else if (seen.has(key)) {
				const cur = data[key];
				data[key] = Array.isArray(cur) ? [...cur, val] : [cur, val];
			} else {
				seen.add(key);
				data[key] = val;
			}
		}
		for (const name of (form.dataset.designFields ?? "").split(",").filter(Boolean)) {
			const d = getDesign(form, name);
			if (d) data[name] = d.design;
		}
		const res = await fetch(form.action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ formId, data }) });
		const result = unwrap<{ success?: boolean; message?: string; redirect?: string; errors?: Array<{ field: string; message: string }> }>(await res.json());
		if (result.success) {
			if (result.redirect && /^(https?:|mailto:|tel:|\/)/.test(result.redirect)) {
				window.location.href = result.redirect;
				return;
			}
			showStatus(form, result.message || "Submitted. Thank you!", "success");
			form.dispatchEvent(new Event("pcx:submitted"));
			form.reset();
		} else if (result.errors) {
			for (const err of result.errors) showFieldError(form, err.field, err.message);
		} else {
			showStatus(form, "Something went wrong. Please try again.", "error");
		}
	} catch {
		showStatus(form, "Network error. Please try again.", "error");
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.textContent = form.dataset.submitLabel || "Submit";
		}
	}
}

function showFieldError(form: HTMLFormElement, name: string, message: string) {
	const el = form.querySelector(`[data-error-for="${CSS.escape(name)}"]`);
	if (el) el.textContent = message;
}

function showStatus(form: HTMLFormElement, message: string, type: "success" | "error") {
	const el = form.querySelector("[data-form-status]");
	if (!el) return;
	el.textContent = message;
	el.className = message ? `ec-form-status ec-form-status--${type}` : "ec-form-status";
}

function evaluateConditions(form: HTMLFormElement) {
	form.querySelectorAll<HTMLElement>("[data-condition]").forEach((wrapper) => {
		try {
			const c = JSON.parse(wrapper.dataset.condition || "{}") as { field: string; op: string; value?: string };
			const input = form.elements.namedItem(c.field) as HTMLInputElement | null;
			if (!input) return;
			const v = input.value;
			const visible = c.op === "eq" ? v === (c.value ?? "") : c.op === "neq" ? v !== (c.value ?? "") : c.op === "filled" ? v !== "" : c.op === "empty" ? v === "" : true;
			wrapper.hidden = !visible;
			wrapper.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((el) => (el.disabled = !visible));
		} catch {
			/* show field */
		}
	});
}

function initTurnstile(form: HTMLFormElement) {
	const container = form.querySelector<HTMLElement>("[data-ec-turnstile]");
	const siteKey = container?.dataset.sitekey;
	if (!container || !siteKey) return;
	const render = () => {
		const w = window as unknown as { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => void } };
		w.turnstile?.render(container, { sitekey: siteKey });
	};
	if (document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) render();
	else {
		const s = document.createElement("script");
		s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		s.async = true;
		s.onload = render;
		document.head.appendChild(s);
	}
}

function init() {
	document.querySelectorAll<HTMLFormElement>("[data-ec-form]").forEach(initForm);
	void hydratePlaceholders();
}
// This module is also imported by CmsForm.astro at BUILD time (for
// renderForm); only touch the DOM in a browser.
if (typeof document !== "undefined") {
	document.addEventListener("submit", handleSubmit);
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
}
