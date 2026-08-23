/**
 * Customer accounts on the storefront: sign-in (email link), the account
 * page (addresses, saved cards, orders), and helpers the cart/checkout use
 * to know who is shopping. Cards are vaulted by the payment provider; the
 * store only ever sees brand + last4.
 */
import { API } from "../../lib/client";

export { API };
const BASE = `${API}/_emdash/api/plugins/premium-commerce`;

export interface Me {
	id: string;
	email: string;
	name?: string | null;
}
export interface AccountAddress {
	id?: string;
	label?: string;
	name?: string;
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string;
	phone?: string;
	isDefault?: boolean;
}
export interface AccountPaymentMethod {
	id: string;
	provider: string;
	brand: string;
	last4: string;
	expMonth: number;
	expYear: number;
}
export interface Account {
	email: string;
	name: string | null;
	addresses: AccountAddress[];
	paymentMethods: AccountPaymentMethod[];
	providers: { stripe: boolean; polar: boolean };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function api<T>(route: string, body: unknown = {}): Promise<T> {
	const res = await fetch(`${BASE}/${route}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify(body) });
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string; code?: string } };
	if (!res.ok || json.success === false) {
		const err = new Error(json.error?.message ?? `Request failed (${res.status})`) as Error & { status?: number };
		err.status = res.status;
		throw err;
	}
	return json.data as T;
}

let mePromise: Promise<Me | null> | null = null;
/** The signed-in shopper, or null (cached per page). */
export function whoAmI(): Promise<Me | null> {
	if (!mePromise) {
		mePromise = fetch(`${API}/_emdash/api/auth/me`, { credentials: "include" })
			.then(async (r) => (r.ok ? (((await r.json()) as { data?: Me }).data ?? null) : null))
			.catch(() => null);
	}
	return mePromise;
}

export async function signOut(): Promise<void> {
	await fetch(`${API}/_emdash/api/auth/logout`, { method: "POST", credentials: "include", headers: { "X-EmDash-Request": "1" } }).catch(() => undefined);
	mePromise = null;
}

export const formatAddress = (a: AccountAddress) => [a.name, a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(" "), a.state, a.country].filter(Boolean).join(", ");

/* ---- sign-in form: [data-customer-signin] ------------------------------- */

export function signInFormHtml(redirect = location.pathname): string {
	return `<form class="ec-form ec-signin" data-customer-signin data-redirect="${esc(redirect)}">
		<label class="ec-form-field"><span class="ec-form-label">Email</span><input class="ec-form-input" type="email" name="email" required placeholder="you@example.com" autocomplete="email"></label>
		<button type="submit" class="ec-form-submit">Email me a sign-in link</button>
		<p class="ec-form-status" data-status aria-live="polite"></p>
		<p class="ec-form-help">No password: we email you a link. First time? Your account is created on the spot.</p>
	</form>`;
}

export function wireSignIn(root: ParentNode): void {
	root.querySelectorAll<HTMLFormElement>("[data-customer-signin]:not([data-wired])").forEach((form) => {
		form.dataset.wired = "1";
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
			const status = form.querySelector<HTMLElement>("[data-status]")!;
			const btn = form.querySelector<HTMLButtonElement>("button")!;
			btn.disabled = true;
			status.textContent = "Sending…";
			try {
				const r = await fetch(`${API}/_emdash/api/auth/customer/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, redirect: form.dataset.redirect || "/account" }) });
				const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
				status.textContent = r.ok ? "Check your inbox for the sign-in link." : (j.error?.message ?? "Could not send the link");
			} catch {
				status.textContent = "Could not send the link";
			}
			btn.disabled = false;
		});
	});
}

/* ---- address form ---------------------------------------------------------- */

export function addressFormHtml(prefix: string, a: AccountAddress = {}, opts: { label?: boolean } = {}): string {
	const f = (name: string, label: string, value: string | undefined, extra = "") => `<label class="ec-form-field ec-form-field--half"><span class="ec-form-label">${label}</span><input class="ec-form-input" name="${prefix}.${name}" value="${esc(value ?? "")}" ${extra}></label>`;
	return `<div class="ec-address-form">
		${opts.label ? f("label", "Label (e.g. Home)", a.label) : ""}
		${f("name", "Full name", a.name, 'autocomplete="name"')}
		${f("phone", "Phone", a.phone, 'autocomplete="tel"')}
		${f("line1", "Street address", a.line1, 'autocomplete="address-line1" required')}
		${f("line2", "Apartment, suite…", a.line2, 'autocomplete="address-line2"')}
		${f("city", "City", a.city, 'autocomplete="address-level2" required')}
		${f("state", "State / region", a.state, 'autocomplete="address-level1"')}
		${f("postalCode", "Postal code", a.postalCode, 'autocomplete="postal-code"')}
		${f("country", "Country (2 letters)", a.country, 'autocomplete="country" maxlength="2" required placeholder="US"')}
	</div>`;
}

