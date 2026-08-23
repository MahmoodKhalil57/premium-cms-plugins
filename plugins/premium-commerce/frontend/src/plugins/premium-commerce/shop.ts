/**
 * Storefront runtime for the premium-commerce plugin.
 *
 * - cart in localStorage (`ec-cart`), rendered into [data-cart] and counted
 *   into [data-cart-count] markers (usable in page-builder sections)
 * - [data-add-to-cart="<slug>"] buttons anywhere (static pages or sections)
 * - live availability for [data-availability="<productId>"] labels
 * - checkout: POST /checkout → hosted checkout of the configured provider (Stripe/Polar) or pay-later → success page
 *   confirms via /confirm or /order and renders the receipt into [data-order]
 *
 * The CMS is same-origin on the live domain; off-domain previews
 * (github.io, localhost) use CMS_URL from src/config.ts.
 */

import { initCartDrawer, show as showDrawer } from "./cart-drawer";
import { collectOptions, initProductOptions, setBasePrice } from "./product-options";
import { activeCheckoutExtensions, checkoutExtensionBody, orderNoteFromExtensions } from "./checkout-extensions";
import { type Account, type AccountAddress, addressFormHtml, api as accountApi, formatAddress, initAccount, readAddress, signInFormHtml, whoAmI, wireSignIn } from "./account";
import { CMS_URL } from "../../config";

// The platform serves this frontend on the site's own domain(s) (the
// worker proxies the Pages build), so the CMS is same-origin everywhere
// except off-domain previews (github.io, localhost) which use CMS_URL.
import { API } from "../../lib/client";
const BASE = `${API}/_emdash/api/plugins/premium-commerce`;
const CART_KEY = "ec-cart";

interface CartLine {
	productId: string;
	slug: string;
	title: string;
	price: number;
	quantity: number;
	/** Chosen option values (field name → value). */
	options?: Record<string, unknown>;
	/** Labels for the cart summary. */
	optionsDisplay?: Array<{ label: string; value: string }>;
	/** Custom print design (previewDataUrl is local only). */
	customization?: { design: unknown; previewMediaId?: string; previewDataUrl?: string };
}

interface Catalog {
	currency: string;
	manualPayment: boolean;
	/** An online provider (Stripe or Polar) is configured. */
	online?: boolean;
	provider?: string;
	/** Legacy alias of `online`. */
	stripe: boolean;
	/** Shoppers may sign in to save addresses and cards. */
	customerAccounts?: boolean;
	products: Array<{ id: string; slug: string; title: string; unitAmount: number; available: number | null; saleUnitAmount?: number; saleLabel?: string }>;
	hasCoupons?: boolean;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let currency = "usd";
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
function money(minor: number): string {
	const factor = ZERO_DECIMAL.has(currency) ? 1 : 100;
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minor / factor);
	} catch {
		return `${(minor / factor).toFixed(2)} ${currency.toUpperCase()}`;
	}
}
function toMinor(price: number): number {
	return Math.round(price * (ZERO_DECIMAL.has(currency) ? 1 : 100));
}

/* ---- cart state ---------------------------------------------------------- */

/** Identity of a cart line: product + options. */
export function lineKey(l: { productId: string; options?: Record<string, unknown>; customization?: { design: unknown } }): string {
	const o = Object.entries(l.options ?? {})
		.filter(([, v]) => v !== undefined && v !== "" && v !== false)
		.sort()
		.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
		.join("&");
	let h = 0;
	if (l.customization) {
		const str = JSON.stringify(l.customization.design);
		for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
	}
	return `${l.productId}${o ? `#${o}` : ""}${h ? `~${(h >>> 0).toString(36)}` : ""}`;
}

