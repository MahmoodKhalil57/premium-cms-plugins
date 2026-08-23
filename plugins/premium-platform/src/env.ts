/**
 * Provider environment for the sandboxed platform plugin.
 *
 * Credentials come from the plugin's settings (Plugins → Platform →
 * Settings). Every outbound call goes through ctx.http (the sandbox
 * bridge): responses are text-only, so JSON helpers live here.
 */

import type { PluginContext } from "./shim.js";

export interface ProviderEnv {
	CF_API_TOKEN: string;
	CF_ACCOUNT_ID: string;
	PLATFORM_ZONE: string;
	SES_ACCESS_KEY_ID: string;
	SES_SECRET_ACCESS_KEY: string;
	SES_REGION: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_SLUG: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_TEMPLATE_REPO: string;
	DEPLOY_SERVICE_URL: string;
	DEFAULT_COLOR_SCHEME: string;
	DEPLOY_KEY: string;
	STRIPE_SECRET_KEY: string;
	DEMO_ADMIN_EMAIL: string;
	BACKUP_STORE_URL: string;
	BACKUP_STORE_SECRET: string;
	BACKUPS_ENABLED: string;
	BACKUP_KEEP: string;
	CREDITS_MARKUP: string;
	PRICE_LIST_JSON: string;
	CREDITS_ENFORCE: string;
	PAYMENT_PROVIDER: string;
	STRIPE_WEBHOOK_SECRET: string;
	POLAR_ACCESS_TOKEN: string;
	POLAR_PRODUCT_ID: string;
	POLAR_WEBHOOK_SECRET: string;
	/** Account credits: one-off provisioning fee, credits every new project starts with (moved from the owner's account), packs offered. */
	PROVISION_FEE_CENTS: string;
	PROJECT_PRELOAD_CENTS: string;
	ACCOUNT_PACKS_CENTS: string;
	/** This provider's own origin (children call back here). */
	EMDASH_SITE_URL: string;
}

export const SETTING_KEYS = [
	"DEMO_ADMIN_EMAIL",
	"BACKUP_STORE_URL",
	"BACKUP_STORE_SECRET",
	"BACKUPS_ENABLED",
	"BACKUP_KEEP",
	"CF_API_TOKEN",
	"CF_ACCOUNT_ID",
	"PLATFORM_ZONE",
	"SES_ACCESS_KEY_ID",
	"SES_SECRET_ACCESS_KEY",
	"SES_REGION",
	"GITHUB_CLIENT_ID",
	"GITHUB_CLIENT_SECRET",
	"GITHUB_APP_ID",
	"GITHUB_APP_SLUG",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_TEMPLATE_REPO",
	"DEPLOY_SERVICE_URL",
	"DEFAULT_COLOR_SCHEME",
	"DEPLOY_KEY",
	"POLAR_WEBHOOK_SECRET",
	"POLAR_PRODUCT_ID",
	"POLAR_ACCESS_TOKEN",
	"STRIPE_WEBHOOK_SECRET",
	"PAYMENT_PROVIDER",
	"STRIPE_SECRET_KEY",
	"PROVISION_FEE_CENTS",
	"PROJECT_PRELOAD_CENTS",
	"ACCOUNT_PACKS_CENTS",
] as const;

export const CREDENTIALS_HINT = "Provider credentials not configured — open Plugins → Platform → Settings and add them.";

const TTL_MS = 20_000;
let cached: { at: number; env: ProviderEnv } | null = null;

export async function loadEnv(ctx: PluginContext): Promise<ProviderEnv> {
	if (cached && Date.now() - cached.at < TTL_MS) return { ...cached.env, EMDASH_SITE_URL: siteUrl(ctx) };
	const kv = ctx.kv as { list?: (prefix?: string) => Promise<Array<{ key: string; value: unknown }>> };
	const listed = typeof kv.list === "function" ? await kv.list("settings:").catch(() => null) : null;
	const bag: Record<string, unknown> = Array.isArray(listed) && listed.length ? Object.fromEntries(listed.map((r) => [r.key.replace(/^settings:/, ""), r.value])) : Object.fromEntries(await Promise.all(SETTING_KEYS.map(async (k) => [k, await ctx.kv.get<string>(`settings:${k}`)] as const)));
	const env = {} as Record<string, string>;
	SETTING_KEYS.forEach((k) => {
		env[k] = typeof bag[k] === "string" ? (bag[k] as string).trim() : "";
	});
	if (!env.DEPLOY_SERVICE_URL) env.DEPLOY_SERVICE_URL = "https://marketplace.premium-cms.com";
	env.DEPLOY_SERVICE_URL = env.DEPLOY_SERVICE_URL.replace(/\/$/, "");
	const out = env as unknown as ProviderEnv;
	cached = { at: Date.now(), env: out };
	return { ...out, EMDASH_SITE_URL: siteUrl(ctx) };
}

