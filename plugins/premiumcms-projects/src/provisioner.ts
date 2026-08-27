/**
 * Provisioning state machine: createResources → deployWorker → attachDomain →
 * bootstrapOwner, plus destroyProject. Idempotent and resumable — the whole
 * per-project state lives in ctx.kv under `state:project:<id>`, so `advance`
 * runs exactly one step per call and the cron hook drives it forward.
 *
 * Ported from the pre-reset provider's provisioner.ts, trimmed to the
 * Cloudflare + deploy-service surface (no SES / GitHub / routes / credits) and
 * re-pointed at plugin settings for credentials.
 *
 * The golden bundle itself is uploaded by the trusted marketplace deploy
 * service; this plugin supplies the per-project bindings and the provider's
 * Cloudflare credentials.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { cfApi, cfZoneId, d1Query, deployService } from "./cf.js";
import { credsOf, type Settings } from "./settings.js";

const NAME_RE = /^[a-z][a-z0-9-]{1,28}$/;
const RESERVED = new Set([
	"apex",
	"www",
	"mail",
	"send",
	"api",
	"admin",
	"platform",
	"fallback",
	"marketplace",
	"master",
]);

const STATE_PREFIX = "state:project:";

export type ProjectStatus = "creating" | "resources" | "deployed" | "domain" | "live" | "error";

export interface ProjectState {
	id: string;
	label: string;
	theme: string;
	hostname: string;
	status: ProjectStatus;
	error: string | null;
	d1_id: string | null;
	kv_id: string | null;
	bucket: string | null;
	owner_email: string;
	/** Row id of the matching Projects-collection entry (mirror target). */
	content_id?: string | null;
	created_at: string;
	updated_at: string;
}

/* ------------------------------------------------------------------ */
/* id + kv-state helpers                                               */
/* ------------------------------------------------------------------ */

/** Slugify a human label into a project id, or throw with the reason. */
export function projectIdFromLabel(label: string): string {
	const id = label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	if (!NAME_RE.test(id))
		throw new Error(
			`invalid project name "${id}" (2–29 chars, start with a letter, [a-z0-9-] only)`,
		);
	if (RESERVED.has(id)) throw new Error(`"${id}" is a reserved name`);
	return id;
}

export async function getState(ctx: PluginContext, id: string): Promise<ProjectState | null> {
	return ctx.kv.get<ProjectState>(`${STATE_PREFIX}${id}`);
}

export async function putState(ctx: PluginContext, state: ProjectState): Promise<ProjectState> {
	state.updated_at = new Date().toISOString();
	await ctx.kv.set(`${STATE_PREFIX}${state.id}`, state);
	return state;
}

export async function listStates(ctx: PluginContext): Promise<ProjectState[]> {
	const rows = await ctx.kv.list(STATE_PREFIX);
	return rows
		.map((r) => r.value as ProjectState)
		.filter((s): s is ProjectState => Boolean(s && s.id));
}

export async function deleteState(ctx: PluginContext, id: string): Promise<void> {
	await ctx.kv.delete(`${STATE_PREFIX}${id}`);
}

/** Seed the kv state for a brand-new project. Idempotent — returns the existing row if present. */
export async function seedState(
	ctx: PluginContext,
	settings: Settings,
	input: {
		id: string;
		label: string;
		theme: string;
		ownerEmail?: string;
		contentId?: string | null;
	},
): Promise<ProjectState> {
	const existing = await getState(ctx, input.id);
	if (existing) return existing;
	const now = new Date().toISOString();
	const state: ProjectState = {
		id: input.id,
		label: input.label.trim() || input.id,
		theme: input.theme || "",
		hostname: `${input.id}.${settings.zone}`,
		status: "creating",
		error: null,
		d1_id: null,
		kv_id: null,
		bucket: null,
		owner_email: (input.ownerEmail || settings.ownerEmail || "").trim(),
		content_id: input.contentId ?? null,
		created_at: now,
		updated_at: now,
	};
	return putState(ctx, state);
}

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The child Worker's binding set — mirrors the known-good apex instance.
 * Order is not significant to the deploy service, but the names are the
 * contract the golden bundle expects.
 */
