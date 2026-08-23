/**
 * Visitor-facing routes: catalog, availability, checkout, confirm, webhook,
 * order lookup. No authentication — everything is validated against the CMS,
 * the payment provider and the sibling plugins that price provider lines or
 * validate checkout extensions.
 */

import { available, availableForChoice, getProduct, inventoryFor, listProducts, reserveStock, stockKeysOf } from "../catalog.js";
import { type DesignDoc, designToSvg } from "../fields.js";
import { cancelOrder, emitOrderEvent, event, findBySession, finalizeFromPaymentIntent, finalizeFromSession, newOrderId, nextOrderNumber, orders, PENDING_TTL_MS, publicOrder, randomToken, saveOrder, sendOrderEmails, stockLines } from "../orders.js";
import { lineSummary, resolveLine } from "../pricing.js";
import { guestCartId, markConverted, userCartId } from "../carts.js";
import { applyDiscounts, automaticSale, liveDiscounts, recordCouponUse } from "../discounts.js";
import { customers, ensurePolarCustomer, ensureStripeCustomer, getCustomer, normalizeAddress, rememberPaymentMethod, saveCustomer, upsertAddress } from "../customers.js";
import { recordTransaction } from "../transactions.js";
import { checkoutToSession, Polar } from "../polar.js";
import type { AddressInput, CheckoutInput } from "../schemas.js";
import { formatMoney } from "../money.js";
import { loadSettings } from "../settings.js";
import type { RouteContext, UserInfo } from "../shim.js";
import { PluginRouteError } from "../shim.js";
import { Stripe, type StripePaymentIntent, type StripeSession } from "../stripe.js";
import type { Address, CheckoutExtension, Order, OrderAdjustment, OrderItem, ProviderLine } from "../types.js";

export async function catalogHandler(ctx: RouteContext) {
	const settings = await loadSettings(ctx);
	const products = await listProducts(ctx, settings.currency);
	const inv = await inventoryFor(ctx, products.map((p) => p.id));
	const promos = await liveDiscounts(ctx);
	return {
		currency: settings.currency,
		hasCoupons: promos.some((d) => d.data.code),
		manualPayment: settings.allowManualPayment,
		provider: settings.paymentProvider,
		customerAccounts: settings.customerAccounts,
		online: settings.paymentProvider !== "none",
		stripe: settings.paymentProvider !== "none",
		products: products.map((p) => {
			const sale = automaticSale(promos, p, p.unitAmount, settings.currency);
			return { ...p, available: available(p, inv.get(p.id)), ...(sale ? { saleUnitAmount: sale.unitAmount, saleLabel: sale.applied.title } : {}) };
		}),
	};
}

export async function availabilityHandler(ctx: RouteContext<{ ids?: string | string[] }>) {
	const settings = await loadSettings(ctx);
	const raw = ctx.input.ids;
	const ids = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
	const products = await listProducts(ctx, settings.currency);
	const wanted = ids.length > 0 ? products.filter((p) => ids.includes(p.id) || ids.includes(p.slug)) : products;
	const inv = await inventoryFor(ctx, wanted.map((p) => p.id));
	const out: Record<string, number | null> = {};
	for (const p of wanted) {
		const a = available(p, inv.get(p.id));
		out[p.id] = a;
		out[p.slug] = a;
	}
	return { currency: settings.currency, availability: out };
}

function siteOrigin(ctx: RouteContext): string {
	const fromSite = ctx.site?.url?.replace(/\/$/, "");
	if (fromSite) return fromSite;
	try {
		return new URL(ctx.request.url).origin;
	} catch {
		return "";
	}
}

/** Guest checkout (public route): no account, nothing saved. */
export async function checkoutHandler(ctx: RouteContext<CheckoutInput>) {
	return createCheckout(ctx, ctx.input, null);
}

/** Signed-in checkout (session route): saved addresses and vaulted cards are available. */
export async function accountCheckoutHandler(ctx: RouteContext<CheckoutInput>) {
	if (!ctx.user) throw PluginRouteError.forbidden("Sign in to continue");
	return createCheckout(ctx, ctx.input, ctx.user);
}

const addressFor = (a: Address | undefined) => (a ? { name: a.name, line1: a.line1, line2: a.line2, city: a.city, state: a.state, postalCode: a.postalCode, country: a.country, phone: a.phone } : undefined);

