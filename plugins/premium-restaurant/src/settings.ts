import type { PluginContext } from "./shim.js";
import { isValidTimeZone } from "./time.js";
import type { DeliveryZone, RestaurantSettings } from "./types.js";

const csv = (v: unknown): string[] =>
	String(v ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);

const SETTINGS_TTL_MS = 30_000;
const KEYS = ["timezone", "storeName", "fulfilmentModes", "openingHours", "prepTimeMin", "deliveryZones", "pickupLeadMin", "orderSlotIntervalMin", "maxOrdersPerSlot", "tipPresets", "serviceChargePct", "allowPayAtTable", "allowPayOnCollection", "qrOrdering", "kdsStations", "printnodeApiKey", "receiptHeader", "receiptFooter", "reservationsEnabled", "turnTimeMin", "maxPartySize", "reservationLeadMin", "notifyEmail", "trackPath", "orderPath"] as const;

async function readAll(ctx: PluginContext): Promise<Record<string, unknown>> {
	const rows = await ctx.kv.list("settings:").catch(() => null);
	if (Array.isArray(rows) && rows.length) return Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
	const values = await Promise.all(KEYS.map((k) => ctx.kv.get<unknown>(`settings:${k}`)));
	return Object.fromEntries(KEYS.map((k, i) => [k, values[i]]).filter(([, v]) => v !== null && v !== undefined));
}

export function parseZones(v: unknown): DeliveryZone[] {
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

let cached: { at: number; value: RestaurantSettings } | null = null;

export async function loadSettings(ctx: PluginContext): Promise<RestaurantSettings> {
	if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;
	const bag = await readAll(ctx);
	const numOr = (k: string, d: number) => (bag[k] === undefined || bag[k] === null || bag[k] === "" || Number.isNaN(Number(bag[k])) ? d : Number(bag[k]));
	const boolOr = (k: string, d: boolean) => (bag[k] === undefined || bag[k] === null || bag[k] === "" ? d : bag[k] === true || bag[k] === "true");
	const str = (k: string, d = "") => (typeof bag[k] === "string" && (bag[k] as string).trim() ? (bag[k] as string).trim() : d);
	const tz = str("timezone", "UTC");
	const modes = csv(bag.fulfilmentModes);
	const value: RestaurantSettings = {
		timezone: isValidTimeZone(tz) ? tz : "UTC",
		storeName: str("storeName"),
		fulfilmentModes: (modes.length ? modes : ["delivery", "pickup", "dine_in"]).filter((m): m is "delivery" | "pickup" | "dine_in" => m === "delivery" || m === "pickup" || m === "dine_in"),
		openingHours: str("openingHours"),
		prepTimeMin: numOr("prepTimeMin", 25),
		deliveryZones: parseZones(bag.deliveryZones),
		pickupLeadMin: numOr("pickupLeadMin", 20),
		orderSlotIntervalMin: numOr("orderSlotIntervalMin", 15),
		maxOrdersPerSlot: numOr("maxOrdersPerSlot", 0),
		tipPresets: csv(bag.tipPresets).map(Number).filter((n) => Number.isFinite(n) && n >= 0),
		serviceChargePct: numOr("serviceChargePct", 0),
		allowPayAtTable: boolOr("allowPayAtTable", true),
		allowPayOnCollection: boolOr("allowPayOnCollection", false),
		qrOrdering: boolOr("qrOrdering", true),
		kdsStations: csv(bag.kdsStations).length ? csv(bag.kdsStations).map((s) => s.toLowerCase()) : ["kitchen"],
		printnodeApiKey: str("printnodeApiKey"),
		receiptHeader: str("receiptHeader"),
		receiptFooter: str("receiptFooter"),
		reservationsEnabled: boolOr("reservationsEnabled", false),
		turnTimeMin: numOr("turnTimeMin", 90),
		maxPartySize: numOr("maxPartySize", 8),
		reservationLeadMin: numOr("reservationLeadMin", 60),
		notifyEmail: str("notifyEmail"),
		trackPath: str("trackPath", "/track"),
		orderPath: str("orderPath", "/order"),
	};
	cached = { at: Date.now(), value };
	return value;
}

export function invalidateSettings(): void {
	cached = null;
}