function optionsText(l: CartLine): string {
	if (l.optionsDisplay?.length) return l.optionsDisplay.map((d) => `${d.label}: ${d.value}`).join(", ");
	return Object.entries(l.options ?? {})
		.filter(([, v]) => v !== undefined && v !== "" && v !== false)
		.map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)} ${Array.isArray(v) ? v.join("/") : String(v)}`)
		.join(", ");
}

export function readCart(): CartLine[] {
	try {
		const raw = localStorage.getItem(CART_KEY);
		const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
		return Array.isArray(parsed) ? parsed.filter((l) => l && l.productId && l.quantity > 0) : [];
	} catch {
		return [];
	}
}

function writeCart(lines: CartLine[]): void {
	try {
		localStorage.setItem(CART_KEY, JSON.stringify(lines));
	} catch {
		/* private mode */
	}
	renderCount();
	document.dispatchEvent(new CustomEvent("ec-cart:change", { detail: { lines } }));
	scheduleCartSync(lines);
}

/* ---- server-side cart (signed-in shoppers + guests by token) ------------- */

const CART_TOKEN_KEY = "ec-cart-token";
function cartToken(): string {
	let t = localStorage.getItem(CART_TOKEN_KEY);
	if (!t) {
		const b = new Uint8Array(18);
		crypto.getRandomValues(b);
		t = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		localStorage.setItem(CART_TOKEN_KEY, t);
	}
	return t;
}
let syncTimer: number | undefined;
function scheduleCartSync(lines: CartLine[]): void {
	window.clearTimeout(syncTimer);
	syncTimer = window.setTimeout(() => void pushCart(lines), 600);
}
const serverLine = (l: CartLine) => ({ productId: l.productId, quantity: l.quantity, ...(l.options ? { options: l.options } : {}), ...(l.customization ? { customization: { design: l.customization.design, previewMediaId: l.customization.previewMediaId } } : {}) });
async function pushCart(lines: CartLine[]): Promise<void> {
	try {
		const me = await whoAmI();
		if (me) await accountApi("cart/save", { lines: lines.map(serverLine) });
		else await fetch(`${BASE}/cart/guest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: cartToken(), op: "save", lines: lines.map(serverLine) }) });
	} catch {
		/* offline or accounts disabled — the local cart is still the source of truth for this browser */
	}
}
/** On sign-in, fold the guest cart into the account cart and adopt the merged lines (local previews are kept where possible). */
async function adoptServerCart(): Promise<void> {
	const me = await whoAmI();
	if (!me) return;
	try {
		const local = readCart();
		const { cart } = await accountApi<{ cart: { lines: Array<{ productId: string; quantity: number; options?: Record<string, unknown>; customization?: CartLine["customization"] }> } }>("cart/get", { mergeToken: cartToken(), mergeLines: local.map(serverLine) });
		if (!cart.lines.length) return;
		const cat = await loadCatalog();
		const merged: CartLine[] = cart.lines.map((l) => {
			const known = local.find((x) => lineKey(x) === lineKey(l));
			const p = cat?.products.find((x) => x.id === l.productId || x.slug === l.productId);
			return known ? { ...known, quantity: l.quantity } : { productId: l.productId, slug: p?.slug ?? l.productId, title: p?.title ?? l.productId, price: p ? p.unitAmount / (ZERO_DECIMAL.has(currency) ? 1 : 100) : 0, quantity: l.quantity, options: l.options, customization: l.customization };
		});
		try {
			localStorage.setItem(CART_KEY, JSON.stringify(merged));
		} catch {
			/* private mode */
		}
		renderCount();
		renderCart();
	} catch {
		/* accounts disabled or offline */
	}
}

export function addToCart(line: Omit<CartLine, "quantity">, quantity = 1): void {
	const cart = readCart();
	const existing = cart.find((l) => lineKey(l) === lineKey(line));
	if (existing) existing.quantity += quantity;
	else cart.push({ ...line, quantity });
	writeCart(cart);
}

export function setQuantity(key: string, quantity: number): void {
	const cart = readCart()
		.map((l) => (lineKey(l) === key ? { ...l, quantity } : l))
		.filter((l) => l.quantity > 0);
	writeCart(cart);
}

export function clearCart(): void {
	writeCart([]);
}

function cartCount(): number {
	return readCart().reduce((n, l) => n + l.quantity, 0);
}

