/**
 * Signed-in shopper routes (session routes: any authenticated user, no
 * grant). Addresses and the list of vaulted cards live on the customer
 * record; cards themselves are managed at the PSP (detach here, add during
 * checkout or in the PSP's portal).
 */

import { guestCartId, loadCart, mergeLines, normalizeLines, storeCart, userCartId } from "../carts.js";
import { ensurePolarCustomer, ensureStripeCustomer, getCustomer, normalizeAddress, publicCustomer, saveCustomer, upsertAddress } from "../customers.js";
import { orders, publicOrder } from "../orders.js";
import { Polar } from "../polar.js";
import { loadSettings } from "../settings.js";
import type { RouteContext } from "../shim.js";
import { PluginRouteError } from "../shim.js";
import { Stripe } from "../stripe.js";
import type { Address } from "../types.js";

function requireUser(ctx: RouteContext) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in to continue");
	return ctx.user;
}

export async function accountGetHandler(ctx: RouteContext) {
	const user = requireUser(ctx);
	const settings = await loadSettings(ctx);
	const c = await getCustomer(ctx, user);
	return { customer: publicCustomer(c), provider: settings.paymentProvider, customerAccounts: settings.customerAccounts };
}

export async function accountAddressSaveHandler(ctx: RouteContext<{ address: Partial<Address> }>) {
	const user = requireUser(ctx);
	const c = await getCustomer(ctx, user);
	if (c.addresses.length >= 20 && !c.addresses.some((a) => a.id === ctx.input.address?.id)) throw PluginRouteError.badRequest("Address book is full");
	const address = upsertAddress(c, normalizeAddress(ctx.input.address ?? {}));
	await saveCustomer(ctx, c);
	return { address, customer: publicCustomer(c) };
}

export async function accountAddressDeleteHandler(ctx: RouteContext<{ id: string }>) {
	const user = requireUser(ctx);
	const c = await getCustomer(ctx, user);
	c.addresses = c.addresses.filter((a) => a.id !== ctx.input.id);
	if (c.addresses.length && !c.addresses.some((a) => a.isDefault)) c.addresses[0]!.isDefault = true;
	await saveCustomer(ctx, c);
	return { customer: publicCustomer(c) };
}

export async function accountPaymentMethodDeleteHandler(ctx: RouteContext<{ id: string }>) {
	const user = requireUser(ctx);
	const settings = await loadSettings(ctx);
	const c = await getCustomer(ctx, user);
	const pm = c.paymentMethods.find((m) => m.id === ctx.input.id);
	if (!pm) throw PluginRouteError.notFound("Payment method not found");
	if (pm.provider === "stripe" && settings.stripeSecretKey) await Stripe.from(ctx, settings.stripeSecretKey).detachPaymentMethod(pm.token).catch(() => undefined);
	c.paymentMethods = c.paymentMethods.filter((m) => m.id !== ctx.input.id);
	await saveCustomer(ctx, c);
	return { customer: publicCustomer(c) };
}

/** URL of the PSP's own portal for the shopper (manage cards, see invoices). */
export async function accountPortalHandler(ctx: RouteContext<{ returnUrl?: string }>) {
	const user = requireUser(ctx);
	const settings = await loadSettings(ctx);
	const c = await getCustomer(ctx, user);
	const returnUrl = typeof ctx.input.returnUrl === "string" && /^https:\/\//.test(ctx.input.returnUrl) ? ctx.input.returnUrl : `${ctx.site?.url ?? ""}/account`;
	if (settings.paymentProvider === "stripe") {
		const id = await ensureStripeCustomer(ctx, settings, c);
		const s = await Stripe.from(ctx, settings.stripeSecretKey).createBillingPortalSession(id, returnUrl);
		return { url: s.url };
	}
	if (settings.paymentProvider === "polar") {
		const id = await ensurePolarCustomer(ctx, settings, c);
		return { url: await Polar.from(ctx, settings.polarAccessToken).createCustomerSession(id) };
	}
	throw PluginRouteError.badRequest("No payment provider is configured");
}

export async function accountOrdersHandler(ctx: RouteContext) {
	const user = requireUser(ctx);
	const res = await orders(ctx).query({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, limit: 50 });
	return { orders: res.items.map((o) => publicOrder(o.id, o.data)) };
}

/* ---- carts --------------------------------------------------------------- */

/** The signed-in shopper's cart; `merge` folds a guest cart (by token or lines) into it. */
export async function cartGetHandler(ctx: RouteContext<{ mergeToken?: string; mergeLines?: unknown }>) {
	const user = requireUser(ctx);
	const id = userCartId(user.id);
	let cart = await loadCart(ctx, id);
	const incoming = ctx.input.mergeToken ? await loadCart(ctx, guestCartId(ctx.input.mergeToken)) : null;
	const extra = incoming?.lines ?? normalizeLines(ctx.input.mergeLines);
	if (extra.length) {
		cart = await storeCart(ctx, id, { lines: mergeLines(cart?.lines ?? [], extra) }, { userId: user.id });
		if (incoming && ctx.input.mergeToken) await storeCart(ctx, guestCartId(ctx.input.mergeToken), { lines: [] }, { token: ctx.input.mergeToken });
	}
	return { cart: cart ? { id, lines: cart.lines, updatedAt: cart.updatedAt } : { id, lines: [], updatedAt: null } };
}

export async function cartSaveHandler(ctx: RouteContext<{ lines: unknown; email?: string }>) {
	const user = requireUser(ctx);
	const id = userCartId(user.id);
	const cart = await storeCart(ctx, id, { lines: normalizeLines(ctx.input.lines), email: user.email }, { userId: user.id });
	return { cart: { id, lines: cart.lines, updatedAt: cart.updatedAt } };
}

/** Guest carts: addressed by a random token the browser keeps. */
export async function cartGuestHandler(ctx: RouteContext<{ token: string; op?: "get" | "save"; lines?: unknown; email?: string }>) {
	const id = guestCartId(ctx.input.token);
	if (ctx.input.op === "save") {
		const cart = await storeCart(ctx, id, { lines: normalizeLines(ctx.input.lines), ...(typeof ctx.input.email === "string" ? { email: ctx.input.email.slice(0, 200) } : {}) }, { token: ctx.input.token });
		return { cart: { id, lines: cart.lines, updatedAt: cart.updatedAt } };
	}
	const cart = await loadCart(ctx, id);
	return { cart: cart ? { id, lines: cart.lines, updatedAt: cart.updatedAt } : null };
}
