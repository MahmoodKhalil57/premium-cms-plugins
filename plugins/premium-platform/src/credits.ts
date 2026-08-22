/**
 * Credits + usage for child projects (premiumcms platform).
 *
 * The parent owns the price book, the cost-plus markup and Stripe. It writes
 * straight into a child's D1 (same API the provisioner uses for options):
 * credit purchases and off-platform usage (Cloudflare requests/CPU, D1 rows,
 * R2 ops/storage) pulled just-in-time from Cloudflare's analytics. The child
 * meters its own actions (grants, emails, uploads, plugin routes) locally.
 */
import type { ProviderEnv } from "./env.js";
import { cfApi, http, randomToken } from "./env.js";
import { getProject, type ProjectRow, updateProject } from "./registry.js";
import type { PluginContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";

/** Parent cost per unit in micro-dollars (mirrors core DEFAULT_PRICES; overridable with PRICE_LIST_JSON). */
export const BASE_PRICES: Record<string, number> = {
	"grant:read": 2,
	"grant:write": 20,
	"grant:heavy": 200,
	"media:upload": 50,
	"media:mb": 30,
	"email:send": 100,
	"plugin:route": 10,
	"cf:request": 0.3,
	"cf:cpu_ms": 0.02,
	"cf:d1_rows_read": 0.001,
	"cf:d1_rows_written": 1,
	"cf:r2_class_a": 4.5,
	"cf:r2_class_b": 0.36,
	"cf:r2_gb_day": 0.5,
	"cf:egress_gb": 0,
};

export function priceBook(env: ProviderEnv): { prices: Record<string, number>; markup: number } {
	let prices: Record<string, number> = {};
	try {
		const parsed = env.PRICE_LIST_JSON ? (JSON.parse(env.PRICE_LIST_JSON) as Record<string, number>) : {};
		prices = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "number" && v >= 0));
	} catch {
		prices = {};
	}
	const markup = Number(env.CREDITS_MARKUP) > 1 ? Number(env.CREDITS_MARKUP) : 2;
	return { prices: { ...BASE_PRICES, ...prices }, markup };
}

/* ---- child D1 access -------------------------------------------------- */

async function childQuery(ctx: PluginContext, env: ProviderEnv, d1Id: string, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
	const res = await cfApi<Array<{ results?: Array<Record<string, unknown>> }>>(ctx, env, "POST", `/d1/database/${d1Id}/query`, { sql, params });
	if (!res.success) throw new Error(`child query failed: ${JSON.stringify(res.errors)}`);
	return res.result?.[0]?.results ?? [];
}

async function childSetOption(ctx: PluginContext, env: ProviderEnv, d1Id: string, name: string, value: unknown): Promise<void> {
	await childQuery(ctx, env, d1Id, "INSERT INTO options (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value", [name, JSON.stringify(value)]);
}

interface LedgerRow {
	kind: string;
	key: string;
	quantity: number;
	costMicros: number;
	chargeMicros: number;
	ref: string;
	day: string;
	meta?: Record<string, unknown>;
}

/** Idempotent inserts (unique `ref`); returns how many were new. */
async function childInsertUsage(ctx: PluginContext, env: ProviderEnv, d1Id: string, rows: LedgerRow[]): Promise<number> {
	let inserted = 0;
	for (const r of rows) {
		const id = `${Date.now().toString(36)}${randomToken(8)}`.toUpperCase().slice(0, 26);
		const res = await cfApi<Array<{ meta?: { changes?: number } }>>(ctx, env, "POST", `/d1/database/${d1Id}/query`, {
			sql: "INSERT OR IGNORE INTO _emdash_usage (id, ts, day, kind, key, quantity, cost_micros, charge_micros, actor_id, meta, source, ref) VALUES (?1, datetime('now'), ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, 'parent', ?9)",
			params: [id, r.day, r.kind, r.key, r.quantity, r.costMicros, r.chargeMicros, r.meta ? JSON.stringify(r.meta) : null, r.ref],
		});
		if (res.success && (res.result?.[0]?.meta?.changes ?? 0) > 0) inserted++;
	}
	return inserted;
}

