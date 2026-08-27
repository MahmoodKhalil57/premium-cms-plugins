/**
 * Cost-plus credits + usage metering for provisioned child instances.
 *
 * The parent (this plugin) owns the price book, the markup and the payment
 * keys. It meters each child's real Cloudflare running cost from CF's GraphQL
 * analytics and writes priced rows straight into the child's own billing
 * ledger (`_emdash_usage`, created by core migration 073) over the D1 API —
 * the same channel the provisioner uses. Credit top-ups land in the same
 * ledger as negative-charge rows, so the child's balance is `-SUM(charge)`.
 *
 * Every child instance therefore holds its own bill; this file is the parent
 * side that fills it in and takes payment. Ported from the pre-reset provider,
 * adapted to plugin settings + ctx.http instead of a Worker env.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { cfApi, d1Query, http, type CfResult } from "./cf.js";
import type { ProjectState } from "./provisioner.js";
import { credsOf, type CfCreds, type Settings } from "./settings.js";

/** Parent cost per unit in micro-dollars (1e-6 USD). */
export const BASE_PRICES: Record<string, number> = {
	"cf:request": 0.3,
	"cf:cpu_ms": 0.02,
	"cf:d1_rows_read": 0.001,
	"cf:d1_rows_written": 1,
	"cf:r2_class_a": 4.5,
	"cf:r2_class_b": 0.36,
	"cf:r2_gb_day": 0.5,
	"cf:egress_gb": 0,
};

export function priceBook(settings: Settings): { prices: Record<string, number>; markup: number } {
	const markup = settings.creditsMarkup > 1 ? settings.creditsMarkup : 2;
	return { prices: { ...BASE_PRICES }, markup };
}

/* ── child ledger access (over the D1 API) ─────────────────────────── */

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

/** Append rows to a child's ledger; idempotent on `ref` (INSERT OR IGNORE). */
async function childInsertUsage(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	rows: LedgerRow[],
): Promise<number> {
	if (rows.length === 0) return 0;
	// One statement for all rows: a busy child produces many rows (metrics ×
	// days) and a scheduled invocation has a small subrequest budget, so a
	// per-row round-trip would exhaust it and the tick would be cancelled.
	const tuple = "(?, datetime('now'), ?, ?, ?, ?, ?, ?, NULL, ?, 'parent', ?)";
	const params: unknown[] = [];
	for (const r of rows) {
		params.push(
			`u_${r.ref}`.slice(0, 120),
			r.day,
			r.kind,
			r.key,
			r.quantity,
			Math.round(r.costMicros),
			Math.round(r.chargeMicros),
			r.meta ? JSON.stringify(r.meta) : null,
			r.ref,
		);
	}
	const sql =
		"INSERT OR IGNORE INTO _emdash_usage (id, ts, day, kind, key, quantity, cost_micros, charge_micros, actor_id, meta, source, ref) VALUES " +
		rows.map(() => tuple).join(", ");
	const res = await d1Query(ctx, creds, d1Id, sql, params);
	return res.success ? rows.length : 0;
}

/** Upsert a single option into a child's `options` table. */
async function childSetOption(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	name: string,
	value: unknown,
): Promise<void> {
	await d1Query(
		ctx,
		creds,
		d1Id,
		"INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
		[name, JSON.stringify(value)],
	);
}

/** Upsert several options in a single statement (fewer subrequests). */
async function childSetOptions(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
	entries: Array<[string, unknown]>,
): Promise<void> {
	if (entries.length === 0) return;
	const params: unknown[] = [];
	for (const [name, value] of entries) params.push(name, JSON.stringify(value));
	const sql =
		"INSERT INTO options (name, value) VALUES " +
		entries.map(() => "(?, ?)").join(", ") +
		" ON CONFLICT(name) DO UPDATE SET value = excluded.value";
	await d1Query(ctx, creds, d1Id, sql, params);
}

/** Read a child's current balance in micro-dollars (`-SUM(charge)`). */
export async function childBalanceMicros(
	ctx: PluginContext,
	creds: CfCreds,
	d1Id: string,
): Promise<number> {
	const res = await d1Query<Array<{ results?: Array<{ charged: number | null }> }>>(
		ctx,
		creds,
		d1Id,
		"SELECT COALESCE(SUM(charge_micros),0) AS charged FROM _emdash_usage",
	);
	const charged = res.result?.[0]?.results?.[0]?.charged ?? 0;
	return -(Number(charged) || 0);
}

/**
 * Push the price book, markup, enforcement flag and top-up target into a child
 * (at provision time and whenever settings change). This is what makes the
 * child's own /billing + /immutable-log screens show the right numbers.
 */
