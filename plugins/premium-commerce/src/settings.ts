import type { PluginContext } from "./shim.js";
import type { PaymentProvider, StoreSettings } from "./types.js";

const csv = (v: unknown): string[] =>
	String(v ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);

const DEFAULT_SHIPPING_COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ", "DE", "FR", "NL", "BE", "ES", "IT", "PT", "AT", "CH", "SE", "DK", "NO", "FI", "AE", "SA", "QA", "KW", "BH", "OM", "JO", "EG"];

const SETTINGS_TTL_MS = 30_000;
const KEYS = ["currency", "paymentProvider", "stripeSecretKey", "stripeWebhookSecret", "polarAccessToken", "polarProductId", "polarWebhookSecret", "allowManualPayment", "customerAccounts", "notifyEmail", "storeName", "automaticTax", "shippingRates", "shippingCountries", "allowPromotionCodes", "collectPhone", "successPath", "cancelPath"] as const;

async function readAllSettings(ctx: PluginContext): Promise<Record<string, unknown>> {
	const kv = ctx.kv as { list?: (prefix?: string) => Promise<Array<{ key: string; value: unknown }>> };
	if (typeof kv.list === "function") {
		const rows = await kv.list("settings:").catch(() => null);
		if (Array.isArray(rows) && rows.length) return Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
	}
	const values = await Promise.all(KEYS.map((k) => ctx.kv.get<unknown>(`settings:${k}`)));
	return Object.fromEntries(KEYS.map((k, i) => [k, values[i]]).filter(([, v]) => v !== null && v !== undefined));
}

let cached: { at: number; value: StoreSettings } | null = null;

/**
 * Admin settings (Plugins → Commerce → Settings) are stored by the host under
 * `settings:<key>`; every read is an RPC out of the isolate, so the resolved
 * object is cached in-isolate briefly.
 */
export async function loadSettings(ctx: PluginContext): Promise<StoreSettings> {
	if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;
	const value = await readSettings(ctx);
	cached = { at: Date.now(), value };
	return value;
}

export function invalidateSettings(): void {
	cached = null;
}

async function readSettings(ctx: PluginContext): Promise<StoreSettings> {
	const bag = await readAllSettings(ctx);
	const get = <T>(key: string): T | null => (key in bag ? (bag[key] as T) : null);
	const stripeSecretKey = get<string>("stripeSecretKey");
	const polarAccessToken = get<string>("polarAccessToken");
	const polarProductId = get<string>("polarProductId");
	const countries = csv(get("shippingCountries")).map((c) => c.toUpperCase());
	return {
		currency: (get<string>("currency") || "usd").toLowerCase(),
		paymentProvider: resolveProvider(get<string>("paymentProvider"), stripeSecretKey, polarAccessToken, polarProductId),
		stripeSecretKey: stripeSecretKey ?? "",
		stripeWebhookSecret: get<string>("stripeWebhookSecret") ?? "",
		polarAccessToken: polarAccessToken ?? "",
		polarProductId: polarProductId ?? "",
		polarWebhookSecret: get<string>("polarWebhookSecret") ?? "",
		allowManualPayment: get("allowManualPayment") === true,
		customerAccounts: get("customerAccounts") === true,
		notifyEmail: get<string>("notifyEmail") ?? "",
		storeName: get<string>("storeName") ?? "",
		automaticTax: get("automaticTax") === true,
		shippingRates: csv(get("shippingRates")),
		shippingCountries: countries.length > 0 ? countries : DEFAULT_SHIPPING_COUNTRIES,
		allowPromotionCodes: get("allowPromotionCodes") !== false,
		collectPhone: get("collectPhone") === true,
		successPath: get<string>("successPath") || "/checkout/success",
		cancelPath: get<string>("cancelPath") || "/cart",
	};
}

/** Stores configured before the provider select existed keep working on their Stripe key. */
function resolveProvider(selected: string | null | undefined, stripeKey: string | null | undefined, polarToken: string | null | undefined, polarProduct: string | null | undefined): PaymentProvider {
	const p = (selected ?? "").trim().toLowerCase();
	if (p === "stripe") return stripeKey ? "stripe" : "none";
	if (p === "polar") return polarToken && polarProduct ? "polar" : "none";
	if (!p && stripeKey) return "stripe";
	return "none";
}