export async function childBalance(ctx: PluginContext, env: ProviderEnv, d1Id: string): Promise<{ balanceMicros: number; purchasedMicros: number; spentMicros: number }> {
	const rows = await childQuery(ctx, env, d1Id, "SELECT coalesce(sum(case when charge_micros < 0 then -charge_micros else 0 end), 0) AS purchased, coalesce(sum(case when charge_micros > 0 then charge_micros else 0 end), 0) AS spent FROM _emdash_usage");
	const purchased = Number(rows[0]?.purchased ?? 0);
	const spent = Number(rows[0]?.spent ?? 0);
	return { balanceMicros: purchased - spent, purchasedMicros: purchased, spentMicros: spent };
}

/** Push the provider's price book + enforcement flag into a child (at setup and whenever settings change). */
export async function pushCreditsSettings(ctx: PluginContext, env: ProviderEnv, project: ProjectRow): Promise<void> {
	if (!project.d1_id) return;
	const book = priceBook(env);
	await childSetOption(ctx, env, project.d1_id, "credits:prices", book.prices);
	await childSetOption(ctx, env, project.d1_id, "credits:markup", book.markup);
	await childSetOption(ctx, env, project.d1_id, "credits:enforce", env.CREDITS_ENFORCE === "true");
}

export async function grantCredits(ctx: PluginContext, env: ProviderEnv, project: ProjectRow, micros: number, ref: string, note: string, meta?: Record<string, unknown>): Promise<boolean> {
	if (!project.d1_id) throw new Error("project has no database");
	const n = await childInsertUsage(ctx, env, project.d1_id, [{ kind: "credit", key: "credit:purchase", quantity: 1, costMicros: 0, chargeMicros: -Math.abs(micros), ref, day: new Date().toISOString().slice(0, 10), meta: { note, ...(meta ?? {}) } }]);
	return n > 0;
}

/* ---- off-platform usage (Cloudflare analytics, JIT) ------------------- */