export async function pushCreditsSettings(
	ctx: PluginContext,
	settings: Settings,
	state: ProjectState,
): Promise<void> {
	if (!state.d1_id) return;
	const creds = credsOf(settings);
	const book = priceBook(settings);
	const parentUrl = `${(ctx.site?.url ?? "").replace(/\/$/, "")}/_emdash/api/plugins/premiumcms-projects/billingCheckout`;
	await childSetOptions(ctx, creds, state.d1_id, [
		["credits:prices", book.prices],
		["credits:markup", book.markup],
		["credits:enforce", settings.creditsEnforce],
		["billing:parent_url", parentUrl],
		["billing:project_id", state.id],
		["billing:currency", "USD"],
	]);
}

/** Add credits to a child (a top-up): a negative-charge ledger row. */
export async function grantCredits(
	ctx: PluginContext,
	settings: Settings,
	state: ProjectState,
	micros: number,
	ref: string,
	note: string,
	meta?: Record<string, unknown>,
): Promise<boolean> {
	if (!state.d1_id) throw new Error("project has no database");
	const creds = credsOf(settings);
	const day = new Date().toISOString().slice(0, 10);
	const n = await childInsertUsage(ctx, creds, state.d1_id, [
		{
			kind: "credit",
			key: "credit:purchase",
			quantity: 1,
			costMicros: 0,
			chargeMicros: -Math.abs(micros),
			ref,
			day,
			meta: { note, ...(meta ?? {}) },
		},
	]);
	// Refresh the cached balance the enforcement middleware reads.
	const balance = await childBalanceMicros(ctx, creds, state.d1_id);
	await childSetOption(ctx, creds, state.d1_id, "credits:balance_micros", balance);
	return n > 0;
}

/* ── Cloudflare usage (GraphQL analytics, priced into the ledger) ───── */

async function graphql<T>(
	ctx: PluginContext,
	creds: CfCreds,
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	const res = await http(ctx, "https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${creds.apiToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const data = res.json<{
		data?: { viewer?: { accounts?: T[] } };
		errors?: Array<{ message: string }>;
	}>();
	if (!res.ok || data.errors?.length)
		throw new Error(`analytics: ${data.errors?.[0]?.message ?? res.status}`);
	return (data.data?.viewer?.accounts?.[0] ?? {}) as T;
}

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Pull a child's Cloudflare usage for the last `days` days, price it × markup,
 * and record it in the child's ledger (one row per resource per day,
 * idempotent). Today's rows carry the hour in their ref so the current day is
 * refreshed on each sync without duplicating. Updates the cached balance too.
 */
