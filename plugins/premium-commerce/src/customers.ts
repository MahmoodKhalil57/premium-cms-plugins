/**
 * Customer accounts: addresses and saved payment methods for signed-in
 * shoppers. Cards never touch the platform — the PSP vaults them under the
 * customer it knows; we keep the opaque token plus brand/last4/expiry so the
 * account page and checkout can offer "pay with Visa •••• 4242".
 */

import { ulid } from "ulidx";

import type { ProviderEnv } from "./env-types.js";
import { Polar } from "./polar.js";
import type { PluginContext, StorageCollection, UserInfo } from "./shim.js";
import { PluginRouteError } from "./shim.js";
import { Stripe } from "./stripe.js";
import type { Address, CustomerRecord, SavedPaymentMethod, StoreSettings } from "./types.js";

export function customers(ctx: PluginContext): StorageCollection<CustomerRecord> {
	return ctx.storage.customers as StorageCollection<CustomerRecord>;
}

export async function getCustomer(ctx: PluginContext, user: UserInfo): Promise<CustomerRecord> {
	const existing = await customers(ctx).get(user.id);
	if (existing) return existing;
	const now = new Date().toISOString();
	const fresh: CustomerRecord = { userId: user.id, email: user.email, name: user.name ?? undefined, stripeCustomerId: null, polarCustomerId: null, addresses: [], paymentMethods: [], createdAt: now, updatedAt: now };
	await customers(ctx).put(user.id, fresh);
	return fresh;
}

export async function saveCustomer(ctx: PluginContext, c: CustomerRecord): Promise<void> {
	c.updatedAt = new Date().toISOString();
	await customers(ctx).put(c.userId, c);
}

/** Safe projection for the account page (tokens stay server-side). */
export function publicCustomer(c: CustomerRecord) {
	return {
		email: c.email,
		name: c.name ?? null,
		addresses: c.addresses,
		paymentMethods: c.paymentMethods.map((m) => ({ id: m.id, provider: m.provider, brand: m.brand, last4: m.last4, expMonth: m.expMonth, expYear: m.expYear })),
		providers: { stripe: Boolean(c.stripeCustomerId), polar: Boolean(c.polarCustomerId) },
	};
}

const ADDRESS_KEYS = ["label", "name", "line1", "line2", "city", "state", "postalCode", "country", "phone"] as const;

export function normalizeAddress(input: Partial<Address>): Address {
	const out: Address = { id: typeof input.id === "string" && input.id ? input.id : ulid() };
	for (const k of ADDRESS_KEYS) {
		const v = input[k];
		if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 200);
	}
	if (out.country) out.country = out.country.toUpperCase().slice(0, 2);
	if (!out.line1 || !out.city || !out.country) throw PluginRouteError.badRequest("An address needs at least a street, city and country");
	if (input.isDefault === true) out.isDefault = true;
	return out;
}

export function upsertAddress(c: CustomerRecord, address: Address): Address {
	const i = c.addresses.findIndex((a) => a.id === address.id);
	if (address.isDefault) for (const a of c.addresses) delete a.isDefault;
	if (i >= 0) c.addresses[i] = address;
	else c.addresses.push(address);
	if (c.addresses.length === 1) c.addresses[0]!.isDefault = true;
	return address;
}

export async function ensureStripeCustomer(ctx: PluginContext, settings: StoreSettings, c: CustomerRecord): Promise<string> {
	if (c.stripeCustomerId) return c.stripeCustomerId;
	const stripe = Stripe.from(ctx, settings.stripeSecretKey);
	const created = await stripe.createCustomer({ email: c.email, name: c.name, metadata: { userId: c.userId } });
	c.stripeCustomerId = created.id;
	await saveCustomer(ctx, c);
	return created.id;
}

export async function ensurePolarCustomer(ctx: PluginContext, settings: StoreSettings, c: CustomerRecord): Promise<string> {
	if (c.polarCustomerId) return c.polarCustomerId;
	const polar = Polar.from(ctx, settings.polarAccessToken);
	const id = await polar.getOrCreateCustomer(c.email, c.userId, c.name);
	c.polarCustomerId = id;
	await saveCustomer(ctx, c);
	return id;
}

/** Remember a card the PSP just vaulted (metadata only). Idempotent per token. */
export async function rememberPaymentMethod(ctx: PluginContext, c: CustomerRecord, pm: { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null }): Promise<void> {
	if (!pm.card?.last4 || c.paymentMethods.some((m) => m.token === pm.id)) return;
	const saved: SavedPaymentMethod = { id: ulid(), provider: "stripe", token: pm.id, brand: pm.card.brand ?? "card", last4: pm.card.last4, expMonth: pm.card.exp_month ?? 0, expYear: pm.card.exp_year ?? 0, createdAt: new Date().toISOString() };
	c.paymentMethods.push(saved);
	await saveCustomer(ctx, c);
}

export function envOf(settings: StoreSettings): ProviderEnv {
	return settings as unknown as ProviderEnv;
}