function renderCount(): void {
	const n = cartCount();
	document.querySelectorAll<HTMLElement>("[data-cart-count]").forEach((el) => {
		el.textContent = String(n);
		el.toggleAttribute("data-empty", n === 0);
	});
}

/* ---- API ----------------------------------------------------------------- */

async function api<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
	const res = await fetch(`${BASE}/${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
	const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string; code?: string } };
	if (res.status === 404 && retry && body.error?.message === "Plugin route not found") {
		await new Promise((r) => setTimeout(r, 1200));
		return api<T>(path, init, false);
	}
	if (!res.ok || body.success === false) throw new Error(body.error?.message || `Request failed (${res.status})`);
	return body.data as T;
}

let catalogPromise: Promise<Catalog | null> | null = null;
function loadCatalog(): Promise<Catalog | null> {
	if (!catalogPromise) {
		catalogPromise = api<Catalog>("catalog")
			.then((c) => {
				currency = c.currency || currency;
				return c;
			})
			.catch(() => null);
	}
	return catalogPromise;
}

/* ---- add-to-cart buttons + availability --------------------------------- */

function wireAddToCart(root: ParentNode): void {
	root.querySelectorAll<HTMLElement>("[data-add-to-cart]:not([data-ec-wired])").forEach((btn) => {
		btn.setAttribute("data-ec-wired", "1");
		btn.addEventListener("click", async () => {
			const slug = btn.dataset.addToCart || btn.dataset.slug || "";
			let productId = btn.dataset.productId || "";
			let title = btn.dataset.title || slug;
			let price = Number(btn.dataset.price);
			if (!productId || !Number.isFinite(price)) {
				// Page-builder sections only know the slug — resolve from the catalogue.
				const cat = await loadCatalog();
				const p = cat?.products.find((x) => x.slug === slug || x.id === slug);
				if (!p) {
					flash(btn, "Not available", true);
					return;
				}
				productId = p.id;
				title = p.title;
				price = p.unitAmount / (ZERO_DECIMAL.has(currency) ? 1 : 100);
			}
			const qtyInput = document.querySelector<HTMLInputElement>(`[data-qty-for="${CSS.escape(slug)}"]`);
			const qty = Math.max(1, Number(qtyInput?.value) || 1);
			// Product options rendered on this page (sizes, add-ons, designs) — validated here for feedback, again at checkout.
			const collected = collectOptions(slug);
			if (collected && "error" in collected) {
				flash(btn, collected.error, true);
				return;
			}
			const line: Omit<CartLine, "quantity"> = { productId, slug, title, price: collected ? collected.price : price };
			if (collected) {
				if (Object.keys(collected.options).length) line.options = collected.options;
				if (collected.optionsDisplay.length) line.optionsDisplay = collected.optionsDisplay;
				if (collected.customization) line.customization = collected.customization;
			}
			addToCart(line, qty);
			flash(btn, "Added ✓");
			void showDrawer("bag");
		});
	});
}

function flash(btn: HTMLElement, text: string, error = false): void {
	const original = btn.dataset.ecLabel ?? btn.textContent ?? "";
	btn.dataset.ecLabel = original;
	btn.textContent = text;
	btn.classList.toggle("ec-add-to-cart--error", error);
	window.setTimeout(() => {
		btn.textContent = original;
		btn.classList.remove("ec-add-to-cart--error");
	}, 1400);
}

/** Automatic discounts from the catalog: show sale prices on cards and the product page, and price options from the sale price. */
async function renderSalePrices(): Promise<void> {
	const cat = await loadCatalog();
	if (!cat) return;
	for (const p of cat.products) {
		const saleMinor = p.saleUnitAmount;
		if (!saleMinor) continue;
		const sale = money(saleMinor);
		const orig = money(p.unitAmount);
		document.querySelectorAll<HTMLElement>(`.ec-product-card[data-product="${CSS.escape(p.id)}"] .ec-product-card__price`).forEach((el) => {
			el.innerHTML = `<span>${esc(sale)}</span><s>${esc(orig)}</s><span class="ec-sale-tag">${esc(p.saleLabel ?? "Sale")}</span>`;
		});
		const page = document.querySelector<HTMLElement>(`[data-product-price="${CSS.escape(p.slug)}"]`);
		if (page) {
			page.textContent = sale;
			const wrap = page.closest<HTMLElement>(".ec-product__price");
			if (wrap && !wrap.querySelector(".ec-sale-tag")) wrap.insertAdjacentHTML("beforeend", `<s>${esc(orig)}</s><span class="ec-sale-tag">${esc(p.saleLabel ?? "Sale")}</span>`);
			setBasePrice(p.slug, saleMinor / (ZERO_DECIMAL.has(currency) ? 1 : 100));
		}
		// Add-to-cart buttons carry the list price; switch them to the sale price so the bag matches.
		document.querySelectorAll<HTMLElement>(`[data-add-to-cart="${CSS.escape(p.slug)}"]`).forEach((b) => (b.dataset.price = String(saleMinor / (ZERO_DECIMAL.has(currency) ? 1 : 100))));
	}
}

async function renderAvailability(): Promise<void> {
	const labels = Array.from(document.querySelectorAll<HTMLElement>("[data-availability]"));
	if (labels.length === 0) return;
	const cat = await loadCatalog();
	if (!cat) return;
	for (const el of labels) {
		const p = cat.products.find((x) => x.id === el.dataset.availability || x.slug === el.dataset.availability);
		if (!p) continue;
		const btn = el.parentElement?.querySelector<HTMLButtonElement>("[data-add-to-cart]");
		if (p.available === null) {
			el.hidden = true;
		} else if (p.available <= 0) {
			el.hidden = false;
			el.textContent = "Sold out";
			if (btn) btn.disabled = true;
		} else if (p.available <= 5) {
			el.hidden = false;
			el.textContent = `Only ${p.available} left`;
		} else {
			el.hidden = true;
		}
	}
}

/* ---- cart page ----------------------------------------------------------- */

function renderCart(rootEl?: HTMLElement): void {
	const root = rootEl?.querySelector<HTMLElement>("[data-cart]") ?? rootEl ?? document.querySelector<HTMLElement>("[data-cart]:not(.ec-drawer [data-cart])");
	if (!root) return;
	const lines = readCart();
	if (lines.length === 0) {
		root.innerHTML = `<p class="ec-cart__empty">Your cart is empty. <a href="${BASE}/products">Browse products</a></p>`;
		return;
	}
	const subtotal = lines.reduce((n, l) => n + toMinor(l.price) * l.quantity, 0);
	root.innerHTML = `
		<table class="ec-cart__table">
			<thead><tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr></thead>
			<tbody>
				${lines
					.map(
						(l) => `<tr data-line="${esc(lineKey(l))}">
					<td>${l.customization?.previewDataUrl ? `<img class="ec-cart__thumb" src="${l.customization.previewDataUrl}" alt="">` : ""}<a href="${BASE}/products/${esc(l.slug)}">${esc(l.title)}</a>${optionsText(l) ? ` <span class="ec-cart__opts">${esc(optionsText(l))}</span>` : ""}${l.customization && !l.customization.previewDataUrl ? ` <span class="ec-cart__opts">custom design</span>` : ""}</td>
					<td><input type="number" min="0" value="${l.quantity}" data-line-qty="${esc(lineKey(l))}" aria-label="Quantity for ${esc(l.title)}" /></td>
					<td>${money(toMinor(l.price) * l.quantity)}</td>
					<td><button type="button" class="ec-link" data-line-remove="${esc(lineKey(l))}">Remove</button></td>
				</tr>`,
					)
					.join("")}
			</tbody>
			<tfoot><tr><th colspan="2">Subtotal</th><th>${money(subtotal)}</th><td></td></tr></tfoot>
		</table>
		<div class="ec-coupon" data-coupon>
			<form class="ec-coupon__form" data-coupon-form><input class="ec-form-input" name="code" placeholder="Discount code" autocomplete="off" value="${esc(couponCode())}"><button type="submit" class="ec-form-submit ec-form-submit--secondary">Apply</button></form>
			<p class="ec-coupon__status" data-coupon-status aria-live="polite"></p>
		</div>
		<p class="ec-cart__note">Shipping and tax are calculated at checkout.</p>
		${root.closest(".ec-drawer") ? "" : `<div data-checkout-host></div>`}`;
	if (!root.closest(".ec-drawer")) void renderCheckoutForm(root);
	wireCoupon(root);
	void renderDiscountPreview(root);
	root.querySelectorAll<HTMLInputElement>("[data-line-qty]").forEach((input) => {
		input.addEventListener("change", () => {
			setQuantity(input.dataset.lineQty!, Math.max(0, Number(input.value) || 0));
			renderCart();
		});
	});
	root.querySelectorAll<HTMLButtonElement>("[data-line-remove]").forEach((btn) => {
		btn.addEventListener("click", () => {
			setQuantity(btn.dataset.lineRemove!, 0);
			renderCart();
		});
	});
	void loadCatalog().then((cat) => {
		if (!cat) return;
		const manual = root.querySelector<HTMLButtonElement>('[data-checkout-method="manual"]');
		const online = root.querySelector<HTMLButtonElement>('[data-checkout-method="online"]');
		const hasOnline = cat.online ?? cat.stripe;
		if (manual) manual.hidden = !cat.manualPayment;
		if (online) online.hidden = !hasOnline;
		if (!hasOnline && !cat.manualPayment) setStatus(root, "Checkout is not configured yet.", true);
	});
}

function setStatus(root: ParentNode, message: string, error = false): void {
	const el = root.querySelector<HTMLElement>("[data-checkout-status]");
	if (!el) return;
	el.textContent = message;
	el.className = `ec-form-status ${error ? "ec-form-status--error" : ""}`;
}

/* ---- success page -------------------------------------------------------- */

interface PublicOrder {
	number: number;
	status: string;
	paymentMethod: string;
	currency: string;
	items: Array<{ title: string; slug: string; quantity: number; unitAmount: number }>;
	subtotal: number;
	shipping: number;
	tax: number;
	discount: number;
	total: number;
	email: string;
	customerName?: string;
	tracking?: string;
	adjustments?: Array<{ label: string; amount: number }>;
	extensions?: Record<string, unknown>;
}

async function renderOrder(): Promise<void> {
	const root = document.querySelector<HTMLElement>("[data-order]");
	if (!root) return;
	const params = new URLSearchParams(location.search);
	const sessionId = params.get("session_id");
	const number = params.get("order");
	const token = params.get("token");
	try {
		let order: PublicOrder | undefined;
		if (sessionId) {
			order = (await api<{ order: PublicOrder }>(`confirm?session_id=${encodeURIComponent(sessionId)}`)).order;
			clearCart();
		} else if (number && token) {
			order = (await api<{ order: PublicOrder }>(`order?order=${encodeURIComponent(number)}&token=${encodeURIComponent(token)}`)).order;
		}
		if (!order) {
			root.innerHTML = `<p>We could not find that order.</p>`;
			return;
		}
		currency = order.currency;
		const heading = order.status === "awaiting_payment" ? "Order received" : order.status === "pending" ? "Payment pending" : "Thank you — order confirmed";
		root.innerHTML = `
			<h2>${heading}</h2>
			<p class="ec-order__meta">Order <strong>#${order.number}</strong>${order.email ? ` · confirmation sent to ${esc(order.email)}` : ""}</p>
			${order.status === "awaiting_payment" ? (orderNoteFromExtensions(order) ?? `<p>We will contact you with payment details.</p>`) : ""}
			<table class="ec-cart__table">
				<tbody>${order.items.map((i) => `<tr><td>${i.quantity} × ${esc(i.title)}</td><td>${money(i.unitAmount * i.quantity)}</td></tr>`).join("")}</tbody>
				<tfoot>
					<tr><th>Subtotal</th><td>${money(order.subtotal)}</td></tr>
					${order.shipping ? `<tr><th>Shipping</th><td>${money(order.shipping)}</td></tr>` : ""}
					${(order.adjustments ?? []).map((a) => `<tr><th>${esc(a.label)}</th><td>${money(a.amount)}</td></tr>`).join("")}
					${order.tax ? `<tr><th>Tax</th><td>${money(order.tax)}</td></tr>` : ""}
					${order.discount ? `<tr><th>Discount</th><td>−${money(order.discount)}</td></tr>` : ""}
					<tr><th>Total</th><th>${money(order.total)}</th></tr>
				</tfoot>
			</table>
			${order.tracking ? `<p>Tracking: ${esc(order.tracking)}</p>` : ""}`;
	} catch (err) {
		root.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Could not load the order")}</p>`;
	}
}

