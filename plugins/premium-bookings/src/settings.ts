import type { PluginContext } from "./shim.js";
import { isValidTimeZone } from "./time.js";
import type { BookingSettings } from "./types.js";

const SETTINGS_TTL_MS = 30_000;
const KEYS = ["timezone", "slotIntervalMin", "leadTimeHours", "horizonDays", "holdMinutes", "cancelHours", "notifyEmail", "businessName", "currency", "managePath"] as const;

async function readAll(ctx: PluginContext): Promise<Record<string, unknown>> {
	const rows = await ctx.kv.list("settings:").catch(() => null);
	if (Array.isArray(rows) && rows.length) return Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
	const values = await Promise.all(KEYS.map((k) => ctx.kv.get<unknown>(`settings:${k}`)));
	return Object.fromEntries(KEYS.map((k, i) => [k, values[i]]).filter(([, v]) => v !== null && v !== undefined));
}

let cached: { at: number; value: BookingSettings } | null = null;

/** Admin settings (`settings:<key>`), cached in-isolate briefly — every read is an RPC. */
export async function loadSettings(ctx: PluginContext): Promise<BookingSettings> {
	if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;
	const bag = await readAll(ctx);
	const num = (k: string, d: number, min = 0) => {
		const n = Number(bag[k]);
		return bag[k] === undefined || bag[k] === null || bag[k] === "" || Number.isNaN(n) ? d : Math.max(min, n);
	};
	const str = (k: string, d = "") => (typeof bag[k] === "string" && (bag[k] as string).trim() ? (bag[k] as string).trim() : d);
	const tz = str("timezone", "UTC");
	const lead = num("leadTimeHours", 2);
	const value: BookingSettings = {
		timezone: isValidTimeZone(tz) ? tz : "UTC",
		slotIntervalMin: num("slotIntervalMin", 15, 5),
		leadTimeHours: lead,
		horizonDays: num("horizonDays", 60, 1),
		holdMinutes: num("holdMinutes", 15, 5),
		cancelHours: num("cancelHours", lead),
		notifyEmail: str("notifyEmail"),
		businessName: str("businessName"),
		currency: str("currency", "usd").toLowerCase(),
		managePath: str("managePath", "/book"),
	};
	cached = { at: Date.now(), value };
	return value;
}

export function invalidateSettings(): void {
	cached = null;
}