/** `<pluginId>:<ref>` → provider line (plugin ids are kebab-case; product ids/slugs never contain a colon). */
export function providerRef(productId: string): { provider: string; ref: string } | null {
	const m = /^([a-z][a-z0-9-]{1,60}):(.+)$/.exec(productId);
	if (!m || m[1] === "balance") return null;
	return { provider: m[1]!, ref: m[2]! };
}

/** Ask the owning plugin what a provider line is and costs right now. */
export async function resolveProviderLine(ctx: RouteContext, productId: string, quantity: number, who: { email?: string; userId?: string | null }): Promise<OrderItem & { fullAmount: number; depositAmount: number }> {
	const pr = providerRef(productId);
	if (!pr) throw PluginRouteError.badRequest(`Product not available: ${productId}`);
	if (!ctx.plugins) throw PluginRouteError.internal("Plugin interop is not available");
	let r: ProviderLine | null;
	try {
		r = await ctx.plugins.call<ProviderLine | null>(pr.provider, "commerce/line", { ref: pr.ref, quantity, email: who.email, userId: who.userId ?? null });
	} catch (err) {
		throw PluginRouteError.badRequest(err instanceof Error ? err.message : "That item is no longer available");
	}
	if (!r || typeof r.unitAmount !== "number" || !r.title) throw PluginRouteError.badRequest("That item is no longer available");
	if (r.unitAmount <= 0) throw PluginRouteError.badRequest(`${r.title} does not need payment`);
	const dep = Math.max(0, Math.round(r.depositAmount ?? 0));
	const full = Math.max(r.unitAmount, Math.round(r.fullAmount ?? r.unitAmount));
	return {
		productId,
		slug: `${pr.provider}-${pr.ref}`.slice(0, 120),
		title: r.title,
		sku: r.sku,
		unitAmount: Math.round(r.unitAmount),
		quantity: Math.max(1, Math.round(r.quantity ?? quantity)),
		requiresShipping: false,
		provider: pr.provider,
		ref: pr.ref,
		...(r.display?.length ? { optionsDisplay: r.display } : {}),
		fullAmount: full,
		depositAmount: dep,
	};
}