export async function syncExternalUsage(
	ctx: PluginContext,
	settings: Settings,
	state: ProjectState,
	days = 30,
): Promise<{ inserted: number; balanceMicros: number; detail?: string }> {
	if (!state.d1_id) return { inserted: 0, balanceMicros: 0, detail: "no database" };
	const creds = credsOf(settings);
	const to = new Date();
	const from = new Date(Date.now() - (days - 1) * 86_400_000);
	const vars = { acct: creds.accountId, script: state.id, from: dayStr(from), to: dayStr(to) };
	const book = priceBook(settings);
	const price = (key: string, qty: number) => {
		const cost = (book.prices[key] ?? 0) * qty;
		return { costMicros: cost, chargeMicros: cost * book.markup };
	};
	const rows: LedgerRow[] = [];
	const today = dayStr(to);
	const hour = new Date().toISOString().slice(11, 13);
	const refFor = (key: string, d: string) => (d === today ? `${key}:${d}:h${hour}` : `${key}:${d}`);
	const errors: string[] = [];

	try {
		const w = await graphql<{
			workersInvocationsAdaptive?: Array<{
				dimensions: { date: string };
				sum: { requests: number; subrequests: number; errors: number };
				quantiles: { cpuTimeP50: number };
			}>;
		}>(
			ctx,
			creds,
			"query($acct:String!,$script:String!,$from:Date!,$to:Date!){viewer{accounts(filter:{accountTag:$acct}){workersInvocationsAdaptive(limit:400,filter:{scriptName:$script,date_geq:$from,date_leq:$to}){dimensions{date}sum{requests subrequests errors}quantiles{cpuTimeP50}}}}}",
			vars,
		);
		for (const g of w.workersInvocationsAdaptive ?? []) {
			const d = g.dimensions.date;
			rows.push({
				kind: "external",
				key: "cf:request",
				quantity: g.sum.requests,
				...price("cf:request", g.sum.requests),
				ref: refFor("cf:request", d),
				day: d,
				meta: { subrequests: g.sum.subrequests, errors: g.sum.errors },
			});
			const cpuMs = (g.quantiles.cpuTimeP50 / 1000) * g.sum.requests;
			rows.push({
				kind: "external",
				key: "cf:cpu_ms",
				quantity: Math.round(cpuMs),
				...price("cf:cpu_ms", cpuMs),
				ref: refFor("cf:cpu_ms", d),
				day: d,
			});
		}
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err));
	}

	try {
		const d1 = await graphql<{
			d1AnalyticsAdaptiveGroups?: Array<{
				dimensions: { date: string; databaseId: string };
				sum: { rowsRead: number; rowsWritten: number };
			}>;
		}>(
			ctx,
			creds,
			"query($acct:String!,$from:Date!,$to:Date!){viewer{accounts(filter:{accountTag:$acct}){d1AnalyticsAdaptiveGroups(limit:2000,filter:{date_geq:$from,date_leq:$to}){dimensions{date databaseId}sum{rowsRead rowsWritten}}}}}",
			vars,
		);
		for (const g of d1.d1AnalyticsAdaptiveGroups ?? []) {
			if (g.dimensions.databaseId !== state.d1_id) continue;
			const d = g.dimensions.date;
			rows.push({
				kind: "external",
				key: "cf:d1_rows_read",
				quantity: g.sum.rowsRead,
				...price("cf:d1_rows_read", g.sum.rowsRead),
				ref: refFor("cf:d1_rows_read", d),
				day: d,
			});
			rows.push({
				kind: "external",
				key: "cf:d1_rows_written",
				quantity: g.sum.rowsWritten,
				...price("cf:d1_rows_written", g.sum.rowsWritten),
				ref: refFor("cf:d1_rows_written", d),
				day: d,
			});
		}
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err));
	}

	if (state.bucket) {
		try {
			const r2 = await graphql<{
				r2OperationsAdaptiveGroups?: Array<{
					dimensions: { date: string; bucketName: string; actionType: string };
					sum: { requests: number };
				}>;
				r2StorageAdaptiveGroups?: Array<{
					dimensions: { date: string; bucketName: string };
					max: { payloadSize: number };
				}>;
			}>(
				ctx,
				creds,
				"query($acct:String!,$from:Date!,$to:Date!){viewer{accounts(filter:{accountTag:$acct}){r2OperationsAdaptiveGroups(limit:2000,filter:{date_geq:$from,date_leq:$to}){dimensions{date bucketName actionType}sum{requests}} r2StorageAdaptiveGroups(limit:2000,filter:{date_geq:$from,date_leq:$to}){dimensions{date bucketName}max{payloadSize}}}}}",
				vars,
			);
			const classA = new Set([
				"PutObject",
				"CopyObject",
				"CompleteMultipartUpload",
				"CreateMultipartUpload",
				"UploadPart",
				"ListObjects",
				"PutBucket",
				"DeleteObject",
				"ListBuckets",
			]);
			const perDay = new Map<string, { a: number; b: number }>();
			for (const g of r2.r2OperationsAdaptiveGroups ?? []) {
				if (g.dimensions.bucketName !== state.bucket) continue;
				const e = perDay.get(g.dimensions.date) ?? { a: 0, b: 0 };
				if (classA.has(g.dimensions.actionType)) e.a += g.sum.requests;
				else e.b += g.sum.requests;
				perDay.set(g.dimensions.date, e);
			}
			for (const [d, e] of perDay) {
				rows.push({
					kind: "external",
					key: "cf:r2_class_a",
					quantity: e.a,
					...price("cf:r2_class_a", e.a),
					ref: refFor("cf:r2_class_a", d),
					day: d,
				});
				rows.push({
					kind: "external",
					key: "cf:r2_class_b",
					quantity: e.b,
					...price("cf:r2_class_b", e.b),
					ref: refFor("cf:r2_class_b", d),
					day: d,
				});
			}
			for (const g of r2.r2StorageAdaptiveGroups ?? []) {
				if (g.dimensions.bucketName !== state.bucket) continue;
				const gb = g.max.payloadSize / 1e9;
				rows.push({
					kind: "external",
					key: "cf:r2_gb_day",
					quantity: Number(gb.toFixed(4)),
					...price("cf:r2_gb_day", gb),
					ref: refFor("cf:r2_gb_day", g.dimensions.date),
					day: g.dimensions.date,
				});
			}
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
	}

	const inserted = await childInsertUsage(
		ctx,
		creds,
		state.d1_id,
		rows.filter((r) => r.quantity > 0),
	);
	const balance = await childBalanceMicros(ctx, creds, state.d1_id);
	await childSetOptions(ctx, creds, state.d1_id, [
		["credits:balance_micros", balance],
		["credits:synced_at", new Date().toISOString()],
	]);
	return {
		inserted,
		balanceMicros: balance,
		detail: errors.length ? errors.join("; ") : undefined,
	};
}

// Keep CfResult referenced for downstream type-only consumers.
export type { CfResult };
