/**
 * Restaurant menu + QR table ordering ([data-restaurant-menu]): categories, dishes with
 * modifiers (the product option model), add to the bag, and the table context
 * from a QR code (?table=CODE) that the checkout turns into a dine-in order.
 * Also the order tracking page ([data-track]) and the reservation widget
 * ([data-reservation]) — reservations are bookings on the Bookings plugin
 * against the restaurant's "Table reservation" service.
 */
import { API } from "../../lib/client";
import { addToCart } from "../premium-commerce/shop";
import { collectOptions, mountProductOptions, setBasePrice } from "../premium-commerce/product-options";
import { show as showDrawer } from "../premium-commerce/cart-drawer";

const BASE = `${API}/_emdash/api/plugins/premium-restaurant`;
const BOOKINGS = `${API}/_emdash/api/plugins/premium-bookings`;
const COMMERCE = `${API}/_emdash/api/plugins/premium-commerce`;
export const TABLE_KEY = "pcx-table";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface MenuItem { id: string; slug: string; title: string; unitAmount: number; summary: string | null; description: string | null; image: unknown; tags: string[]; popular: boolean; options: unknown[]; station: string | null }
interface Menu { currency: string; categories: Array<{ name: string; items: MenuItem[] }> }
export interface RestaurantConfig { enabled: boolean; storeName: string; modes: string[]; reservationServiceId: string | null; openNow: boolean; openingHours: string; timezone: string; prepTimeMin: number; tipPresets: number[]; serviceChargePct: number; payAtTable: boolean; payOnCollection: boolean; qrOrdering: boolean; reservations: boolean; maxPartySize: number; zones: Array<{ id: string; name: string; fee: number; minimum: number; etaMin: number }> }

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
export function money(minor: number, currency: string): string {
	const major = ZERO_DECIMAL.has(currency) ? minor : minor / 100;
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(major);
	} catch {
		return `${currency.toUpperCase()} ${major.toFixed(2)}`;
	}
}
const imageUrl = (img: unknown): string | null => {
	if (!img) return null;
	if (typeof img === "string") return img;
	const o = img as { url?: string; src?: string };
	return o.url ?? o.src ?? null;
};

export async function api<T>(path: string, body?: unknown, base = BASE): Promise<T> {
	const res = await fetch(`${base}/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } };
	if (!res.ok || json.success === false) throw new Error(json.error?.message || `Request failed (${res.status})`);
	return json.data as T;
}

let configPromise: Promise<RestaurantConfig | null> | null = null;
export function restaurantConfig(): Promise<RestaurantConfig | null> {
	if (!configPromise) configPromise = api<RestaurantConfig>("config").catch(() => null);
	return configPromise;
}

/* ---- table context from the QR code ------------------------------------- */

export function currentTable(): { code: string; name: string; seats: number } | null {
	try {
		return JSON.parse(localStorage.getItem(TABLE_KEY) || "null");
	} catch {
		return null;
	}
}
export function clearTable(): void {
	try {
		localStorage.removeItem(TABLE_KEY);
	} catch {}
	document.dispatchEvent(new CustomEvent("pcx:table"));
}

async function adoptTableFromUrl(): Promise<void> {
	const code = new URLSearchParams(location.search).get("table");
	if (!code) return;
	try {
		const { table } = await api<{ table: { code: string; name: string; seats: number } }>("table", { code });
		localStorage.setItem(TABLE_KEY, JSON.stringify({ code: table.code, name: table.name, seats: table.seats }));
		document.dispatchEvent(new CustomEvent("pcx:table"));
	} catch {}
}

function renderTableBanner(): void {
	document.querySelectorAll<HTMLElement>("[data-table-banner]").forEach((el) => {
		const t = currentTable();
		el.hidden = !t;
		if (t) el.innerHTML = `<span>You're ordering for <strong>${esc(t.name)}</strong> — food comes to your table.</span> <button type="button" class="rs-link" data-table-clear>Not at a table?</button>`;
		el.querySelector("[data-table-clear]")?.addEventListener("click", () => clearTable());
	});
}

/* ---- menu ------------------------------------------------------------------ */