export function invalidateEnv(): void {
	cached = null;
}

export function siteUrl(ctx: PluginContext): string {
	const u = ctx.site?.url?.replace(/\/$/, "");
	if (u) return u;
	try {
		return new URL((ctx as { request?: Request }).request?.url ?? "").origin;
	} catch {
		return "";
	}
}

/* ------------------------------------------------------------------ */
/* HTTP through the sandbox bridge                                     */
/* ------------------------------------------------------------------ */

export interface HttpResult {
	status: number;
	ok: boolean;
	headers: Headers;
	text: string;
	json<T = Record<string, unknown>>(): T;
}

export async function http(ctx: PluginContext, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
	if (!ctx.http) throw new Error("network access is not available to the plugin");
	const res = await ctx.http.fetch(url, init as RequestInit);
	const text = await res.text();
	return {
		status: res.status,
		ok: res.status >= 200 && res.status < 300,
		headers: res.headers,
		text,
		json<T = Record<string, unknown>>(): T {
			try {
				return JSON.parse(text) as T;
			} catch {
				return {} as T;
			}
		},
	};
}

export function httpJson(ctx: PluginContext, url: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
	return http(ctx, url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

/* ------------------------------------------------------------------ */
/* Cloudflare API                                                      */
/* ------------------------------------------------------------------ */

export interface CfResult<T = unknown> {
	success: boolean;
	result: T;
	errors: Array<{ code: number; message: string }>;
}

export async function cfApi<T = unknown>(ctx: PluginContext, env: ProviderEnv, method: string, path: string, body?: unknown): Promise<CfResult<T>> {
	if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new Error(CREDENTIALS_HINT);
	const res = await http(ctx, `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`, {
		method,
		headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	try {
		return JSON.parse(res.text) as CfResult<T>;
	} catch {
		return { success: res.ok, result: undefined as T, errors: res.ok ? [] : [{ code: res.status, message: res.text.slice(0, 200) }] };
	}
}

/** Zone-scoped call (custom hostnames, routes, DNS records). */
export async function cfZone<T = unknown>(ctx: PluginContext, env: ProviderEnv, zoneId: string, method: string, path: string, body?: unknown): Promise<CfResult<T>> {
	const res = await http(ctx, `https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
		method,
		headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	try {
		return JSON.parse(res.text) as CfResult<T>;
	} catch {
		return { success: res.ok, result: undefined as T, errors: res.ok ? [] : [{ code: res.status, message: res.text.slice(0, 200) }] };
	}
}

let zoneCache: { zone: string; id: string } | null = null;

export async function cfZoneId(ctx: PluginContext, env: ProviderEnv): Promise<string> {
	if (!env.CF_API_TOKEN || !env.PLATFORM_ZONE) throw new Error(CREDENTIALS_HINT);
	if (zoneCache && zoneCache.zone === env.PLATFORM_ZONE) return zoneCache.id;
	const res = await http(ctx, `https://api.cloudflare.com/client/v4/zones?name=${env.PLATFORM_ZONE}&account.id=${env.CF_ACCOUNT_ID}`, {
		headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
	});
	const data = res.json<CfResult<Array<{ id: string }>>>();
	if (!data.success || !data.result?.[0]) throw new Error(`zone ${env.PLATFORM_ZONE} not found`);
	zoneCache = { zone: env.PLATFORM_ZONE, id: data.result[0].id };
	return zoneCache.id;
}

/* ------------------------------------------------------------------ */
/* Deploy service (trusted helper in the marketplace worker)           */
/* ------------------------------------------------------------------ */

export async function deployService<T = Record<string, unknown>>(ctx: PluginContext, env: ProviderEnv, path: string, body?: unknown, method = "POST"): Promise<T> {
	if (!env.DEPLOY_KEY) throw new Error("Deploy key not configured — set DEPLOY_KEY in Plugins → Platform → Settings (matches the marketplace worker's secret).");
	const res = await http(ctx, `${env.DEPLOY_SERVICE_URL}${path}`, {
		method,
		headers: { "Content-Type": "application/json", "X-Deploy-Key": env.DEPLOY_KEY },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = res.json<T & { error?: string }>();
	if (!res.ok) throw new Error(`deploy service ${res.status}: ${data.error ?? res.text.slice(0, 200)}`);
	return data;
}

export function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	let bin = "";
	for (const b of buf) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
