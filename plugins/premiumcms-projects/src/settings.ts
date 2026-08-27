/**
 * Provider settings, stored in ctx.kv under the `settings:` prefix.
 *
 * Credentials come from the plugin's own settings page (Plugins → Projects →
 * Settings) rather than the Worker env: the Cloudflare API token and the
 * marketplace deploy key are the two secrets, so they get the same
 * empty-submit-keeps / "clear"-wipes treatment as any other secret field
 * (see cloudflare-email-byo). Non-secret text fields have sensible defaults.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";

export const KV_PREFIX = "settings:";

export const DEFAULT_ZONE = "premium-cms.com";
export const DEFAULT_MARKETPLACE_URL = "https://marketplace.premium-cms.com";

/** Cloudflare account IDs are 32 lowercase hex characters. */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

export interface Settings {
	cfAccountId: string;
	zone: string;
	marketplaceUrl: string;
	ownerEmail: string;
	/** Secrets — present only in the internal read, never returned by a route. */
	cfApiToken: string;
	deployKey: string;
}

/** Credential pair passed to the Cloudflare REST client. */
export interface CfCreds {
	accountId: string;
	apiToken: string;
}

export function credsOf(settings: Settings): CfCreds {
	return { accountId: settings.cfAccountId, apiToken: settings.cfApiToken };
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** Read settings from kv. Never throws — a failed read degrades to blanks/defaults. */
export async function readSettings(ctx: PluginContext): Promise<Settings> {
	try {
		const entries = await ctx.kv.list(KV_PREFIX);
		const map: Record<string, unknown> = {};
		for (const entry of entries) map[entry.key.replace(KV_PREFIX, "")] = entry.value;
		return {
			cfAccountId: asString(map.cfAccountId).trim().toLowerCase(),
			zone: asString(map.zone).trim() || DEFAULT_ZONE,
			marketplaceUrl: (asString(map.marketplaceUrl).trim() || DEFAULT_MARKETPLACE_URL).replace(
				/\/$/,
				"",
			),
			ownerEmail: asString(map.ownerEmail).trim(),
			cfApiToken: asString(map.cfApiToken),
			deployKey: asString(map.deployKey),
		};
	} catch (error) {
		ctx.log.error("Failed to read settings", error);
		return {
			cfAccountId: "",
			zone: DEFAULT_ZONE,
			marketplaceUrl: DEFAULT_MARKETPLACE_URL,
			ownerEmail: "",
			cfApiToken: "",
			deployKey: "",
		};
	}
}

/**
 * Everything needed to provision, or a list of what is missing. Returned as a
 * discriminated union rather than throwing so both the hooks and the settings
 * page report the same reasons.
 */
export function validate(settings: Settings): { ok: true } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	if (!settings.cfAccountId) missing.push("Cloudflare account ID");
	else if (!ACCOUNT_ID_RE.test(settings.cfAccountId))
		missing.push("a valid account ID (32 hex characters)");
	if (!settings.cfApiToken) missing.push("Cloudflare API token");
	if (!settings.deployKey) missing.push("marketplace deploy key");
	if (!settings.zone) missing.push("platform zone");
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** Redact everything but the shape of a secret, for safe display. */
export function redact(token: string): string {
	if (!token) return "";
	return token.length <= 8 ? "••••••••" : `••••••••${token.slice(-4)}`;
}

/**
 * Persist only the fields present and usable.
 *
 * Secrets get special treatment: Block Kit `secret_input` submits an empty
 * string when the field is left untouched, so writing it blindly would wipe a
 * working credential every time an unrelated field is edited. An empty
 * submission is ignored; clearing is the explicit value "clear".
 */
export async function saveSettings(
	ctx: PluginContext,
	values: Record<string, unknown>,
): Promise<string | undefined> {
	const notes: string[] = [];

	if (typeof values.cfAccountId === "string") {
		await ctx.kv.set(`${KV_PREFIX}cfAccountId`, values.cfAccountId.trim().toLowerCase());
	}
	if (typeof values.zone === "string") {
		await ctx.kv.set(`${KV_PREFIX}zone`, values.zone.trim());
	}
	if (typeof values.marketplaceUrl === "string") {
		await ctx.kv.set(`${KV_PREFIX}marketplaceUrl`, values.marketplaceUrl.trim());
	}
	if (typeof values.ownerEmail === "string") {
		await ctx.kv.set(`${KV_PREFIX}ownerEmail`, values.ownerEmail.trim());
	}

	for (const key of ["cfApiToken", "deployKey"] as const) {
		if (typeof values[key] === "string") {
			const secret = (values[key] as string).trim();
			if (secret === "clear") {
				await ctx.kv.set(`${KV_PREFIX}${key}`, "");
				notes.push(`${label(key)} cleared.`);
			} else if (secret) {
				await ctx.kv.set(`${KV_PREFIX}${key}`, secret);
				notes.push(`${label(key)} updated.`);
			}
		}
	}

	return notes.length ? notes.join(" ") : "Settings saved.";
}

function label(key: "cfApiToken" | "deployKey"): string {
	return key === "cfApiToken" ? "API token" : "Deploy key";
}