export function readAddress(form: HTMLElement, prefix: string): AccountAddress {
	const out: AccountAddress = {};
	form.querySelectorAll<HTMLInputElement>(`[name^="${prefix}."]`).forEach((i) => {
		const key = i.name.slice(prefix.length + 1) as keyof AccountAddress;
		if (i.value.trim()) (out as Record<string, unknown>)[key] = i.value.trim();
	});
	return out;
}

/* ---- account page: [data-account] ------------------------------------------ */

export async function renderAccount(root: HTMLElement): Promise<void> {
	const me = await whoAmI();
	if (!me) {
		root.innerHTML = `<h1>Your account</h1><p>Sign in to see your orders, addresses and saved payment methods.</p>${signInFormHtml("/account")}`;
		wireSignIn(root);
		return;
	}
	let account: Account;
	let provider = "none";
	try {
		const r = await api<{ customer: Account; provider: string; customerAccounts: boolean }>("account/get");
		account = r.customer;
		provider = r.provider;
	} catch (err) {
		root.innerHTML = `<h1>Your account</h1><p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Unavailable")}</p>`;
		return;
	}
	const ordersRes = await api<{ orders: Array<{ number: number; status: string; total: number; currency: string; createdAt: string; items: Array<{ title: string; quantity: number }> }> }>("account/orders").catch(() => ({ orders: [] }));
	const money = (n: number, c: string) => new Intl.NumberFormat(undefined, { style: "currency", currency: c.toUpperCase() }).format(n / 100);
	const appts = await fetch(`${API}/_emdash/api/plugins/premium-bookings/account/bookings`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: "{}" })
		.then(async (r) => ((await r.json()) as { data?: { bookings: Array<{ id: string; service: string; staff: string; when: string; status: string }> } }).data ?? { bookings: [] })
		.catch(() => ({ bookings: [] as Array<{ id: string; service: string; staff: string; when: string; status: string }> }));
	root.innerHTML = `
		<header class="ec-account__head"><h1>Your account</h1><p>${esc(me.email)} · <button type="button" class="ec-link" data-signout>Sign out</button></p></header>
		<section class="ec-account__section">
			<h2>Orders</h2>
			${ordersRes.orders.length ? `<table class="ec-cart__table"><thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Total</th></tr></thead><tbody>${ordersRes.orders.map((o) => `<tr><td>#${o.number}<br><small>${new Date(o.createdAt).toLocaleDateString()}</small></td><td>${esc(o.items.map((i) => `${i.quantity}× ${i.title}`).join(", "))}</td><td>${esc(o.status.replace("_", " "))}</td><td>${money(o.total, o.currency)}</td></tr>`).join("")}</tbody></table>` : `<p>No orders yet.</p>`}
		</section>
		${appts.bookings.length ? `<section class="ec-account__section"><h2>Appointments</h2><table class="ec-cart__table"><thead><tr><th>Service</th><th>When</th><th>With</th><th>Status</th></tr></thead><tbody>${appts.bookings.map((b) => `<tr><td>${esc(b.service)}</td><td>${esc(b.when)}</td><td>${esc(b.staff)}</td><td>${esc(b.status.replace("_", " "))}</td></tr>`).join("")}</tbody></table></section>` : ""}
		<section class="ec-account__section">
			<h2>Addresses</h2>
			<div class="ec-address-list" data-addresses>${account.addresses.map((a) => `<div class="ec-address-card"><strong>${esc(a.label || "Address")}${a.isDefault ? " · default" : ""}</strong><p>${esc(formatAddress(a))}</p><p><button type="button" class="ec-link" data-edit-address="${esc(a.id)}">Edit</button> · <button type="button" class="ec-link" data-delete-address="${esc(a.id)}">Delete</button></p></div>`).join("") || "<p>No saved addresses.</p>"}</div>
			<details class="ec-account__add" data-address-editor><summary>Add an address</summary>
				<form data-address-form>${addressFormHtml("addr", {}, { label: true })}<input type="hidden" name="addr.id" value=""><label class="ec-choice ec-choice--single"><input type="checkbox" name="addr.isDefault"><span class="ec-choice__label">Use as default</span></label><div class="ec-checkout__actions"><button type="submit" class="ec-form-submit">Save address</button></div><p class="ec-form-status" data-status></p></form>
			</details>
		</section>
		<section class="ec-account__section">
			<h2>Payment methods</h2>
			<p class="ec-form-help">Cards are stored by ${provider === "polar" ? "Polar" : "Stripe"}, never by this store. Tick “save this card” at checkout to add one.</p>
			<div data-payment-methods>${account.paymentMethods.map((m) => `<div class="ec-address-card"><strong>${esc(m.brand)} •••• ${esc(m.last4)}</strong><p>Expires ${String(m.expMonth).padStart(2, "0")}/${m.expYear}</p><p><button type="button" class="ec-link" data-delete-pm="${esc(m.id)}">Remove</button></p></div>`).join("") || "<p>No saved cards.</p>"}</div>
			${provider !== "none" ? `<p><button type="button" class="ec-add-to-cart" data-portal>Manage billing at ${provider === "polar" ? "Polar" : "Stripe"}</button></p>` : ""}
		</section>`;
	root.addEventListener("click", async (e) => {
		const t = (e.target as HTMLElement).closest<HTMLElement>("[data-signout],[data-delete-address],[data-edit-address],[data-delete-pm],[data-portal]");
		if (!t) return;
		if (t.dataset.signout !== undefined) {
			await signOut();
			location.reload();
		} else if (t.dataset.deleteAddress) {
			if (!confirm("Delete this address?")) return;
			await api("account/address-delete", { id: t.dataset.deleteAddress });
			void renderAccount(root);
		} else if (t.dataset.editAddress) {
			const a = account.addresses.find((x) => x.id === t.dataset.editAddress);
			const editor = root.querySelector<HTMLDetailsElement>("[data-address-editor]")!;
			const form = editor.querySelector<HTMLFormElement>("[data-address-form]")!;
			form.querySelector<HTMLElement>(".ec-address-form")!.outerHTML = addressFormHtml("addr", a, { label: true });
			(form.elements.namedItem("addr.id") as HTMLInputElement).value = a?.id ?? "";
			editor.open = true;
			editor.scrollIntoView({ behavior: "smooth", block: "center" });
		} else if (t.dataset.deletePm) {
			if (!confirm("Remove this saved card?")) return;
			await api("account/payment-method-delete", { id: t.dataset.deletePm });
			void renderAccount(root);
		} else if (t.dataset.portal !== undefined) {
			t.setAttribute("disabled", "");
			try {
				const { url } = await api<{ url: string }>("account/portal", { returnUrl: location.href });
				location.assign(url);
			} catch (err) {
				alert(err instanceof Error ? err.message : "Unavailable");
				t.removeAttribute("disabled");
			}
		}
	});
	root.querySelector<HTMLFormElement>("[data-address-form]")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const form = e.currentTarget as HTMLFormElement;
		const status = form.querySelector<HTMLElement>("[data-status]")!;
		const address = readAddress(form, "addr");
		const id = (form.elements.namedItem("addr.id") as HTMLInputElement).value;
		if (id) address.id = id;
		address.isDefault = (form.elements.namedItem("addr.isDefault") as HTMLInputElement).checked;
		try {
			await api("account/address-save", { address });
			void renderAccount(root);
		} catch (err) {
			status.textContent = err instanceof Error ? err.message : "Could not save";
		}
	});
}

export function initAccount(): void {
	document.querySelectorAll<HTMLElement>("[data-account]").forEach((el) => void renderAccount(el));
	wireSignIn(document);
	// Header helpers: [data-account-link] shows "Account" vs "Sign in".
	void whoAmI().then((me) => {
		document.querySelectorAll<HTMLElement>("[data-account-link]").forEach((el) => {
			el.textContent = me ? (el.dataset.labelIn ?? "Account") : (el.dataset.labelOut ?? "Sign in");
		});
	});
}