async function graphql<T>(ctx: PluginContext, env: ProviderEnv, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await http(ctx, "https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
	const data = res.json<{ data?: { viewer?: { accounts?: T[] } }; errors?: Array<{ message: string }> }>();
	if (!res.ok || data.errors?.length) throw new Error(`analytics: ${data.errors?.[0]?.message ?? res.status}`);
	return (data.data?.viewer?.accounts?.[0] ?? {}) as T;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Pull a project's Cloudflare usage for the last `days` days and record it in
 * the child's ledger (one row per resource per day, idempotent). Today is
 * re-recorded on every sync (its ref carries the hour) so the page stays live.
 */
export async function syncExternalUsage(ctx: PluginContext, env: ProviderEnv, project: ProjectRow, days = 30): Promise<{ inserted: number; days: number; detail?: string }> {
	if (!project.d1_id) return { inserted: 0, days: 0, detail: "no database" };
	const to = new Date();
	const from = new Date(Date.now() - (days - 1) * 86_400_000);
	const vars = { acct: env.CF_ACCOUNT_ID, script: project.id, from: day(from), to: day(to) };
	const book = priceBook(env);
	const price = (key: string, qty: number) => {
		const cost = (book.prices[key] ?? 0) * qty;
		return { costMicros: cost, chargeMicros: cost * book.markup };
	};
	const rows: LedgerRow[] = [];
	const today = day(to);
	const hour = new Date().toISOString().slice(11, 13);
	const refFor = (key: string, d: string) => (d === today ? `${key}:${d}:h${hour}` : `${key}:${d}`);
	const errors: string[] = [];

	try {
		const w = await graphql<{ workersInvocationsAdaptive?: Array<{ dimensions: { date: string }; sum: { requests: number; subrequests: number; errors: number }; quantiles: { cpuTimeP50: number } }> }>(
			ctx, env,
			"query($acct:String!,$script:String!,$from:Date!,$to:Date!){viewer{accounts(filter:{accountTag:$acct}){workersInvocationsAdaptive(limit:400,filter:{scriptName:$script,date_geq:$from,date_leq:$to}){dimensions{date}sum{requests subrequests errors}quantiles{cpuTimeP50}}}}}",
			vars,
		);
		for (const g of w.workersInvocationsAdaptive ?? []) {
			const d = g.dimensions.date;
			rows.push({ kind: "external", key: "cf:request", quantity: g.sum.requests, ...price("cf:request", g.sum.requests), ref: refFor("cf:request", d), day: d, meta: { subrequests: g.sum.subrequests, errors: g.sum.errors } });
			const cpuMs = (g.quantiles.cpuTimeP50 / 1000) * g.sum.requests;
			rows.push({ kind: "external", key: "cf:cpu_ms", quantity: Math.round(cpuMs), ...price("cf:cpu_ms", cpuMs), ref: refFor("cf:cpu_ms", d), day: d, meta: { cpuTimeP50Us: g.quantiles.cpuTimeP50 } });
		}
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err));
	}
	try {
		const d1 = await graphql<{ d1AnalyticsAdaptiveGroups?: Array<{ dimensions: { date: string; databaseId: string }; sum: { rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number } }> }>(
			ctx, env,
			"query($acct:String!,$from:Date!,$to:Date!){viewer{accounts(filter:{accountTag:$acct}){d1AnalyticsAdaptiveGroups(limit:2000,filter:{date_geq:$from,date_leq:$to}){dimensions{date databaseId}sum{rowsRead rowsWritten readQueries writeQueries}}}}}",
			vars,
		);
		for (const g of d1.d1AnalyticsAdaptiveGroups ?? []) {
			if (g.dimensions.databaseId !== project.d1_id) continue;
			const d = g.dimensions.date;
			rows.push({ kind: "external", key: "cf:d1_rows_read", quantity: g.sum.rowsRead, ...price("cf:d1_rows_read", g.sum.rowsRead), ref: refFor("cf:d1_rows_read", d), day: d, meta: { readQueries: g.sum.readQueries } });
			rows.push({ kind: "external", key: "cf:d1_rows_written", quantity: g.sum.rowsWritten, ...price("cf:d1_rows_written", g.sum.rowsWritten), ref: refFor("cf:d1_rows_written", d), day: d, meta: { writeQueries: g.sum.writeQueries } });
		}
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err));
	}
	if (project.bucket) {
		try {
			const r2 = await graphql<{ r2OperationsAdaptiveGroups?: Array<{ dimensions: { date: string; bucketName: string; actionType: string }; sum: { requests: number } }>; r2StorageAdaptiveGroups?: Array<{ dimensions: { date: string; bucketName: string }; max: { payloadSize: number } }> }>(
				ctx, env,
				"query($acct:String!,$from:Date!,$to:Date!){viewer{accounts(filter:{accountTag:$acct}){r2OperationsAdaptiveGroups(limit:2000,filter:{date_geq:$from,date_leq:$to}){dimensions{date bucketName actionType}sum{requests}} r2StorageAdaptiveGroups(limit:2000,filter:{date_geq:$from,date_leq:$to}){dimensions{date bucketName}max{payloadSize}}}}}",
				vars,
			);
			const classA = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart", "ListObjects", "PutBucket", "DeleteObject", "ListBuckets"]);
			const perDay = new Map<string, { a: number; b: number }>();
			for (const g of r2.r2OperationsAdaptiveGroups ?? []) {
				if (g.dimensions.bucketName !== project.bucket) continue;
				const e = perDay.get(g.dimensions.date) ?? { a: 0, b: 0 };
				if (classA.has(g.dimensions.actionType)) e.a += g.sum.requests;
				else e.b += g.sum.requests;
				perDay.set(g.dimensions.date, e);
			}
			for (const [d, e] of perDay) {
				rows.push({ kind: "external", key: "cf:r2_class_a", quantity: e.a, ...price("cf:r2_class_a", e.a), ref: refFor("cf:r2_class_a", d), day: d });
				rows.push({ kind: "external", key: "cf:r2_class_b", quantity: e.b, ...price("cf:r2_class_b", e.b), ref: refFor("cf:r2_class_b", d), day: d });
			}
			for (const g of r2.r2StorageAdaptiveGroups ?? []) {
				if (g.dimensions.bucketName !== project.bucket) continue;
				const gb = g.max.payloadSize / 1e9;
				rows.push({ kind: "external", key: "cf:r2_gb_day", quantity: Number(gb.toFixed(4)), ...price("cf:r2_gb_day", gb), ref: refFor("cf:r2_gb_day", g.dimensions.date), day: g.dimensions.date });
			}
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
	}
	const inserted = await childInsertUsage(ctx, env, project.d1_id, rows.filter((r) => r.quantity > 0));
	await childSetOption(ctx, env, project.d1_id, "credits:synced_at", new Date().toISOString());
	return { inserted, days, detail: errors.length ? errors.join("; ") : undefined };
}

