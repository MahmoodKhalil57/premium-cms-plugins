import type { PluginContext } from "./shim.js";
import { isValidTimeZone } from "./bookings.js";
import type { DeliveryZone, PaymentProvider, StoreSettings } from "./types.js";

const csv = (v: unknown): string[] =>
	String(v ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);

const DEFAULT_SHIPPING_COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ", "DE", "FR", "NL", "BE", "ES", "IT", "PT", "AT", "CH", "SE", "DK", "NO", "FI", "AE", "SA", "QA", "KW", "BH", "OM", "JO", "EG"];

const SETTINGS_TTL_MS = 30_000;

async function readAllSettings(ctx: PluginContext): Promise<Record<string, unknown>> {
	const kv = ctx.kv as { list?: (prefix?: string) => Promise<Array<{ key: string; value: unknown }>> };
	if (typeof kv.list === "function") {
		const rows = await kv.list("settings:").catch(() => null);
		if (Array.isArray(rows) && rows.length) return Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
	}
	const keys = ["currency", "paymentProvider", "stripeSecretKey", "stripeWebhookSecret", "polarAccessToken", "polarProductId", "polarWebhookSecret", "allowManualPayment", "customerAccounts", "bookingTimezone", "slotIntervalMin", "leadTimeHours", "horizonDays", "holdMinutes", "notifyEmail", "storeName", "automaticTax", "shippingRates", "shippingCountries", "allowPromotionCodes", "collectPhone", "successPath", "cancelPath", "restaurantMode", "fulfilmentModes", "openingHours", "prepTimeMin", "deliveryZones", "pickupLeadMin", "orderSlotIntervalMin", "maxOrdersPerSlot", "tipPresets", "serviceChargePct", "allowPayAtTable", "allowPayOnCollection", "qrOrdering", "kdsStations", "printnodeApiKey", "receiptHeader", "receiptFooter", "reservationsEnabled", "turnTimeMin", "maxPartySize", "reservationLeadMin"];
	const values = await Promise.all(keys.map((k) => ctx.kv.get<unknown>(`settings:${k}`)));
	return Object.fromEntries(keys.map((k, i) => [k, values[i]]).filter(([, v]) => v !== null && v !== undefined));
}

