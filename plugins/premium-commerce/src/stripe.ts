/**
 * Minimal Stripe REST client for the sandbox: form-encoded requests through
 * ctx.http.fetch (allowedHosts: api.stripe.com). No SDK — the bundle must
 * stay under the marketplace size limit.
 */

import type { PluginContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";

type Params = Record<string, unknown>;

function encode(params: Params, prefix = "", out: string[] = []): string[] {
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		const name = prefix ? `${prefix}[${key}]` : key;
		if (Array.isArray(value)) {
			value.forEach((v, i) => {
				if (typeof v === "object" && v !== null) encode(v as Params, `${name}[${i}]`, out);
				else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(v))}`);
			});
		} else if (typeof value === "object") {
			encode(value as Params, name, out);
		} else {
			out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
		}
	}
	return out;
}

export interface StripeSession {
	id: string;
	object: string;
	client_reference_id: string | null;
	payment_status: "paid" | "unpaid" | "no_payment_required";
	status: "open" | "complete" | "expired";
	amount_subtotal: number | null;
	amount_total: number | null;
	currency: string | null;
	customer_email: string | null;
	customer_details?: { email?: string | null; name?: string | null; phone?: string | null; address?: StripeAddress | null } | null;
	shipping_details?: { name?: string | null; address?: StripeAddress | null } | null;
	collected_information?: { shipping_details?: { name?: string | null; address?: StripeAddress | null } | null } | null;
	total_details?: { amount_shipping?: number | null; amount_tax?: number | null; amount_discount?: number | null } | null;
	payment_intent: string | null;
	url?: string | null;
	metadata?: Record<string, string>;
}

export interface StripeAddress {
	line1?: string | null;
	line2?: string | null;
	city?: string | null;
	state?: string | null;
	postal_code?: string | null;
	country?: string | null;
}

export interface StripePaymentMethod {
	id: string;
	type?: string;
	card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null;
}

export interface StripePaymentIntent {
	id: string;
	status: "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "canceled" | "succeeded";
	amount: number;
	currency: string;
	client_secret?: string | null;
	payment_method?: StripePaymentMethod | string | null;
	setup_future_usage?: string | null;
	latest_charge?: string | null;
	last_payment_error?: { message?: string } | null;
}

export class Stripe {
	constructor(
		private readonly ctx: PluginContext,
		private readonly secretKey: string,
	) {}

	static from(ctx: PluginContext, secretKey: string | undefined | null): Stripe {
		if (!secretKey) throw PluginRouteError.badRequest("Stripe is not configured — add the secret key in Plugins → Commerce → Settings");
		if (!ctx.http) throw PluginRouteError.internal("network access is not available to the plugin");
		return new Stripe(ctx, secretKey);
	}

	private async call<T>(method: "GET" | "POST", path: string, params?: Params): Promise<T> {
		const body = params ? encode(params).join("&") : undefined;
		const url = method === "GET" && body ? `https://api.stripe.com/v1${path}?${body}` : `https://api.stripe.com/v1${path}`;
		const res = await this.ctx.http!.fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.secretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"Stripe-Version": "2024-06-20",
			},
			body: method === "POST" ? body : undefined,
		});
		const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; type?: string } } & T;
		if (!res.ok) {
			throw PluginRouteError.badRequest(`Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
		}
		return json;
	}

	createCheckoutSession(params: Params): Promise<StripeSession> {
		return this.call<StripeSession>("POST", "/checkout/sessions", params);
	}

	getCheckoutSession(id: string): Promise<StripeSession> {
		return this.call<StripeSession>("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
	}

	expireCheckoutSession(id: string): Promise<StripeSession> {
		return this.call<StripeSession>("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`);
	}

	createRefund(paymentIntent: string, amount?: number): Promise<{ id: string; status: string; amount: number }> {
		return this.call("POST", "/refunds", { payment_intent: paymentIntent, ...(amount ? { amount } : {}) });
	}

	/** Checkout Session with the payment method expanded (to remember a vaulted card). */
	getCheckoutSessionExpanded(id: string): Promise<StripeSession & { payment_intent: StripePaymentIntent | string | null }> {
		return this.call("GET", `/checkout/sessions/${encodeURIComponent(id)}`, { "expand[]": "payment_intent.payment_method" });
	}

	createCustomer(params: { email: string; name?: string; metadata?: Record<string, string> }): Promise<{ id: string }> {
		return this.call("POST", "/customers", params);
	}

	updateCustomer(id: string, params: Params): Promise<{ id: string }> {
		return this.call("POST", `/customers/${encodeURIComponent(id)}`, params);
	}

	detachPaymentMethod(id: string): Promise<{ id: string }> {
		return this.call("POST", `/payment_methods/${encodeURIComponent(id)}/detach`);
	}

	/** Off-session charge of a vaulted card: succeeds silently or asks for authentication. */
	createPaymentIntent(params: Params): Promise<StripePaymentIntent> {
		return this.call("POST", "/payment_intents", params);
	}

	createBillingPortalSession(customer: string, returnUrl: string): Promise<{ url: string }> {
		return this.call("POST", "/billing_portal/sessions", { customer, return_url: returnUrl });
	}
}
