/**
 * Site Kit storefront runtime: cookie consent (UK GDPR / PECR), consent-gated
 * analytics (GA4 / GTM), Google reviews feed, before/after slider and FAQ
 * structured data. Configuration is rendered into the page by the layout
 * (`<script id="pcx-site-kit" type="application/json">`).
 */
import { API } from "../../lib/client";

interface Consent { analytics: boolean; marketing: boolean; at: string }
interface Kit {
	analytics: { ga4Id: string | null; gtmId: string | null };
	consent: { title: string; text: string; privacyUrl: string } | null;
}

const KEY = "pcx-consent";
const kit: Kit = (() => {
	try {
		return JSON.parse(document.getElementById("pcx-site-kit")?.textContent || "null") ?? { analytics: {}, consent: null };
	} catch {
		return { analytics: {}, consent: null };
	}
})();

function readConsent(): Consent | null {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as Consent) : null;
	} catch {
		return null;
	}
}
function writeConsent(c: Consent) {
	try {
		localStorage.setItem(KEY, JSON.stringify(c));
	} catch {}
	document.dispatchEvent(new CustomEvent("pcx:consent", { detail: c }));
}

let analyticsLoaded = false;
function loadAnalytics() {
	if (analyticsLoaded) return;
	analyticsLoaded = true;
	const { ga4Id, gtmId } = kit.analytics;
	const w = window as unknown as { dataLayer: unknown[]; gtag?: (...a: unknown[]) => void };
	w.dataLayer = w.dataLayer || [];
	if (gtmId) {
		w.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
		const s = document.createElement("script");
		s.async = true;
		s.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`;
		document.head.appendChild(s);
	}
	if (ga4Id) {
		const s = document.createElement("script");
		s.async = true;
		s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4Id)}`;
		document.head.appendChild(s);
		w.gtag = function () {
			// eslint-disable-next-line prefer-rest-params
			w.dataLayer.push(arguments);
		};
		w.gtag("js", new Date());
		w.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied" });
		w.gtag("config", ga4Id, { anonymize_ip: true });
	}
}

function applyConsent(c: Consent | null) {
	if (!kit.consent) {
		loadAnalytics();
		return;
	}
	if (c?.analytics) loadAnalytics();
}

function consentBanner() {
	if (!kit.consent) return;
	let el = document.querySelector<HTMLElement>("[data-consent-banner]");
	if (!el) {
		// Themes may place their own banner (a [data-consent-banner] element); otherwise the default one is added here.
		el = document.createElement("aside");
		el.className = "consent";
		el.setAttribute("data-consent-banner", "");
		el.hidden = true;
		el.setAttribute("role", "dialog");
		el.setAttribute("aria-labelledby", "consent-title");
		el.innerHTML = `<h2 id="consent-title">${esc(kit.consent.title)}</h2><p>${esc(kit.consent.text)} <a href="${esc(kit.consent.privacyUrl)}">Privacy policy</a></p><div class="consent__opts"><label><input type="checkbox" checked disabled> Essential (always on)</label><label><input type="checkbox" name="analytics"> Analytics</label><label><input type="checkbox" name="marketing"> Marketing</label></div><div class="consent__actions"><button type="button" class="primary" data-consent-all>Accept all</button><button type="button" data-consent-essential>Essential only</button><button type="button" data-consent-save>Save choices</button></div>`;
		document.body.appendChild(el);
	}
	const analytics = el.querySelector<HTMLInputElement>('[name="analytics"]');
	const marketing = el.querySelector<HTMLInputElement>('[name="marketing"]');
	const show = () => {
		const c = readConsent();
		if (analytics) analytics.checked = c?.analytics ?? false;
		if (marketing) marketing.checked = c?.marketing ?? false;
		el.hidden = false;
	};
	const save = (c: Consent) => {
		writeConsent(c);
		el.hidden = true;
		applyConsent(c);
	};
	el.querySelector("[data-consent-all]")?.addEventListener("click", () => save({ analytics: true, marketing: true, at: new Date().toISOString() }));
	el.querySelector("[data-consent-essential]")?.addEventListener("click", () => save({ analytics: false, marketing: false, at: new Date().toISOString() }));
	el.querySelector("[data-consent-save]")?.addEventListener("click", () => save({ analytics: analytics?.checked ?? false, marketing: marketing?.checked ?? false, at: new Date().toISOString() }));
	document.querySelectorAll("[data-consent-open]").forEach((a) =>
		a.addEventListener("click", (e) => {
			e.preventDefault();
			show();
		}),
	);
	if (!readConsent()) show();
}