export function projectBindings(id: string, state: ProjectState): unknown[] {
	return [
		{ type: "d1", name: "DB", id: state.d1_id },
		{ type: "kv_namespace", name: "SESSION", namespace_id: state.kv_id },
		{ type: "r2_bucket", name: "MEDIA", bucket_name: state.bucket },
		{ type: "images", name: "IMAGES" },
		{ type: "worker_loader", name: "LOADER" },
		{ type: "assets", name: "ASSETS" },
		{ type: "send_email", name: "EMAIL" },
	];
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/** CF: create (or reuse) the D1 database, KV namespace and R2 bucket. */
export async function createResources(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<ProjectState> {
	const state = await getState(ctx, id);
	if (!state) throw new Error("unknown project");
	const creds = credsOf(settings);

	const d1 = await cfApi<{ uuid: string }>(ctx, creds, "POST", "/d1/database", {
		name: `${id}-db`,
	});
	let d1Id: string | undefined = d1.result?.uuid;
	if (!d1.success || !d1Id) {
		const list = await cfApi<Array<{ uuid: string; name: string }>>(
			ctx,
			creds,
			"GET",
			"/d1/database?per_page=100",
		);
		d1Id = list.result?.find((d) => d.name === `${id}-db`)?.uuid;
		if (!d1Id) throw new Error(`d1 create failed: ${JSON.stringify(d1.errors)}`);
	}

	const kv = await cfApi<{ id: string }>(ctx, creds, "POST", "/storage/kv/namespaces", {
		title: `${id}-session`,
	});
	let kvId: string | undefined = kv.result?.id;
	if (!kv.success || !kvId) {
		const list = await cfApi<Array<{ id: string; title: string }>>(
			ctx,
			creds,
			"GET",
			"/storage/kv/namespaces?per_page=100",
		);
		kvId = list.result?.find((n) => n.title === `${id}-session`)?.id;
		if (!kvId) throw new Error(`kv create failed: ${JSON.stringify(kv.errors)}`);
	}

	const r2 = await cfApi(ctx, creds, "POST", "/r2/buckets", { name: `${id}-media` });
	if (!r2.success && !JSON.stringify(r2.errors).includes("already exists"))
		throw new Error(`r2 create failed: ${JSON.stringify(r2.errors)}`);

	state.d1_id = d1Id;
	state.kv_id = kvId;
	state.bucket = `${id}-media`;
	state.status = "resources";
	state.error = null;
	return putState(ctx, state);
}

/** Deploy service: upload the golden bundle for this project with its bindings. */
export async function deployWorker(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<ProjectState> {
	const state = await getState(ctx, id);
	if (!state) throw new Error("unknown project");
	if (!state.d1_id || !state.kv_id) throw new Error("resources not created yet");
	await deployService(ctx, settings, "/api/v1/deploy", {
		accountId: settings.cfAccountId,
		apiToken: settings.cfApiToken,
		script: id,
		theme: state.theme,
		version: "latest",
		bindings: projectBindings(id, state),
		cron: "* * * * *",
	});
	state.status = "deployed";
	state.error = null;
	return putState(ctx, state);
}

/** CF: bind the assigned `<id>.<zone>` hostname to the project's Worker. */
export async function attachDomain(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<ProjectState> {
	const state = await getState(ctx, id);
	if (!state) throw new Error("unknown project");
	const creds = credsOf(settings);
	const zoneId = await cfZoneId(ctx, creds, settings.zone);
	const res = await cfApi(ctx, creds, "PUT", "/workers/domains", {
		zone_id: zoneId,
		hostname: state.hostname,
		service: id,
		environment: "production",
	});
	if (!res.success && !JSON.stringify(res.errors).includes("already"))
		throw new Error(`domain attach failed: ${JSON.stringify(res.errors)}`);
	state.status = "domain";
	state.error = null;
	return putState(ctx, state);
}

/**
 * (a) Poke the child's root once so its first-boot migrations + auto-seed run,
 * then (b) insert the owner user + the setup-complete option straight into the
 * child's D1. Both statements are idempotent, so re-running is safe.
 */
export async function bootstrapOwner(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<ProjectState> {
	const state = await getState(ctx, id);
	if (!state) throw new Error("unknown project");
	if (!state.d1_id) throw new Error("d1 not created yet");
	const creds = credsOf(settings);

	// (a) Trigger first boot. Ignore the result — a cold worker may 5xx once.
	try {
		if (ctx.http) await ctx.http.fetch(`https://${state.hostname}/`, { method: "GET" });
	} catch {
		// non-fatal — the D1 writes below create the tables' rows regardless
	}

	const now = new Date().toISOString();
	const email = (state.owner_email || settings.ownerEmail || "").trim();
	if (!email) throw new Error("no owner email — set ownerEmail in Settings or on the project row");
	const userId = ulid();

	// D1's query endpoint runs one statement per call, so these are two calls.
	const insUser = await d1Query(
		ctx,
		creds,
		state.d1_id,
		"INSERT OR IGNORE INTO users (id,email,name,role,role_id,email_verified,disabled,created_at,updated_at) VALUES (?, ?, ?, 50, 'role:admin', 0, 0, ?, ?)",
		[userId, email, state.label, now, now],
	);
	if (!insUser.success) throw new Error(`owner insert failed: ${JSON.stringify(insUser.errors)}`);

	const insOpt = await d1Query(
		ctx,
		creds,
		state.d1_id,
		"INSERT INTO options (name,value) VALUES ('emdash:setup_complete','true') ON CONFLICT(name) DO UPDATE SET value='true'",
	);
	if (!insOpt.success)
		throw new Error(`setup-complete option failed: ${JSON.stringify(insOpt.errors)}`);

	state.status = "live";
	state.error = null;
	return putState(ctx, state);
}

/**
 * Tear a project down: worker script, assigned domain(s), R2 bucket (via the
 * deploy service — unbounded object count), KV namespace, D1 database, the kv
 * state row, and the matching Projects-collection row. Best-effort: collects
 * removed/warnings rather than aborting on the first failure.
 */
export async function destroyProject(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<{ removed: string[]; warnings: string[] }> {
	const state = await getState(ctx, id);
	if (!state) throw new Error("unknown project");
	const creds = credsOf(settings);
	const removed: string[] = [];
	const warnings: string[] = [];

	const wd = await cfApi<Array<{ id: string; hostname: string; service: string }>>(
		ctx,
		creds,
		"GET",
		"/workers/domains",
	);
	for (const d of wd.result ?? []) {
		if (d.service !== id) continue;
		const r = await cfApi(ctx, creds, "DELETE", `/workers/domains/${d.id}`);
		if (r.success) removed.push(`domain ${d.hostname}`);
		else warnings.push(`domain ${d.hostname}: ${JSON.stringify(r.errors)}`);
	}

	const ws = await cfApi(ctx, creds, "DELETE", `/workers/scripts/${id}?force=true`);
	if (ws.success) removed.push("worker");
	else warnings.push(`worker: ${JSON.stringify(ws.errors)}`);

	if (state.bucket) {
		try {
			const r = await deployService<{ purged?: number; deleted?: boolean }>(
				ctx,
				settings,
				"/api/v1/destroy-bucket",
				{
					accountId: settings.cfAccountId,
					apiToken: settings.cfApiToken,
					bucket: state.bucket,
				},
			);
			removed.push(
				`R2 bucket${typeof r.purged === "number" ? ` (${r.purged} objects purged)` : ""}`,
			);
		} catch (err) {
			warnings.push(`R2 bucket: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (state.kv_id) {
		const kv = await cfApi(ctx, creds, "DELETE", `/storage/kv/namespaces/${state.kv_id}`);
		if (kv.success) removed.push("KV namespace");
		else warnings.push(`KV: ${JSON.stringify(kv.errors)}`);
	}

	if (state.d1_id) {
		const d1 = await cfApi(ctx, creds, "DELETE", `/d1/database/${state.d1_id}`);
		if (d1.success) removed.push("D1 database");
		else warnings.push(`D1: ${JSON.stringify(d1.errors)}`);
	}

	// Remove the mirror row in the Projects collection, if we know it.
	if (state.content_id && ctx.content?.delete) {
		try {
			await ctx.content.delete("projects", state.content_id);
			removed.push("Projects row");
		} catch (err) {
			warnings.push(`Projects row: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	await deleteState(ctx, id);
	removed.push("state");
	return { removed, warnings };
}

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run the single next provisioning step for a project, based on its current
 * status, and persist the outcome. Errors are caught and recorded as
 * `status: "error"` with the message, but the project stays retryable — a
 * later call re-runs the same step. Returns the project's status after the
 * step (or "error").
 */
export async function advance(
	ctx: PluginContext,
	settings: Settings,
	id: string,
): Promise<ProjectStatus> {
	const state = await getState(ctx, id);
	if (!state) throw new Error("unknown project");
	// Terminal — nothing to do.
	if (state.status === "live") return "live";

	try {
		switch (state.status) {
			case "error":
			case "creating": {
				await createResources(ctx, settings, id);
				return "resources";
			}
			case "resources": {
				await deployWorker(ctx, settings, id);
				return "deployed";
			}
			case "deployed": {
				await attachDomain(ctx, settings, id);
				return "domain";
			}
			case "domain": {
				await bootstrapOwner(ctx, settings, id);
				return "live";
			}
			default:
				return state.status;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Mark the row errored (cron skips it) but keep it retryable: every step
		// is idempotent — createResources reuses existing D1/KV/R2, deployWorker
		// re-deploys latest, attachDomain tolerates "already", bootstrapOwner uses
		// INSERT OR IGNORE / upsert — so a retry restarts the pipeline from
		// `creating` and idempotently walks back to where it was, one tick a step.
		const fresh = (await getState(ctx, id)) ?? state;
		fresh.error = `[${state.status}] ${message}`;
		fresh.status = "error";
		await putState(ctx, fresh);
		ctx.log.error(`[premiumcms-projects] advance(${id}) failed at ${state.status}`, message);
		return "error";
	}
}

/* ------------------------------------------------------------------ */
/* ULID (Crockford base32, time + randomness) — a unique text id       */
/* ------------------------------------------------------------------ */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	let time = Date.now();
	const timeChars: string[] = [];
	for (let i = 0; i < 10; i++) {
		timeChars.unshift(CROCKFORD[time % 32]);
		time = Math.floor(time / 32);
	}
	const rand = new Uint8Array(16);
	crypto.getRandomValues(rand);
	let randStr = "";
	for (let i = 0; i < 16; i++) randStr += CROCKFORD[rand[i] % 32];
	return timeChars.join("") + randStr;
}