/* ---- boot ---------------------------------------------------------------- */

if (typeof document !== "undefined") {
	const boot = () => {
		renderCount();
		initProductOptions(`${BASE}/upload`);
		initAccount();
		initCartDrawer({ renderLines: (root) => renderCart(root), renderCheckout: (root) => renderCheckoutForm(root), count: cartCount });
		void adoptServerCart();
		wireAddToCart(document);
		void renderAvailability();
		void renderSalePrices();
		renderCart();
		void renderOrder();
		new MutationObserver(() => wireAddToCart(document)).observe(document.body, { childList: true, subtree: true });
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
	else boot();
}

/* ---- checkout form: guest or account ----------------------------------- */

async function renderCheckoutForm(root: HTMLElement): Promise<void> {
	const host = root.querySelector<HTMLElement>("[data-checkout-host]");
	if (!host) return;
	const summary = root.querySelector<HTMLElement>("[data-cart-summary]");
	if (summary) {
		const lines = readCart();
		summary.innerHTML = `<p class="ec-form-help">${lines.reduce((n, l) => n + l.quantity, 0)} item(s) · subtotal ${money(lines.reduce((n, l) => n + toMinor(l.price) * l.quantity, 0))}</p>`;
	}
	// Other plugins (e.g. the restaurant's delivery / pickup / dine-in step) add themselves to the checkout — see checkout-extensions.ts.
	const [cat, me, exts] = await Promise.all([loadCatalog(), whoAmI(), activeCheckoutExtensions()]);
	const online = cat ? (cat.online ?? cat.stripe) : false;
	const manual = (cat?.manualPayment ?? false) || exts.some((e) => e.allowPayLater);
	const accountsOn = Boolean((cat as { customerAccounts?: boolean } | null)?.customerAccounts);
	let account: Account | null = null;
	if (me) account = await accountApi<{ customer: Account }>("account/get").then((r) => r.customer).catch(() => null);
	const defaultAddr = account?.addresses.find((a) => a.isDefault) ?? account?.addresses[0];
	const addressPicker = (prefix: string, label: string) =>
		account && account.addresses.length
			? `<fieldset class="ec-form-field"><legend class="ec-form-label">${label}</legend><div class="ec-choice-list">${account.addresses.map((a) => `<label class="ec-choice"><input type="radio" name="${prefix}.pick" value="${esc(a.id)}"${a.id === defaultAddr?.id ? " checked" : ""}><span class="ec-choice__label">${esc(a.label || "Address")}<br><small>${esc(formatAddress(a))}</small></span></label>`).join("")}<label class="ec-choice"><input type="radio" name="${prefix}.pick" value="new"><span class="ec-choice__label">New address</span></label></div><div data-new-address="${prefix}" hidden>${addressFormHtml(prefix)}</div></fieldset>`
			: `<fieldset class="ec-form-field"><legend class="ec-form-label">${label}</legend>${addressFormHtml(prefix)}</fieldset>`;
	host.innerHTML = `
		${!me && accountsOn ? `<details class="ec-account__add"><summary>Have an account? Sign in to use saved addresses and cards</summary>${signInFormHtml("/cart")}</details>` : ""}
		<form class="ec-checkout" data-checkout>
			${me ? `<p class="ec-form-help">Signed in as ${esc(me.email)}</p>` : `<label class="ec-form-field"><span class="ec-form-label">Email</span><input class="ec-form-input" type="email" name="email" required placeholder="you@example.com" autocomplete="email"></label>`}
			${exts.map((e) => e.html()).join("")}
			<div data-shipping-block>${addressPicker("shipping", exts.find((e) => e.shippingLabel)?.shippingLabel ?? "Shipping address")}</div>
			<label class="ec-choice ec-choice--single"><input type="checkbox" name="sameBilling" checked><span class="ec-choice__label">Billing address is the same</span></label>
			<div data-billing hidden>${addressPicker("billing", "Billing address")}</div>
			${me ? `<label class="ec-choice ec-choice--single"><input type="checkbox" name="saveAddress" checked><span class="ec-choice__label">Save new addresses to my account</span></label>` : ""}
			${me && account?.paymentMethods.length ? `<fieldset class="ec-form-field"><legend class="ec-form-label">Pay with</legend><div class="ec-choice-list">${account.paymentMethods.map((m, i) => `<label class="ec-choice"><input type="radio" name="paymentMethodId" value="${esc(m.id)}"${i === 0 ? " checked" : ""}><span class="ec-choice__label">${esc(m.brand)} •••• ${esc(m.last4)} <small>(${String(m.expMonth).padStart(2, "0")}/${m.expYear})</small></span></label>`).join("")}<label class="ec-choice"><input type="radio" name="paymentMethodId" value=""><span class="ec-choice__label">Another payment method</span></label></div></fieldset>` : ""}
			${me && cat?.provider === "stripe" ? `<label class="ec-choice ec-choice--single"><input type="checkbox" name="savePaymentMethod"><span class="ec-choice__label">Save this card to my account for next time (stored by Stripe)</span></label>` : ""}
			<div class="ec-checkout__actions">
				<button type="submit" class="ec-form-submit" data-checkout-method="online"${online ? "" : " hidden"}>Pay online</button>
				<button type="submit" class="ec-form-submit ec-form-submit--secondary" data-checkout-method="manual"${manual ? "" : " hidden"}>${exts.find((e) => e.payLaterLabel)?.payLaterLabel ?? "Order now, pay later"}</button>
			</div>
			<p class="ec-form-status" data-checkout-status aria-live="polite"></p>
		</form>`;
	if (!online && !manual) setStatus(root, "Checkout is not configured yet.", true);
	wireSignIn(host);
	const form = host.querySelector<HTMLFormElement>("[data-checkout]")!;
	form.addEventListener("change", (e) => {
		const t = e.target as HTMLInputElement;
		if (t.name === "sameBilling") form.querySelector<HTMLElement>("[data-billing]")!.hidden = t.checked;
		if (t.name.endsWith(".pick")) {
			const prefix = t.name.slice(0, -5);
			const box = form.querySelector<HTMLElement>(`[data-new-address="${prefix}"]`);
			if (box) box.hidden = t.value !== "new";
		}
	});
	for (const e of exts) e.wire?.(form, { manual });
	let method = "online";
	form.querySelectorAll<HTMLButtonElement>("[data-checkout-method]").forEach((b) => b.addEventListener("click", () => (method = b.dataset.checkoutMethod || "online")));
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const buttons = form.querySelectorAll<HTMLButtonElement>("button");
		buttons.forEach((b) => (b.disabled = true));
		setStatus(root, "Starting checkout…");
		const pickOrNew = (prefix: string): { id?: string; address?: AccountAddress } => {
			const pick = (form.elements.namedItem(`${prefix}.pick`) as RadioNodeList | null)?.value;
			if (pick && pick !== "new") return { id: pick };
			const a = readAddress(form, prefix);
			return a.line1 ? { address: a } : {};
		};
		const shipping = pickOrNew("shipping");
		const same = (form.elements.namedItem("sameBilling") as HTMLInputElement | null)?.checked ?? true;
		const billing = same ? shipping : pickOrNew("billing");
		const pm = (form.elements.namedItem("paymentMethodId") as RadioNodeList | null)?.value || undefined;
		const body: Record<string, unknown> = {
			items: readCart().map(serverLine),
			method,
			email: (form.elements.namedItem("email") as HTMLInputElement | null)?.value.trim() || undefined,
			shippingAddressId: shipping.id,
			shippingAddress: shipping.address,
			billingAddressId: billing.id,
			billingAddress: billing.address,
			saveAddress: (form.elements.namedItem("saveAddress") as HTMLInputElement | null)?.checked ?? false,
			paymentMethodId: method === "online" ? pm : undefined,
			savePaymentMethod: (form.elements.namedItem("savePaymentMethod") as HTMLInputElement | null)?.checked ?? false,
			cartToken: me ? undefined : cartToken(),
			couponCode: couponCode() || undefined,
			...checkoutExtensionBody(exts, form),
		};
		try {
			const result = me ? await accountApi<{ url: string; orderId: string; number: number; paid?: boolean }>("checkout/account", body) : await api<{ url: string; orderId: string; number: number }>("checkout", { method: "POST", body: JSON.stringify(body) });
			if (method === "manual" || (result as { paid?: boolean }).paid) clearCart();
			else sessionStorage.setItem("ec-pending-order", result.orderId);
			location.assign(result.url);
		} catch (err) {
			setStatus(root, err instanceof Error ? err.message : "Checkout failed", true);
			buttons.forEach((b) => (b.disabled = false));
		}
	});
}