async function renderMenu(root: HTMLElement): Promise<void> {
	let menu: Menu;
	try {
		menu = await api<Menu>("menu");
	} catch (err) {
		root.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Could not load the menu")}</p>`;
		return;
	}
	const cfg = await restaurantConfig();
	const cats = menu.categories.filter((c) => c.items.length);
	const onlyCat = root.dataset.category;
	const shown = onlyCat ? cats.filter((c) => c.name.toLowerCase() === onlyCat.toLowerCase()) : cats;
	root.innerHTML = `
		${cfg && !cfg.openNow ? `<p class="rs-closed">We're closed right now — you can still pre-order for later.</p>` : ""}
		${shown.length > 1 ? `<nav class="rs-cats" aria-label="Menu sections">${shown.map((c, i) => `<a href="#cat-${i}">${esc(c.name)}</a>`).join("")}</nav>` : ""}
		${shown
			.map(
				(c, i) => `<section class="rs-cat" id="cat-${i}"><h2 class="rs-cat__title">${esc(c.name)}</h2><div class="rs-grid">${c.items
					.map((it) => {
						const img = imageUrl(it.image);
						return `<article class="rs-item${it.popular ? " rs-item--popular" : ""}" data-item="${esc(it.slug)}">${img ? `<img class="rs-item__img" src="${esc(img)}" alt="" loading="lazy">` : ""}<div class="rs-item__body"><h3 class="rs-item__title">${esc(it.title)}${it.popular ? `<span class="rs-badge">Popular</span>` : ""}</h3>${it.summary || it.description ? `<p class="rs-item__desc">${esc(it.summary ?? it.description)}</p>` : ""}${it.tags.length ? `<p class="rs-tags">${it.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>` : ""}<div class="rs-item__foot"><span class="rs-price">${money(it.unitAmount, menu.currency)}</span><button type="button" class="rs-add" data-add="${esc(it.slug)}">${it.options.length ? "Choose" : "Add"}</button></div></div></article>`;
					})
					.join("")}</div></section>`,
			)
			.join("")}
		<div class="rs-modal" data-modal hidden><div class="rs-modal__scrim" data-modal-close></div><div class="rs-modal__panel" role="dialog" aria-modal="true"></div></div>`;
	const bySlug = new Map(cats.flatMap((c) => c.items.map((it) => [it.slug, it] as const)));
	const modal = root.querySelector<HTMLElement>("[data-modal]")!;
	const panel = modal.querySelector<HTMLElement>(".rs-modal__panel")!;
	const close = () => {
		modal.hidden = true;
		panel.innerHTML = "";
	};
	modal.querySelector("[data-modal-close]")!.addEventListener("click", close);
	root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((btn) =>
		btn.addEventListener("click", () => {
			const it = bySlug.get(btn.dataset.add!);
			if (!it) return;
			if (!it.options.length) {
				addToCart({ productId: it.id, slug: it.slug, title: it.title, price: ZERO_DECIMAL.has(menu.currency) ? it.unitAmount : it.unitAmount / 100 }, 1);
				btn.textContent = "Added ✓";
				setTimeout(() => (btn.textContent = "Add"), 1200);
				showDrawer();
				return;
			}
			const img = imageUrl(it.image);
			panel.innerHTML = `<button type="button" class="rs-modal__close" aria-label="Close" data-modal-close>×</button>${img ? `<img class="rs-modal__img" src="${esc(img)}" alt="">` : ""}<h3>${esc(it.title)}</h3>${it.description || it.summary ? `<p class="rs-item__desc">${esc(it.description ?? it.summary)}</p>` : ""}<div class="ec-product-options" data-product-options="${esc(it.slug)}"><script type="application/json">${JSON.stringify({ slug: it.slug, basePrice: ZERO_DECIMAL.has(menu.currency) ? it.unitAmount : it.unitAmount / 100, currency: menu.currency, fields: it.options }).replace(/</g, "\\u003c")}</script></div><label class="ec-form-field"><span class="ec-form-label">Notes for the kitchen</span><input class="ec-form-input" name="rs-notes" placeholder="No onions, extra spicy…"></label><div class="rs-modal__foot"><div class="rs-qty"><button type="button" data-qty="-1">−</button><span data-qty-value>1</span><button type="button" data-qty="1">+</button></div><button type="button" class="rs-add rs-add--big" data-confirm>Add · <span data-total>${money(it.unitAmount, menu.currency)}</span></button></div>`;
			modal.hidden = false;
			panel.querySelector("[data-modal-close]")!.addEventListener("click", close);
			const host = panel.querySelector<HTMLElement>("[data-product-options]")!;
			setBasePrice(it.slug, ZERO_DECIMAL.has(menu.currency) ? it.unitAmount : it.unitAmount / 100);
			mountProductOptions(host, `${COMMERCE}/upload`);
			let qty = 1;
			const total = () => {
				const c = collectOptions(it.slug);
				const price = c && !("error" in c) ? c.price : ZERO_DECIMAL.has(menu.currency) ? it.unitAmount : it.unitAmount / 100;
				panel.querySelector("[data-total]")!.textContent = money(Math.round(ZERO_DECIMAL.has(menu.currency) ? price * qty : price * 100 * qty), menu.currency);
			};
			panel.querySelectorAll<HTMLButtonElement>("[data-qty]").forEach((b) =>
				b.addEventListener("click", () => {
					qty = Math.max(1, qty + Number(b.dataset.qty));
					panel.querySelector("[data-qty-value]")!.textContent = String(qty);
					total();
				}),
			);
			host.addEventListener("change", total);
			host.addEventListener("input", total);
			panel.querySelector("[data-confirm]")!.addEventListener("click", () => {
				const c = collectOptions(it.slug);
				if (!c) return;
				if ("error" in c) {
					alert(c.error);
					return;
				}
				const notes = (panel.querySelector<HTMLInputElement>('[name="rs-notes"]')?.value ?? "").trim();
				const options = { ...c.options, ...(notes ? { notes } : {}) };
				const display = [...(c.optionsDisplay ?? []), ...(notes ? [{ label: "Notes", value: notes }] : [])];
				addToCart({ productId: it.id, slug: it.slug, title: it.title, price: c.price, options, optionsDisplay: display }, qty);
				close();
				showDrawer();
			});
		}),
	);
}

/* ---- order tracking --------------------------------------------------------- */

const KITCHEN_LABEL: Record<string, string> = { new: "Received", preparing: "Being prepared", ready: "Ready", served: "Served", out_for_delivery: "On its way", delivered: "Delivered", completed: "Completed", cancelled: "Cancelled" };

async function renderTrack(root: HTMLElement): Promise<void> {
	const p = new URLSearchParams(location.search);
	const number = p.get("order");
	const token = p.get("token");
	if (!number || !token) {
		root.innerHTML = `<p>Open the link from your order confirmation to track it.</p>`;
		return;
	}
	const draw = async () => {
		try {
			const o = await api<{ number: number; status: string; currency: string; total: number; fulfilment: { mode: string; when: string; table: string | null; kitchen: string; driverName: string | null } | null; items: Array<{ title: string; quantity: number }> }>("track", { order: number, token });
			const steps = o.fulfilment?.mode === "delivery" ? ["new", "preparing", "ready", "out_for_delivery", "delivered"] : o.fulfilment?.mode === "dine_in" ? ["new", "preparing", "ready", "served"] : ["new", "preparing", "ready", "completed"];
			const k = o.fulfilment?.kitchen ?? "new";
			const idx = Math.max(0, steps.indexOf(k === "completed" && steps.includes("served") ? "served" : k));
			root.innerHTML = `<h2>Order #${o.number}</h2><p class="ec-form-help">${o.fulfilment ? `${o.fulfilment.mode.replace("_", "-")} · ${esc(o.fulfilment.when)}${o.fulfilment.table ? ` · ${esc(o.fulfilment.table)}` : ""}` : ""}${o.status === "awaiting_payment" ? " · pay at the counter" : ""}</p>
				<ol class="rs-steps">${steps.map((s, i) => `<li class="${i < idx ? "is-done" : i === idx ? "is-current" : ""}">${KITCHEN_LABEL[s] ?? s}</li>`).join("")}</ol>
				${k === "cancelled" ? `<p class="ec-form-status--error">This order was cancelled.</p>` : ""}
				${o.fulfilment?.driverName && k === "out_for_delivery" ? `<p>Your driver: ${esc(o.fulfilment.driverName)}</p>` : ""}
				<ul class="rs-track__items">${o.items.map((it) => `<li>${it.quantity} × ${esc(it.title)}</li>`).join("")}</ul>
				<p class="ec-form-help">Total ${money(o.total, o.currency)}</p>`;
			if (!["delivered", "completed", "served", "cancelled"].includes(k)) setTimeout(draw, 10_000);
		} catch (err) {
			root.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Could not load the order")}</p>`;
		}
	};
	await draw();
}