async function createCheckout(ctx: RouteContext, input: CheckoutInput, user: UserInfo | null) {
	const settings = await loadSettings(ctx);

	// Account context: saved addresses / cards, and the PSP customer the order is tied to.
	const customer = user ? await getCustomer(ctx, user) : null;
	const pickAddress = (id: string | undefined, given: AddressInput | undefined): Address | undefined => {
		if (customer && id) {
			const a = customer.addresses.find((x) => x.id === id);
			if (!a) throw PluginRouteError.badRequest("That saved address no longer exists");
			return a;
		}
		return given && (given.line1 || given.city) ? normalizeAddress(given) : undefined;
	};
	const shippingAddress = pickAddress(input.shippingAddressId, input.shippingAddress);
	const billingAddress = pickAddress(input.billingAddressId, input.billingAddress) ?? shippingAddress;
	if (customer && input.saveAddress) {
		for (const a of [shippingAddress, billingAddress]) if (a && !customer.addresses.some((x) => x.id === a.id)) upsertAddress(customer, a);
		await saveCustomer(ctx, customer);
	}
	const email = input.email ?? customer?.email ?? "";

	// Merge duplicate lines (same product, same options, same design), resolve every product from the CMS.
	const lineKey = (it: (typeof input.items)[number]) => `${it.productId}|${JSON.stringify(Object.entries(it.options ?? {}).sort())}|${it.customization ? JSON.stringify(it.customization) : ""}`;
	const lines = new Map<string, (typeof input.items)[number]>();
	for (const it of input.items) {
		const k = lineKey(it);
		const cur = lines.get(k);
		if (cur) cur.quantity += it.quantity;
		else lines.set(k, { ...it });
	}
	const products = await listProducts(ctx, settings.currency);
	const items: OrderItem[] = [];
	const resolved = new Map<string, (typeof products)[number]>();
	// Provider lines (`<pluginId>:<ref>`) are priced by the plugin that owns them — a deposit makes the order a payment plan.
	const planAcc = { full: 0, dep: 0, bal: 0, any: false };
	for (const line of lines.values()) {
		if (providerRef(line.productId)) {
			const pl = await resolveProviderLine(ctx, line.productId, line.quantity, { email, userId: user?.id ?? null });
			const { fullAmount, depositAmount, ...item } = pl;
			items.push(item);
			if (depositAmount > 0) {
				planAcc.any = true;
				planAcc.full += fullAmount * item.quantity;
				planAcc.dep += item.unitAmount * item.quantity;
				planAcc.bal += (fullAmount - item.unitAmount) * item.quantity;
			}
			continue;
		}
		const p = products.find((x) => x.id === line.productId || x.slug === line.productId);
		if (!p) throw PluginRouteError.badRequest(`Product not available: ${line.productId}`);
		resolved.set(p.id, p);
		// The definition decides the price: values are validated and deltas re-added here, never taken from the client.
		const r = await resolveLine(ctx, p, settings.currency, line.options, line.customization);
		items.push({
			productId: p.id,
			slug: p.slug,
			title: p.title,
			sku: p.sku,
			unitAmount: r.unitAmount,
			quantity: line.quantity,
			requiresShipping: p.requiresShipping,
			...(r.options ? { options: r.options } : {}),
			...(r.optionsDisplay ? { optionsDisplay: r.optionsDisplay } : {}),
			...(r.extras ? { extras: r.extras, baseUnitAmount: r.baseUnitAmount } : {}),
			...(r.customization ? { customization: r.customization } : {}),
			...(r.stockKeys.length > 1 ? { stockKeys: r.stockKeys } : {}),
		});
	}
	// Availability (best effort — there are no transactions in plugin storage): per product and per tracked choice.
	const need = new Map<string, number>();
	for (const it of items) if (!it.provider) for (const key of stockKeysOf(it)) need.set(key, (need.get(key) ?? 0) + it.quantity);
	const inv = await inventoryFor(ctx, [...need.keys()]);
	for (const [key, quantity] of need) {
		const [productId, choice] = key.split("#", 2) as [string, string | undefined];
		const p = resolved.get(productId)!;
		let a: number | null;
		if (!choice) a = available(p, inv.get(key));
		else {
			const [field, value] = choice.split("=", 2) as [string, string];
			const opt = p.options?.find((f) => f.name === field)?.options?.find((o) => o.value === value);
			a = typeof opt?.stock === "number" ? availableForChoice(opt.stock, inv.get(key)) : null;
		}
		const what = choice ? `"${p.title}" (${choice.split("=")[1]})` : `"${p.title}"`;
		if (a !== null && a < quantity) throw PluginRouteError.conflict(a === 0 ? `${what} is sold out` : `Only ${a} of ${what} left`);
	}

	// Discounts: automatic promotions per line, then the coupon (if any) — all from the records, never the client. Provider lines are never discounted.
	const priced = await applyDiscounts(ctx, items.map((it) => ({ productId: it.productId, slug: it.slug, quantity: it.quantity, unitAmount: it.provider ? 0 : it.unitAmount })), settings.currency, { code: input.couponCode, customerKey: user?.id ?? email.toLowerCase() ?? null });
	if (input.couponCode && priced.couponError) throw PluginRouteError.badRequest(priced.couponError);
	for (const [i, it] of items.entries()) {
		const pl = priced.lines[i]!;
		if (it.provider) continue;
		if (pl.finalUnitAmount !== it.unitAmount) {
			it.originalUnitAmount = it.unitAmount;
			it.unitAmount = pl.finalUnitAmount;
			it.discounts = pl.applied;
		}
	}
	const subtotal = items.reduce((n, it) => n + it.unitAmount * it.quantity, 0);

	// Checkout extensions: each named plugin validates its part of the order and may add fees / tips and vouch for pay-later.
	const adjustments: OrderAdjustment[] = [];
	const extensions: Record<string, unknown> = {};
	let allowPayLater = settings.allowManualPayment;
	let requireEmail = true;
	for (const [pluginId, data] of Object.entries(input.extensions ?? {})) {
		if (!/^[a-z][a-z0-9-]{1,60}$/.test(pluginId)) throw PluginRouteError.badRequest(`Unknown checkout extension: ${pluginId}`);
		if (!ctx.plugins) throw PluginRouteError.internal("Plugin interop is not available");
		let ext: CheckoutExtension;
		try {
			ext = await ctx.plugins.call<CheckoutExtension>(pluginId, "commerce/checkout", {
				data,
				method: input.method,
				items: items.map((it) => ({ productId: it.productId, slug: it.slug, title: it.title, quantity: it.quantity, unitAmount: it.unitAmount, options: it.options ?? null, optionsDisplay: it.optionsDisplay ?? null, provider: it.provider ?? null })),
				subtotal,
				currency: settings.currency,
				email,
				name: input.name ?? customer?.name ?? null,
				phone: input.phone ?? null,
				shippingAddress: addressFor(shippingAddress) ?? null,
				userId: user?.id ?? null,
			});
		} catch (err) {
			throw PluginRouteError.badRequest(err instanceof Error ? err.message : `${pluginId} rejected the order`);
		}
		for (const a of ext?.adjustments ?? []) adjustments.push({ label: String(a.label).slice(0, 80), amount: Math.round(Number(a.amount) || 0), provider: pluginId, key: a.key });
		if (ext?.meta !== undefined) extensions[pluginId] = ext.meta;
		if (ext?.allowPayLater) allowPayLater = true;
		if (ext?.requireEmail === false) requireEmail = false;
	}
	const extrasTotal = adjustments.reduce((n, a) => n + a.amount, 0);

	if (input.method === "manual" && !allowPayLater) throw PluginRouteError.badRequest("Pay-later orders are not enabled");
	// Any online method resolves to the store's configured provider.
	const method = input.method === "manual" ? ("manual" as const) : settings.paymentProvider;
	if (method === "none") throw PluginRouteError.badRequest("Online payment is not configured yet");

	const id = newOrderId();
	const now = new Date();
	const cartId = user ? userCartId(user.id) : input.cartToken ? guestCartId(input.cartToken) : null;
	const order: Order = {
		number: await nextOrderNumber(ctx),
		status: method === "manual" ? "awaiting_payment" : "pending",
		paymentMethod: method,
		currency: settings.currency,
		items,
		subtotal,
		shipping: 0,
		tax: 0,
		discount: priced.discountTotal,
		adjustments,
		coupon: priced.coupon,
		paymentPlan: planAcc.any ? { fullAmount: planAcc.full, depositAmount: planAcc.dep, balanceDue: planAcc.bal, balanceStatus: "due" } : null,
		total: Math.max(0, subtotal + extrasTotal),
		email,
		customerName: input.name ?? customer?.name ?? shippingAddress?.name,
		phone: input.phone ?? shippingAddress?.phone,
		note: input.note,
		shippingAddress: addressFor(shippingAddress),
		billingAddress: addressFor(billingAddress),
		userId: user?.id ?? null,
		cartId,
		channel: "web",
		extensions,
		accessToken: randomToken(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		expiresAt: method !== "manual" ? new Date(now.getTime() + PENDING_TTL_MS).toISOString() : undefined,
		events: [event("created", `${method}${user ? " · account" : " · guest"}`)],
		meta: { ip: ctx.requestMeta?.ip ?? null, country: ctx.requestMeta?.geo?.country ?? null, userAgent: ctx.requestMeta?.userAgent ?? null },
	};

	const origin = siteOrigin(ctx);
	const successUrl = input.successUrl ?? `${origin}${settings.successPath}`;
	const cancelUrl = input.cancelUrl ?? `${origin}${settings.cancelPath}`;
	const sep = successUrl.includes("?") ? "&" : "?";
	const receipt = () => ({ orderId: id, number: order.number, url: `${successUrl}${sep}order=${order.number}&token=${order.accessToken}` });
	const stockItems = stockLines(order);

	if (method === "manual") {
		if (!order.email && requireEmail) throw PluginRouteError.badRequest("Email is required for pay-later orders");
		await saveOrder(ctx, id, order);
		await reserveStock(ctx, stockItems);
		await markConverted(ctx, cartId, id);
		if (order.coupon) await recordCouponUse(ctx, order.coupon.id, user?.id ?? order.email.toLowerCase() ?? null).catch(() => undefined);
		await emitOrderEvent(ctx, "order.created", id, order);
		await sendOrderEmails(ctx, settings, id, order).catch((err) => console.error("[commerce] order emails failed:", err));
		return receipt();
	}

	if (method === "polar") {
		const polar = Polar.from(ctx, settings.polarAccessToken);
		const polarCustomerId = customer ? await ensurePolarCustomer(ctx, settings, customer).catch(() => null) : null;
		await saveOrder(ctx, id, order);
		await reserveStock(ctx, stockItems);
		await emitOrderEvent(ctx, "order.created", id, order);
		let checkout;
		try {
			checkout = await polar.createCheckout({
				products: [settings.polarProductId],
				amount: order.total,
				...(polarCustomerId ? { customer_id: polarCustomerId } : { customer_email: order.email || undefined, customer_name: order.customerName || undefined }),
				success_url: `${successUrl}${sep}session_id={CHECKOUT_ID}`,
				allow_discount_codes: settings.allowPromotionCodes,
				metadata: { orderId: id, orderNumber: String(order.number) },
			});
		} catch (err) {
			await cancelOrder(ctx, id, order, "Polar checkout creation failed");
			throw err;
		}
		order.sessionId = checkout.id;
		order.events.push(event("polar_checkout", checkout.id));
		await saveOrder(ctx, id, order);
		await markConverted(ctx, cartId, id);
		return { orderId: id, number: order.number, url: checkout.url, sessionId: checkout.id };
	}

	const stripe = Stripe.from(ctx, settings.stripeSecretKey);
	const stripeCustomerId = customer ? await ensureStripeCustomer(ctx, settings, customer) : null;
	const needsShipping = items.some((i) => i.requiresShipping);
	await saveOrder(ctx, id, order);
	await reserveStock(ctx, stockItems);
	await emitOrderEvent(ctx, "order.created", id, order);

	// One-click: charge a vaulted card off-session. If the bank wants authentication, fall through to Checkout.
	const saved = customer && input.paymentMethodId ? customer.paymentMethods.find((m) => m.id === input.paymentMethodId && m.provider === "stripe") : null;
	if (customer && input.paymentMethodId && !saved) throw PluginRouteError.badRequest("That saved card is no longer available");
	if (saved && stripeCustomerId) {
		try {
			const pi = await stripe.createPaymentIntent({
				amount: order.total,
				currency: settings.currency,
				customer: stripeCustomerId,
				payment_method: saved.token,
				off_session: "true",
				confirm: "true",
				description: `Order #${order.number}`,
				metadata: { orderId: id, orderNumber: String(order.number) },
				...(shippingAddress ? { "shipping[name]": shippingAddress.name ?? order.customerName ?? order.email, "shipping[address][line1]": shippingAddress.line1, "shipping[address][line2]": shippingAddress.line2, "shipping[address][city]": shippingAddress.city, "shipping[address][state]": shippingAddress.state, "shipping[address][postal_code]": shippingAddress.postalCode, "shipping[address][country]": shippingAddress.country } : {}),
			});
			if (pi.status === "succeeded") {
				order.sessionId = `pi:${pi.id}`;
				order.events.push(event("saved_card", `${saved.brand} •••• ${saved.last4}`));
				await finalizeFromPaymentIntent(ctx, settings, id, order, pi);
				await markConverted(ctx, cartId, id);
				return { ...receipt(), paid: true };
			}
			order.events.push(event("saved_card_declined", pi.status));
		} catch (err) {
			order.events.push(event("saved_card_failed", err instanceof Error ? err.message.slice(0, 200) : "error"));
		}
		await saveOrder(ctx, id, order);
	}

	const params: Record<string, unknown> = {
		mode: "payment",
		client_reference_id: id,
		success_url: `${successUrl}${sep}session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: cancelUrl,
		...(stripeCustomerId ? { customer: stripeCustomerId, "customer_update[address]": "auto", "customer_update[shipping]": "auto" } : { customer_email: order.email || undefined }),
		expires_at: Math.floor((now.getTime() + PENDING_TTL_MS) / 1000),
		allow_promotion_codes: settings.allowPromotionCodes ? "true" : undefined,
		metadata: { orderId: id, orderNumber: String(order.number) },
		line_items: [
			...items.map((it) => ({
				quantity: it.quantity,
				price_data: {
					currency: settings.currency,
					unit_amount: it.unitAmount,
					product_data: { name: `${it.title}${lineSummary(it)}`.slice(0, 250), metadata: { productId: it.productId, slug: it.slug } },
				},
			})),
			...adjustments.filter((a) => a.amount > 0).map((a) => ({ quantity: 1, price_data: { currency: settings.currency, unit_amount: a.amount, product_data: { name: a.label.slice(0, 250) } } })),
		],
		automatic_tax: settings.automaticTax ? { enabled: "true" } : undefined,
		phone_number_collection: settings.collectPhone ? { enabled: "true" } : undefined,
		// Addresses already chosen in the store are passed along; otherwise Checkout collects them.
		shipping_address_collection: needsShipping && !shippingAddress ? { allowed_countries: settings.shippingCountries } : undefined,
		shipping_options: needsShipping && settings.shippingRates.length > 0 && !order.coupon?.freeShipping ? settings.shippingRates.map((r) => ({ shipping_rate: r })) : undefined,
		payment_intent_data: {
			metadata: { orderId: id, orderNumber: String(order.number) },
			...(shippingAddress ? { shipping: { name: shippingAddress.name ?? order.customerName ?? order.email, address: { line1: shippingAddress.line1, line2: shippingAddress.line2, city: shippingAddress.city, state: shippingAddress.state, postal_code: shippingAddress.postalCode, country: shippingAddress.country } } } : {}),
			// Vault the card for next time (the shopper asked, and has an account).
			...(stripeCustomerId && input.savePaymentMethod ? { setup_future_usage: "off_session" } : {}),
		},
		...(stripeCustomerId ? { "saved_payment_method_options[payment_method_save]": "enabled" } : {}),
	};
	if (adjustments.some((a) => a.amount < 0)) throw PluginRouteError.badRequest("Negative adjustments are only supported on pay-later orders");
	let session;
	try {
		session = await stripe.createCheckoutSession(params);
	} catch (err) {
		await cancelOrder(ctx, id, order, "Stripe session creation failed");
		throw err;
	}
	order.sessionId = session.id;
	order.events.push(event("stripe_session", session.id));
	await saveOrder(ctx, id, order);
	await markConverted(ctx, cartId, id);
	return { orderId: id, number: order.number, url: session.url, sessionId: session.id };
}

/** Success page: verify the session with the provider and finalise if paid. */
export async function confirmHandler(ctx: RouteContext<{ session_id: string }>) {
	const settings = await loadSettings(ctx);
	const hit = await findBySession(ctx, ctx.input.session_id);
	if (!hit) throw PluginRouteError.notFound("Order not found");
	let order = hit.order;
	if (order.status === "pending") {
		const session = order.paymentMethod === "polar" ? checkoutToSession(await Polar.from(ctx, settings.polarAccessToken).getCheckout(ctx.input.session_id)) : await Stripe.from(ctx, settings.stripeSecretKey).getCheckoutSessionExpanded(ctx.input.session_id);
		if (session.status === "expired") order = await cancelOrder(ctx, hit.id, order, "checkout expired");
		else {
			order = await finalizeFromSession(ctx, settings, hit.id, order, session);
			await rememberCardFromSession(ctx, order, session).catch((err) => console.error("[commerce] card not remembered:", err));
		}
	}
	return { order: publicOrder(hit.id, order), token: order.accessToken };
}

/**
 * Provider webhooks, forwarded by the site's verified /commerce-webhook/<provider>
 * route (which passes the configured secret as `key`). The payload is only a
 * hint — the checkout is re-fetched from the provider before anything changes.
 */
export async function webhookHandler(ctx: RouteContext<{ provider?: "stripe" | "polar"; key?: string; type: string; data: Record<string, unknown> }>) {
	const settings = await loadSettings(ctx);
	const provider = ctx.input.provider ?? "stripe";
	const expectedKey = provider === "stripe" ? settings.stripeWebhookSecret : settings.polarWebhookSecret;
	if (expectedKey && ctx.input.key !== expectedKey) throw PluginRouteError.forbidden("webhook not verified");
	const { type, data } = ctx.input;
	return provider === "polar" ? polarEvent(ctx, settings, type, data) : stripeEvent(ctx, settings, type, data);
}

async function stripeEvent(ctx: RouteContext, settings: Awaited<ReturnType<typeof loadSettings>>, type: string, data: Record<string, unknown>) {
	const obj = (data.object ?? {}) as Record<string, unknown>;
	if (obj.object !== "checkout.session" || typeof obj.id !== "string") return { received: true, ignored: type };
	const hit = await findBySession(ctx, obj.id);
	if (!hit) return { received: true, ignored: "unknown session" };
	if (type === "checkout.session.expired") {
		if (hit.order.status === "pending") await cancelOrder(ctx, hit.id, hit.order, "checkout expired");
		return { received: true };
	}
	if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
		const session = await Stripe.from(ctx, settings.stripeSecretKey).getCheckoutSessionExpanded(obj.id);
		const order = await finalizeFromSession(ctx, settings, hit.id, hit.order, session);
		await rememberCardFromSession(ctx, order, session).catch((err) => console.error("[commerce] card not remembered:", err));
		return { received: true };
	}
	if (type === "checkout.session.async_payment_failed") {
		if (hit.order.status === "pending") {
			hit.order.status = "failed";
			hit.order.events.push(event("payment_failed"));
			await saveOrder(ctx, hit.id, hit.order);
			await recordTransaction(ctx, hit.id, hit.order, { provider: "stripe", kind: "failed", amount: hit.order.total, status: "failed", providerRef: obj.id }).catch(() => undefined);
		}
		return { received: true };
	}
	return { received: true, ignored: type };
}

async function polarEvent(ctx: RouteContext, settings: Awaited<ReturnType<typeof loadSettings>>, type: string, data: Record<string, unknown>) {
	const checkoutId = type === "order.created" ? data.checkout_id : data.id;
	if (typeof checkoutId !== "string" || !checkoutId) return { received: true, ignored: type };
	const hit = await findBySession(ctx, checkoutId);
	if (!hit) return { received: true, ignored: "unknown checkout" };
	if (type === "order.created" && typeof data.id === "string" && !hit.order.paymentRef) {
		hit.order.paymentRef = data.id;
		hit.order.events.push(event("polar_order", data.id));
		await saveOrder(ctx, hit.id, hit.order);
	}
	if (type === "checkout.updated" || type === "checkout.created" || type === "order.created") {
		const status = type === "order.created" ? "succeeded" : String(data.status ?? "");
		if (status === "expired" || status === "failed") {
			if (hit.order.status === "pending") await cancelOrder(ctx, hit.id, hit.order, `checkout ${status}`);
			return { received: true };
		}
		if (status === "succeeded" && hit.order.status === "pending") {
			const checkout = await Polar.from(ctx, settings.polarAccessToken).getCheckout(checkoutId);
			await finalizeFromSession(ctx, settings, hit.id, hit.order, checkoutToSession(checkout));
		}
		return { received: true };
	}
	return { received: true, ignored: type };
}

/** Customer order lookup by number + access token (or email). */
export async function orderLookupHandler(ctx: RouteContext<{ order: string | number; token?: string; email?: string }>) {
	const number = Number(ctx.input.order);
	if (!Number.isFinite(number)) throw PluginRouteError.notFound("Order not found");
	const res = await orders(ctx).query({ where: { number }, limit: 1 });
	const hit = res.items[0];
	if (!hit) throw PluginRouteError.notFound("Order not found");
	const ok = (ctx.input.token && ctx.input.token === hit.data.accessToken) || (ctx.input.email && hit.data.email && ctx.input.email.toLowerCase() === hit.data.email.toLowerCase());
	if (!ok) throw PluginRouteError.forbidden("Order not found");
	return { order: publicOrder(hit.id, hit.data) };
}

/** After a Stripe Checkout that vaulted the card (setup_future_usage), keep brand/last4 on the shopper's account. */
async function rememberCardFromSession(ctx: RouteContext, order: Order, session: StripeSession): Promise<void> {
	if (!order.userId || order.status !== "paid") return;
	const pi = (session as { payment_intent?: unknown }).payment_intent as StripePaymentIntent | string | null | undefined;
	if (!pi || typeof pi === "string" || !pi.setup_future_usage) return;
	const pm = pi.payment_method;
	if (!pm || typeof pm === "string") return;
	const c = await customers(ctx).get(order.userId);
	if (c) await rememberPaymentMethod(ctx, c, pm);
}

/* ---- customer uploads for designs ---------------------------------------- */

const UPLOAD_TYPES: Record<string, { ext: string; max: number; magic: (b: Uint8Array) => boolean }> = {
	"image/png": { ext: ".png", max: 4 * 1024 * 1024, magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
	"image/jpeg": { ext: ".jpg", max: 4 * 1024 * 1024, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	"image/webp": { ext: ".webp", max: 4 * 1024 * 1024, magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
};
const UPLOADS_PER_HOUR = 40;

function decodeBase64(input: string): Uint8Array {
	const b64 = input.includes(",") && input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input;
	const bin = atob(b64.replace(/\s+/g, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Customer image upload for the print builder (and its preview). Type is
 * sniffed, size capped, rate-limited per IP; the media id is recorded so
 * checkout only accepts designs that reference files uploaded here.
 */
export async function uploadHandler(ctx: RouteContext<{ filename: string; contentType: string; bytes: string; purpose: "design-image" | "design-preview" }>) {
	const spec = UPLOAD_TYPES[ctx.input.contentType];
	if (!spec) throw PluginRouteError.badRequest("Only PNG, JPEG or WebP images can be uploaded");
	const media = ctx.media as { upload?(filename: string, contentType: string, bytes: ArrayBuffer): Promise<{ mediaId: string; storageKey: string; url: string }> } | undefined;
	if (!media?.upload) throw PluginRouteError.internal("uploads are not available");
	const ip = ctx.requestMeta?.ip ?? "unknown";
	const bucket = `uploads:${ip}:${new Date().toISOString().slice(0, 13)}`;
	const count = (await ctx.kv.get<number>(bucket)) ?? 0;
	if (count >= UPLOADS_PER_HOUR) throw PluginRouteError.badRequest("Too many uploads — please try again later");
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(ctx.input.bytes);
	} catch {
		throw PluginRouteError.badRequest("Invalid file data");
	}
	const max = ctx.input.purpose === "design-preview" ? 2 * 1024 * 1024 : spec.max;
	if (bytes.byteLength === 0 || bytes.byteLength > max) throw PluginRouteError.badRequest(`Images must be under ${Math.round(max / 1024 / 1024)} MB`);
	if (!spec.magic(bytes)) throw PluginRouteError.badRequest("The file is not a valid image");
	const safeName = ctx.input.filename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.[^.]*$/, "").slice(0, 80) || "upload";
	const uploaded = await media.upload(`design-${safeName}${spec.ext}`, ctx.input.contentType, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	await ctx.kv.set(bucket, count + 1);
	await ctx.kv.set(`upload:${uploaded.mediaId}`, { url: uploaded.url, storageKey: uploaded.storageKey, purpose: ctx.input.purpose, ip, at: new Date().toISOString() });
	return { mediaId: uploaded.mediaId, url: uploaded.url };
}

/** Production SVG for an order line's design (admin). */
export async function orderDesignHandler(ctx: RouteContext<{ id: string; line: number }>) {
	const order = await orders(ctx).get(ctx.input.id);
	if (!order) throw PluginRouteError.notFound("Order not found");
	const item = order.items[ctx.input.line];
	if (!item?.customization) throw PluginRouteError.notFound("This line has no design");
	const settings = await loadSettings(ctx);
	const product = await getProduct(ctx, item.productId, settings.currency);
	const field = product?.options?.find((f) => f.name === item.customization!.field);
	const doc = item.customization.design as DesignDoc;
	const svg = designToSvg(doc, {
		presetUrl: (id) => field?.design?.presets?.find((p) => p.id === id)?.image ?? null,
		uploadUrl: (mediaId) => item.customization?.uploads?.[mediaId] ?? null,
	});
	return { order: order.number, line: ctx.input.line, design: doc, previewUrl: item.customization.previewUrl ?? null, svg };
}

/** Storefront preview of discounts for the bag (automatic sale prices + a coupon code). Nothing is stored. */
export async function discountPreviewHandler(ctx: RouteContext<{ items: Array<{ productId: string; quantity: number; options?: Record<string, unknown>; customization?: unknown }>; code?: string; email?: string }>) {
	const settings = await loadSettings(ctx);
	const products = await listProducts(ctx, settings.currency);
	const lines = [];
	for (const it of ctx.input.items) {
		const p = products.find((x) => x.id === it.productId || x.slug === it.productId);
		if (!p) continue;
		const r = await resolveLine(ctx, p, settings.currency, it.options, it.customization as { design?: unknown; previewMediaId?: string } | undefined).catch(() => null);
		lines.push({ productId: p.id, slug: p.slug, quantity: it.quantity, unitAmount: r?.unitAmount ?? p.unitAmount });
	}
	const priced = await applyDiscounts(ctx, lines, settings.currency, { code: ctx.input.code, customerKey: ctx.user?.id ?? ctx.input.email?.toLowerCase() ?? null });
	return {
		currency: settings.currency,
		lines: priced.lines.map((l) => ({ productId: l.productId, slug: l.slug, quantity: l.quantity, unitAmount: l.unitAmount, finalUnitAmount: l.finalUnitAmount, applied: l.applied })),
		subtotal: priced.lines.reduce((n, l) => n + l.unitAmount * l.quantity, 0),
		discountTotal: priced.discountTotal,
		total: priced.lines.reduce((n, l) => n + l.finalUnitAmount * l.quantity, 0),
		coupon: priced.coupon,
		couponError: priced.couponError,
	};
}

export { formatMoney };