/* ---- discount codes ------------------------------------------------------- */

const COUPON_KEY = "ec-coupon";
function couponCode(): string {
	return localStorage.getItem(COUPON_KEY) ?? "";
}
function wireCoupon(root: HTMLElement): void {
	const form = root.querySelector<HTMLFormElement>("[data-coupon-form]");
	if (!form) return;
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const code = (form.elements.namedItem("code") as HTMLInputElement).value.trim().toUpperCase();
		if (code) localStorage.setItem(COUPON_KEY, code);
		else localStorage.removeItem(COUPON_KEY);
		await renderDiscountPreview(root);
	});
}
/** Ask the server what the bag is worth with automatic discounts and the entered code. */
async function renderDiscountPreview(root: HTMLElement): Promise<void> {
	const status = root.querySelector<HTMLElement>("[data-coupon-status]");
	const lines = readCart();
	if (!status || lines.length === 0) return;
	try {
		const res = await fetch(`${BASE}/discounts/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: lines.map(serverLine), code: couponCode() || undefined }) });
		const body = (await res.json()) as { success?: boolean; data?: { subtotal: number; discountTotal: number; total: number; coupon: { code: string; title: string; freeShipping: boolean } | null; couponError: string | null }; error?: { message?: string } };
		if (!res.ok || !body.data) throw new Error(body.error?.message ?? "preview failed");
		const data = body.data;
		const foot = root.querySelector<HTMLElement>("tfoot");
		if (foot) {
			foot.innerHTML = `${data.discountTotal ? `<tr><th colspan="2">Subtotal</th><th>${money(data.subtotal)}</th><td></td></tr><tr><th colspan="2">Discount${data.coupon ? ` (${esc(data.coupon.code)})` : ""}</th><th>−${money(data.discountTotal)}</th><td></td></tr>` : ""}<tr><th colspan="2">${data.discountTotal ? "Total" : "Subtotal"}</th><th>${money(data.total)}</th><td></td></tr>`;
		}
		if (data.couponError && couponCode()) {
			status.textContent = data.couponError;
			status.classList.add("ec-form-status--error");
		} else if (data.coupon) {
			status.textContent = `${data.coupon.title} applied${data.coupon.freeShipping ? " · free shipping" : ""}`;
			status.classList.remove("ec-form-status--error");
		} else status.textContent = "";
	} catch {
		/* preview is best effort */
	}
}

/** Minor-unit formatter in the store currency (set once the catalogue loads). */
export const formatCartMoney = (minor: number): string => money(minor);