function parseZones(v: unknown): DeliveryZone[] {
	let raw: unknown = v;
	if (typeof raw === "string") {
		const text = raw.trim();
		if (text.startsWith("[")) {
			try {
				raw = JSON.parse(text);
			} catch {
				raw = [];
			}
		} else {
			// Line format: Name | prefixes | fee | minimum | minutes
			raw = text
				.split(/\n+/)
				.map((line) => line.split("|").map((x) => x.trim()))
				.filter((c) => c[0])
				.map((c) => ({ name: c[0], postcodes: c[1] ?? "*", fee: c[2] ?? 0, minimum: c[3] ?? 0, etaMin: c[4] ?? 0 }));
		}
	}
	if (!Array.isArray(raw)) return [];
	return raw
		.map((z, i) => {
			const o = (z ?? {}) as Record<string, unknown>;
			const name = String(o.name ?? `Zone ${i + 1}`).trim();
			const postcodes = (Array.isArray(o.postcodes) ? o.postcodes.map(String) : String(o.postcodes ?? "").split(/[,\s]+/)).map((p) => p.trim().toUpperCase().replace(/\s+/g, "")).filter(Boolean);
			return { id: String(o.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-")), name, postcodes, fee: Math.max(0, Number(o.fee) || 0), minimum: Math.max(0, Number(o.minimum) || 0), etaMin: Math.max(0, Number(o.etaMin) || 0) };
		})
		.filter((z) => z.name);
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
	// One round trip for every setting (each kv.get is a subrequest; a cold isolate would burn dozens).
	const bag = await readAllSettings(ctx);
	const get = async <T>(key: string): Promise<T | null> => (key in bag ? (bag[key] as T) : null);
	const R = [
		"restaurantMode", "fulfilmentModes", "openingHours", "prepTimeMin", "deliveryZones", "pickupLeadMin", "orderSlotIntervalMin", "maxOrdersPerSlot", "tipPresets", "serviceChargePct", "allowPayAtTable", "allowPayOnCollection", "qrOrdering", "kdsStations", "printnodeApiKey", "receiptHeader", "receiptFooter", "reservationsEnabled", "turnTimeMin", "maxPartySize", "reservationLeadMin",
	] as const;
	const rv = Object.fromEntries(await Promise.all(R.map(async (k) => [k, await get<unknown>(k)] as const))) as Record<(typeof R)[number], unknown>;
	const numOr = (v: unknown, d: number) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
	const boolOr = (v: unknown, d: boolean) => (v === undefined || v === null || v === "" ? d : v === true || v === "true");
	const [bookingTimezone, slotIntervalMin, leadTimeHours, horizonDays, holdMinutes, customerAccounts, paymentProvider, stripeWebhookSecret, polarAccessToken, polarProductId, polarWebhookSecret, currency, stripeSecretKey, allowManualPayment, notifyEmail, storeName, automaticTax, shippingRates, shippingCountries, allowPromotionCodes, collectPhone, successPath, cancelPath] = await Promise.all([
		get<string>("bookingTimezone"),
		get<number | string>("slotIntervalMin"),
		get<number | string>("leadTimeHours"),
		get<number | string>("horizonDays"),
		get<number | string>("holdMinutes"),
		get<boolean>("customerAccounts"),
		get<string>("paymentProvider"),
		get<string>("stripeWebhookSecret"),
		get<string>("polarAccessToken"),
		get<string>("polarProductId"),
		get<string>("polarWebhookSecret"),
		get<string>("currency"),
		get<string>("stripeSecretKey"),
		get<boolean>("allowManualPayment"),
		get<string>("notifyEmail"),
		get<string>("storeName"),
		get<boolean>("automaticTax"),
		get<string>("shippingRates"),
		get<string>("shippingCountries"),
		get<boolean>("allowPromotionCodes"),
		get<boolean>("collectPhone"),
		get<string>("successPath"),
		get<string>("cancelPath"),
	]);
	const countries = csv(shippingCountries).map((c) => c.toUpperCase());
	return {
		currency: (currency || "usd").toLowerCase(),
		paymentProvider: resolveProvider(paymentProvider, stripeSecretKey, polarAccessToken, polarProductId),
		stripeSecretKey: stripeSecretKey ?? "",
		stripeWebhookSecret: stripeWebhookSecret ?? "",
		polarAccessToken: polarAccessToken ?? "",
		polarProductId: polarProductId ?? "",
		polarWebhookSecret: polarWebhookSecret ?? "",
		allowManualPayment: allowManualPayment === true,
		customerAccounts: customerAccounts === true,
		bookingTimezone: (bookingTimezone && isValidTimeZone(bookingTimezone) ? bookingTimezone : "UTC"),
		slotIntervalMin: Math.max(5, Number(slotIntervalMin) || 15),
		leadTimeHours: Math.max(0, Number(leadTimeHours) || 2),
		horizonDays: Math.max(1, Number(horizonDays) || 60),
		holdMinutes: Math.max(5, Number(holdMinutes) || 15),
		notifyEmail: notifyEmail ?? "",
		storeName: storeName ?? "",
		automaticTax: automaticTax === true,
		shippingRates: csv(shippingRates),
		shippingCountries: countries.length > 0 ? countries : DEFAULT_SHIPPING_COUNTRIES,
		allowPromotionCodes: allowPromotionCodes !== false,
		collectPhone: collectPhone === true,
		successPath: successPath || "/checkout/success",
		cancelPath: cancelPath || "/cart",
		restaurantMode: boolOr(rv.restaurantMode, false),
		fulfilmentModes: (csv(rv.fulfilmentModes).length ? csv(rv.fulfilmentModes) : ["delivery", "pickup", "dine_in"]).filter((m): m is "delivery" | "pickup" | "dine_in" => m === "delivery" || m === "pickup" || m === "dine_in"),
		openingHours: String(rv.openingHours ?? "").trim(),
		prepTimeMin: numOr(rv.prepTimeMin, 25),
		deliveryZones: parseZones(rv.deliveryZones),
		pickupLeadMin: numOr(rv.pickupLeadMin, 20),
		orderSlotIntervalMin: numOr(rv.orderSlotIntervalMin, 15),
		maxOrdersPerSlot: numOr(rv.maxOrdersPerSlot, 0),
		tipPresets: csv(rv.tipPresets).map(Number).filter((n) => Number.isFinite(n) && n >= 0),
		serviceChargePct: numOr(rv.serviceChargePct, 0),
		allowPayAtTable: boolOr(rv.allowPayAtTable, true),
		allowPayOnCollection: boolOr(rv.allowPayOnCollection, false),
		qrOrdering: boolOr(rv.qrOrdering, true),
		kdsStations: csv(rv.kdsStations).length ? csv(rv.kdsStations) : ["kitchen"],
		printnodeApiKey: String(rv.printnodeApiKey ?? "").trim(),
		receiptHeader: String(rv.receiptHeader ?? "").trim(),
		receiptFooter: String(rv.receiptFooter ?? "").trim(),
		reservationsEnabled: boolOr(rv.reservationsEnabled, false),
		turnTimeMin: numOr(rv.turnTimeMin, 90),
		maxPartySize: numOr(rv.maxPartySize, 8),
		reservationLeadMin: numOr(rv.reservationLeadMin, 60),
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
