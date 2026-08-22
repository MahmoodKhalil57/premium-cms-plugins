/**
 * Minimal Polar REST client for the sandbox (allowedHosts: api.polar.sh).
 * Checkouts are created against one "pay what you want" product in the
 * store's Polar organization, charging the order total.
 */

import type { PluginContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import type { StripeSession } from "./stripe.js";

export interface PolarAddress {
	line1?: string | null;
	line2?: string | null;
	postal_code?: string | null;
	city?: string | null;
	state?: string | null;
	country?: string | null;
}

export interface PolarCheckout {
	id: string;
	status: "open" | "expired" | "confirmed" | "succeeded" | "failed";
	url?: string | null;
	amount?: number | null;
	total_amount?: number | null;
	tax_amount?: number | null;
	discount_amount?: number | null;
	currency?: string | null;
	customer_email?: string | null;
	customer_name?: string | null;
	customer_billing_address?: PolarAddress | null;
	metadata?: Record<string, string>;
}

export class Polar {
	constructor(
		private readonly ctx: PluginContext,
		private readonly token: string,
	) {}

	static from(ctx: PluginContext, token: string | undefined | null): Polar {
		if (!token) throw PluginRouteError.badRequest("Polar is not configured — add the access token in Plugins → Commerce → Settings");
		if (!ctx.http) throw PluginRouteError.internal("network access is not available to the plugin");
		return new Polar(ctx, token);
	}

	private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		const res = await this.ctx.http!.fetch(`https://api.polar.sh/v1${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: string } & T;
		if (!res.ok) {
			const detail = typeof json.detail === "string" ? json.detail : Array.isArray(json.detail) ? (json.detail as Array<{ msg?: string }>).map((d) => d.msg).filter(Boolean).join("; ") : json.error;
			throw PluginRouteError.badRequest(`Polar: ${detail || `HTTP ${res.status}`}`);
		}
		return json;
	}

	createCheckout(params: Record<string, unknown>): Promise<PolarCheckout> {
		return this.call<PolarCheckout>("POST", "/checkouts/", params);
	}

	getCheckout(id: string): Promise<PolarCheckout> {
		return this.call<PolarCheckout>("GET", `/checkouts/${encodeURIComponent(id)}`);
	}

	/** The Polar order created for a succeeded checkout (needed for refunds). */
	async findOrderByCheckout(checkoutId: string): Promise<string | null> {
		const res = await this.call<{ items?: Array<{ id: string }> }>("GET", `/orders/?checkout_id=${encodeURIComponent(checkoutId)}&limit=1`);
		return res.items?.[0]?.id ?? null;
	}

	/** Polar customer linked to our user id (external_id); created on first use. */
	async getOrCreateCustomer(email: string, externalId: string, name?: string): Promise<string> {
		const res = await this.ctx.http!.fetch(`https://api.polar.sh/v1/customers/external/${encodeURIComponent(externalId)}`, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } });
		if (res.ok) return ((await res.json()) as { id: string }).id;
		const created = await this.call<{ id: string }>("POST", "/customers/", { email, external_id: externalId, ...(name ? { name } : {}) });
		return created.id;
	}

	/** Short-lived customer portal session (manage saved payment methods, orders). */
	async createCustomerSession(customerId: string): Promise<string> {
		const s = await this.call<{ customer_portal_url: string }>("POST", "/customer-sessions/", { customer_id: customerId });
		return s.customer_portal_url;
	}

	createRefund(orderId: string, amount: number): Promise<{ id: string; status: string; amount: number }> {
		return this.call("POST", "/refunds/", { order_id: orderId, reason: "customer_request", amount });
	}
}

/** Project a Polar checkout onto the session shape the order pipeline finalises from. */
export function checkoutToSession(c: PolarCheckout): StripeSession {
	const a = c.customer_billing_address;
	return {
		id: c.id,
		object: "checkout.session",
		client_reference_id: c.metadata?.orderId ?? null,
		payment_status: c.status === "succeeded" ? "paid" : "unpaid",
		status: c.status === "expired" || c.status === "failed" ? "expired" : c.status === "open" ? "open" : "complete",
		amount_subtotal: c.amount ?? null,
		amount_total: c.total_amount ?? c.amount ?? null,
		currency: c.currency ?? null,
		customer_email: c.customer_email ?? null,
		customer_details: { email: c.customer_email ?? null, name: c.customer_name ?? null, address: a ? { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code, country: a.country } : null },
		total_details: { amount_shipping: 0, amount_tax: c.tax_amount ?? 0, amount_discount: c.discount_amount ?? 0 },
		payment_intent: null,
		metadata: c.metadata,
	};
}
