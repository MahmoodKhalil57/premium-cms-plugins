/**
 * The bag as a slide-in drawer: any link to /cart (header pill, "View cart",
 * product cards) opens it; adding to the bag opens it too. Step one lists the
 * lines, step two is the same checkout form as the /cart page (which stays
 * as a no-JS fallback).
 */

export interface DrawerHooks {
	renderLines(root: HTMLElement): void;
	renderCheckout(root: HTMLElement): Promise<void>;
	count(): number;
}

const CSS = `
.ec-drawer{position:fixed;inset:0;z-index:2147482000;display:none}
.ec-drawer.is-open{display:block}
.ec-drawer__scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .2s}
.ec-drawer.is-open .ec-drawer__scrim{opacity:1}
.ec-drawer__panel{position:absolute;top:0;inset-inline-end:0;height:100%;width:min(480px,100vw);background:var(--color-bg,#fff);color:var(--color-text,#1a1a1a);box-shadow:-12px 0 40px rgba(0,0,0,.25);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease}
[dir=rtl] .ec-drawer__panel{transform:translateX(-100%)}
.ec-drawer.is-open .ec-drawer__panel{transform:none}
.ec-drawer__head{display:flex;align-items:center;gap:.75rem;padding:1rem 1.25rem;border-bottom:1px solid var(--color-border-subtle,#eee)}
.ec-drawer__head h2{margin:0;font-size:1.125rem;flex:1}
.ec-drawer__close,.ec-drawer__back{font:inherit;background:none;border:0;cursor:pointer;color:inherit;font-size:1.25rem;line-height:1;padding:.25rem .5rem;border-radius:var(--radius,6px)}
.ec-drawer__body{flex:1;overflow:auto;padding:1rem 1.25rem}
.ec-drawer__body .ec-cart__table td,.ec-drawer__body .ec-cart__table th{padding:.5rem .25rem;font-size:.9rem}
.ec-drawer__body .ec-cart__table thead{display:none}
.ec-drawer__body .ec-cart__table input[type=number]{width:3.5rem}
.ec-drawer__body .ec-address-form{grid-template-columns:1fr}
.ec-drawer__body input,.ec-drawer__body select,.ec-drawer__body textarea{box-sizing:border-box;max-width:100%}
.ec-drawer__body .ec-form-field,.ec-drawer__body fieldset{min-width:0}
.ec-drawer__foot{padding:1rem 1.25rem;border-top:1px solid var(--color-border-subtle,#eee);display:grid;gap:.5rem}
.ec-drawer__foot .ec-form-submit{width:100%}
.ec-drawer__subtotal{display:flex;justify-content:space-between;font-weight:600}
@media (prefers-reduced-motion:reduce){.ec-drawer__panel,.ec-drawer__scrim{transition:none}}
body.ec-drawer-open{overflow:hidden}
`;

let drawer: HTMLElement | null = null;
let hooks: DrawerHooks | null = null;
let step: "bag" | "checkout" = "bag";

function ensure(): HTMLElement {
	if (drawer) return drawer;
	const el = document.createElement("div");
	el.className = "ec-drawer";
	el.setAttribute("aria-hidden", "true");
	el.innerHTML = `<style>${CSS}</style><div class="ec-drawer__scrim" data-close></div>
		<aside class="ec-drawer__panel" role="dialog" aria-modal="true" aria-label="Your bag">
			<div class="ec-drawer__head"><button type="button" class="ec-drawer__back" data-back hidden aria-label="Back to bag">‹</button><h2 data-title>Your bag</h2><button type="button" class="ec-drawer__close" data-close aria-label="Close">×</button></div>
			<div class="ec-drawer__body" data-body></div>
			<div class="ec-drawer__foot" data-foot></div>
		</aside>`;
	document.body.appendChild(el);
	el.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		if (t.closest("[data-close]")) close();
		else if (t.closest("[data-back]")) void show("bag");
		else if (t.closest("[data-checkout-go]")) void show("checkout");
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && el.classList.contains("is-open")) close();
	});
	drawer = el;
	return el;
}

export async function show(next: "bag" | "checkout" = "bag"): Promise<void> {
	const el = ensure();
	if (!hooks) return;
	step = next;
	const body = el.querySelector<HTMLElement>("[data-body]")!;
	const foot = el.querySelector<HTMLElement>("[data-foot]")!;
	const title = el.querySelector<HTMLElement>("[data-title]")!;
	const back = el.querySelector<HTMLElement>("[data-back]")!;
	el.classList.add("is-open");
	el.setAttribute("aria-hidden", "false");
	document.body.classList.add("ec-drawer-open");
	if (step === "bag") {
		title.textContent = "Your bag";
		back.hidden = true;
		body.innerHTML = `<div data-cart></div>`;
		hooks.renderLines(body);
		const n = hooks.count();
		foot.innerHTML = n
			? `<button type="button" class="ec-form-submit ec-form-submit--primary" data-checkout-go>Checkout</button><a class="ec-link" href="/products" style="text-align:center">Continue shopping</a>`
			: `<a class="ec-form-submit ec-form-submit--primary" href="/products" style="text-align:center;text-decoration:none">Browse the shop</a>`;
	} else {
		title.textContent = "Checkout";
		back.hidden = false;
		body.innerHTML = `<div data-cart-summary></div><div data-checkout-host></div>`;
		foot.innerHTML = "";
		await hooks.renderCheckout(body);
	}
	window.setTimeout(() => el.querySelector<HTMLElement>("[data-close]")?.focus(), 50);
}

export function close(): void {
	if (!drawer) return;
	drawer.classList.remove("is-open");
	drawer.setAttribute("aria-hidden", "true");
	document.body.classList.remove("ec-drawer-open");
}

export function isOpen(): boolean {
	return !!drawer?.classList.contains("is-open");
}

/** Wire links to /cart and bag buttons to open the drawer instead of navigating. */
export function initCartDrawer(h: DrawerHooks): void {
	hooks = h;
	document.addEventListener("click", (e) => {
		const a = (e.target as HTMLElement).closest<HTMLAnchorElement | HTMLElement>("a[href$='/cart'], a[href$='/cart/'], [data-cart-open], .ec-cart-link");
		if (!a || (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey) return;
		if (document.querySelector("[data-cart]:not(.ec-drawer [data-cart])") && location.pathname.replace(/\/$/, "") === "/cart") return; // already on the page
		e.preventDefault();
		void show("bag");
	});
	// Re-render the open bag when the cart changes (quantity edits, adds).
	document.addEventListener("ec-cart:change", () => {
		if (isOpen() && step === "bag") void show("bag");
	});
}