/* ---- Payment providers (Stripe, Polar) ------------------------------- */

export type PaymentProvider = "none" | "stripe" | "polar";

export function paymentProvider(env: ProviderEnv): PaymentProvider {
	const p = (env.PAYMENT_PROVIDER || "none").trim().toLowerCase();
	if (p === "stripe" && env.STRIPE_SECRET_KEY) return "stripe";
	if (p === "polar" && env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCT_ID) return "polar";
	return "none";
}

type Params = Record<string, string | number | boolean | undefined>;

async function stripe<T>(ctx: PluginContext, env: ProviderEnv, method: "GET" | "POST", path: string, params?: Params): Promise<T> {
	const body = params ? Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : undefined;
	const url = method === "GET" && body ? `https://api.stripe.com/v1${path}?${body}` : `https://api.stripe.com/v1${path}`;
	const res = await http(ctx, url, { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" }, body: method === "POST" ? body : undefined });
	const json = res.json<{ error?: { message?: string } } & T>();
	if (!res.ok) throw PluginRouteError.badRequest(`Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json;
}

async function polar<T>(ctx: PluginContext, env: ProviderEnv, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
	const res = await http(ctx, `https://api.polar.sh/v1${path}`, { method, headers: { Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const json = res.json<{ detail?: unknown; error?: string } & T>();
	if (!res.ok) throw PluginRouteError.badRequest(`Polar: ${typeof json.detail === "string" ? json.detail : (json.error ?? `HTTP ${res.status}`)}`);
	return json;
}

export const CREDIT_PACKS_CENTS = [1000, 2500, 5000, 10000];

export async function createCheckout(ctx: PluginContext, env: ProviderEnv, project: ProjectRow, amountCents: number, returnOrigin: string): Promise<{ url: string; sessionId: string; provider: PaymentProvider }> {
	if (!CREDIT_PACKS_CENTS.includes(amountCents)) throw PluginRouteError.badRequest("unsupported amount");
	const provider = paymentProvider(env);
	const successUrl = `${returnOrigin}/_emdash/admin/credits?credits=session:`;
	const cancelUrl = `${returnOrigin}/_emdash/admin/credits?credits=cancelled`;
	if (provider === "stripe") {
		let customer = project.stripe_customer_id ?? null;
		if (!customer) {
			const c = await stripe<{ id: string }>(ctx, env, "POST", "/customers", { email: project.admin_email, name: project.site_title, "metadata[project]": project.id });
			customer = c.id;
			await updateProject(ctx, project.id, { stripe_customer_id: customer });
		}
		const session = await stripe<{ id: string; url: string }>(ctx, env, "POST", "/checkout/sessions", {
			mode: "payment",
			customer,
			"line_items[0][price_data][currency]": "usd",
			"line_items[0][price_data][unit_amount]": amountCents,
			"line_items[0][price_data][product_data][name]": `PremiumCMS credits for ${project.site_title}`,
			"line_items[0][quantity]": 1,
			"metadata[project]": project.id,
			"metadata[credits_cents]": amountCents,
			success_url: `${successUrl}{CHECKOUT_SESSION_ID}`,
			cancel_url: cancelUrl,
		});
		return { url: session.url, sessionId: session.id, provider };
	}
	if (provider === "polar") {
		const checkout = await polar<{ id: string; url: string }>(ctx, env, "POST", "/checkouts/", {
			products: [env.POLAR_PRODUCT_ID],
			amount: amountCents,
			customer_email: project.admin_email,
			customer_name: project.site_title,
			success_url: `${successUrl}{CHECKOUT_ID}`,
			metadata: { project: project.id, credits_cents: String(amountCents) },
		});
		return { url: checkout.url, sessionId: checkout.id, provider };
	}
	throw PluginRouteError.badRequest("Credit purchases are not enabled yet — the provider has not configured a payment provider.");
}

/** Verify a returned checkout with the provider and credit the project once (the webhook does the same; `ref` makes it idempotent). */
export async function confirmCheckout(ctx: PluginContext, env: ProviderEnv, project: ProjectRow, sessionId: string): Promise<{ credited: boolean; cents: number }> {
	const provider = paymentProvider(env);
	if (provider === "stripe") {
		const s = await stripe<{ id: string; payment_status: string; amount_total: number; metadata?: Record<string, string>; payment_intent?: string }>(ctx, env, "GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
		if (s.metadata?.project !== project.id) throw PluginRouteError.forbidden("session belongs to another project");
		if (s.payment_status !== "paid") return { credited: false, cents: 0 };
		const cents = Number(s.metadata?.credits_cents ?? s.amount_total ?? 0);
		const credited = await grantCredits(ctx, env, project, cents * 10_000, `stripe:${s.id}`, "Credit purchase (Stripe)", { paymentIntent: s.payment_intent ?? null, amountCents: cents });
		return { credited, cents };
	}
	if (provider === "polar") {
		const c = await polar<{ id: string; status: string; amount?: number; metadata?: Record<string, string> }>(ctx, env, "GET", `/checkouts/${encodeURIComponent(sessionId)}`);
		if (c.metadata?.project !== project.id) throw PluginRouteError.forbidden("checkout belongs to another project");
		if (c.status !== "succeeded") return { credited: false, cents: 0 };
		const cents = Number(c.metadata?.credits_cents ?? c.amount ?? 0);
		const credited = await grantCredits(ctx, env, project, cents * 10_000, `polar:${c.id}`, "Credit purchase (Polar)", { amountCents: cents });
		return { credited, cents };
	}
	throw PluginRouteError.badRequest("No payment provider configured.");
}

/** A verified webhook event forwarded by the provider instance (see golden /billing-webhook/*). */
export async function applyBillingEvent(ctx: PluginContext, env: ProviderEnv, event: { provider: string; sessionId: string; project: string; creditsCents: number; paid: boolean; eventId?: string }): Promise<{ credited: boolean }> {
	if (!event.paid || !event.sessionId || !event.project || !(event.creditsCents > 0)) return { credited: false };
	const project = await getProject(ctx, event.project);
	if (!project) return { credited: false };
	const credited = await grantCredits(ctx, env, project, event.creditsCents * 10_000, `${event.provider}:${event.sessionId}`, `Credit purchase (${event.provider}, webhook)`, { eventId: event.eventId ?? null, amountCents: event.creditsCents });
	return { credited };
}