/* ---- reservations ------------------------------------------------------------ */

async function renderReservation(root: HTMLElement): Promise<void> {
	const p = new URLSearchParams(location.search);
	if (p.get("reservation") && p.get("token")) {
		try {
			const { booking: r } = await api<{ booking: { id: string; customer: { name: string }; partySize: number | null; when: string; resource: string | null; status: string } }>("lookup", { id: p.get("reservation"), token: p.get("token") }, BOOKINGS);
			root.innerHTML = `<div class="rs-confirm"><h2>${r.status === "cancelled" ? "Reservation cancelled" : "Table booked"}</h2><p>${esc(r.customer.name)} · party of ${r.partySize ?? ""} · <strong>${esc(r.when)}</strong></p>${r.status === "confirmed" ? `<button type="button" class="rs-link" data-cancel>Cancel this reservation</button>` : ""}</div>`;
			root.querySelector("[data-cancel]")?.addEventListener("click", async () => {
				if (!confirm("Cancel your reservation?")) return;
				await api("cancel", { id: p.get("reservation"), token: p.get("token") }, BOOKINGS);
				location.reload();
			});
		} catch (err) {
			root.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Reservation not found")}</p>`;
		}
		return;
	}
	const cfg = await restaurantConfig();
	if (!cfg?.reservations || !cfg.reservationServiceId) {
		root.innerHTML = `<p>Online reservations are not open yet — please call us.</p>`;
		return;
	}
	const today = new Date();
	const ymd = (d: Date) => d.toISOString().slice(0, 10);
	root.innerHTML = `<form class="ec-form rs-reserve" data-reserve>
		<div class="ec-form-row"><label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Party size</span><select class="ec-form-input" name="party">${Array.from({ length: cfg.maxPartySize }, (_, i) => `<option value="${i + 1}"${i + 1 === 2 ? " selected" : ""}>${i + 1} ${i === 0 ? "guest" : "guests"}</option>`).join("")}</select></label>
		<label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Date</span><input class="ec-form-input" type="date" name="date" min="${ymd(today)}" value="${ymd(today)}" required></label></div>
		<div class="rs-times" data-times><p class="ec-form-help">Pick a date to see times.</p></div>
		<input type="hidden" name="at">
		<div class="ec-form-row"><label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Name</span><input class="ec-form-input" name="name" required></label><label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Phone</span><input class="ec-form-input" name="phone" type="tel"></label></div>
		<label class="ec-form-field"><span class="ec-form-label">Email</span><input class="ec-form-input" name="email" type="email" required></label>
		<label class="ec-form-field"><span class="ec-form-label">Anything we should know? (allergies, occasion, high chair)</span><input class="ec-form-input" name="notes"></label>
		<button type="submit" class="ec-form-submit" disabled data-submit>Book table</button>
		<p class="ec-form-status" data-status aria-live="polite"></p></form>`;
	const form = root.querySelector<HTMLFormElement>("[data-reserve]")!;
	const times = form.querySelector<HTMLElement>("[data-times]")!;
	const submit = form.querySelector<HTMLButtonElement>("[data-submit]")!;
	const at = form.elements.namedItem("at") as HTMLInputElement;
	const loadTimes = async () => {
		const date = (form.elements.namedItem("date") as HTMLInputElement).value;
		const party = Number((form.elements.namedItem("party") as HTMLSelectElement).value);
		at.value = "";
		submit.disabled = true;
		times.innerHTML = `<p class="ec-form-help">Checking tables…</p>`;
		try {
			const r = await api<{ slots: Array<{ startsAt: string; label: string }> }>("availability", { serviceId: cfg.reservationServiceId, date, partySize: party }, BOOKINGS);
			times.innerHTML = r.slots.length ? r.slots.map((s) => `<button type="button" class="rs-time" data-at="${s.startsAt}">${s.label}</button>`).join("") : `<p class="ec-form-help">No tables for ${party} on that day — try another date or a smaller party.</p>`;
			times.querySelectorAll<HTMLButtonElement>("[data-at]").forEach((b) =>
				b.addEventListener("click", () => {
					times.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected"));
					b.classList.add("is-selected");
					at.value = b.dataset.at!;
					submit.disabled = false;
				}),
			);
		} catch (err) {
			times.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Could not load times")}</p>`;
		}
	};
	form.addEventListener("change", (e) => {
		const n = (e.target as HTMLInputElement).name;
		if (n === "date" || n === "party") void loadTimes();
	});
	void loadTimes();
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const status = form.querySelector<HTMLElement>("[data-status]")!;
		submit.disabled = true;
		status.textContent = "Booking…";
		try {
			const r = await api<{ booking: { id: string; when: string }; token: string }>("hold", { serviceId: cfg.reservationServiceId, startsAt: at.value, partySize: Number((form.elements.namedItem("party") as HTMLSelectElement).value), customer: { name: (form.elements.namedItem("name") as HTMLInputElement).value, email: (form.elements.namedItem("email") as HTMLInputElement).value, phone: (form.elements.namedItem("phone") as HTMLInputElement).value || undefined }, notes: (form.elements.namedItem("notes") as HTMLInputElement).value || undefined }, BOOKINGS);
			location.assign(`${location.pathname}?reservation=${r.booking.id}&token=${r.token}`);
		} catch (err) {
			status.textContent = err instanceof Error ? err.message : "Could not book";
			status.classList.add("ec-form-status--error");
			submit.disabled = false;
		}
	});
}

/* ---- boot --------------------------------------------------------------------- */

export function initRestaurant(): void {
	void adoptTableFromUrl().then(renderTableBanner);
	document.addEventListener("pcx:table", renderTableBanner);
	document.querySelectorAll<HTMLElement>("[data-restaurant-menu]").forEach((el) => void renderMenu(el));
	document.querySelectorAll<HTMLElement>("[data-track]").forEach((el) => void renderTrack(el));
	document.querySelectorAll<HTMLElement>("[data-reservation]").forEach((el) => void renderReservation(el));
}