function stars(n: number) {
	return "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));
}
function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

async function reviews() {
	const hosts = document.querySelectorAll<HTMLElement>("[data-google-reviews]");
	if (!hosts.length) return;
	let data: { name: string; rating: number | null; total: number; placeUrl: string | null; reviews: Array<{ author: string; rating: number; text: string; when: string; avatar: string | null }> } | null = null;
	try {
		const res = await fetch(`${API}/_emdash/api/plugins/premium-site-kit/reviews`);
		const json = await res.json();
		data = json?.data ?? null;
	} catch {}
	hosts.forEach((host) => {
		if (!data || !data.reviews.length) {
			host.innerHTML = `<p class="gr__empty">Reviews coming soon.</p>`;
			return;
		}
		const limit = Number(host.dataset.limit) || 6;
		host.innerHTML = `<div class="gr__head"><span class="gr__stars" aria-label="${data.rating ?? ""} out of 5">${stars(data.rating ?? 0)}</span><strong>${data.rating ?? ""}</strong><span>from ${data.total} Google reviews</span>${data.placeUrl ? `<a href="${esc(data.placeUrl)}" target="_blank" rel="noopener">Read all on Google</a>` : ""}</div>
		<div class="gr__list">${data.reviews
			.slice(0, limit)
			.map(
				(r) => `<article class="gr__card"><header>${r.avatar ? `<img src="${esc(r.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<div><strong>${esc(r.author)}</strong><small>${stars(r.rating)} · ${esc(r.when)}</small></div></header><p>${esc(r.text)}</p>${r.text.length > 260 ? `<button type="button" class="gr__more">Read more</button>` : ""}</article>`,
			)
			.join("")}</div>`;
		host.querySelectorAll<HTMLButtonElement>(".gr__more").forEach((b) =>
			b.addEventListener("click", () => {
				const p = b.previousElementSibling as HTMLElement;
				p.classList.toggle("is-open");
				b.textContent = p.classList.contains("is-open") ? "Show less" : "Read more";
			}),
		);
	});
}

function beforeAfter() {
	document.querySelectorAll<HTMLElement>("[data-before-after]").forEach((fig) => {
		if (fig.querySelector(".ba__handle")) return;
		fig.classList.add("ba");
		const handle = document.createElement("div");
		handle.className = "ba__handle";
		fig.insertAdjacentHTML("beforeend", `<span class="ba__label ba__label--before">Before</span><span class="ba__label ba__label--after">After</span>`);
		fig.appendChild(handle);
		const set = (clientX: number) => {
			const r = fig.getBoundingClientRect();
			const pct = Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
			fig.style.setProperty("--ba", `${pct}%`);
		};
		let dragging = false;
		fig.addEventListener("pointerdown", (e) => {
			dragging = true;
			fig.setPointerCapture(e.pointerId);
			set(e.clientX);
		});
		fig.addEventListener("pointermove", (e) => dragging && set(e.clientX));
		fig.addEventListener("pointerup", () => (dragging = false));
		fig.addEventListener("pointercancel", () => (dragging = false));
		fig.tabIndex = 0;
		fig.setAttribute("role", "slider");
		fig.setAttribute("aria-label", "Before and after comparison");
		fig.addEventListener("keydown", (e) => {
			const cur = parseFloat(fig.style.getPropertyValue("--ba")) || 50;
			if (e.key === "ArrowLeft") fig.style.setProperty("--ba", `${Math.max(0, cur - 5)}%`);
			if (e.key === "ArrowRight") fig.style.setProperty("--ba", `${Math.min(100, cur + 5)}%`);
		});
	});
}

function faqSchema() {
	const items = [...document.querySelectorAll<HTMLElement>("[data-faq] details")]
		.map((d) => ({ q: d.querySelector("summary")?.textContent?.trim() ?? "", a: [...d.children].filter((c) => c.tagName !== "SUMMARY").map((c) => c.textContent?.trim() ?? "").join("\n").trim() }))
		.filter((x) => x.q && x.a);
	if (!items.length || document.getElementById("pcx-faq-ld")) return;
	const s = document.createElement("script");
	s.type = "application/ld+json";
	s.id = "pcx-faq-ld";
	s.textContent = JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: items.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) });
	document.head.appendChild(s);
}

applyConsent(readConsent());
consentBanner();
reviews();
beforeAfter();
faqSchema();
(window as unknown as { pcxConsent: unknown }).pcxConsent = { get: readConsent, open: () => document.querySelector<HTMLElement>("[data-consent-open]")?.click() };
