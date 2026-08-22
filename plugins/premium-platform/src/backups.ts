/**
 * Project backups: each project dumps its own database through its
 * `/backup-api` route into the backup store (master instance, which owns the
 * platform-artifacts bucket); restore replays a stored dump the same way.
 * Cloudflare's D1 export API is not used — it refuses databases with FTS5
 * virtual tables.
 */
import type { PluginContext, RouteContext } from "./shim.js";
import { http, loadEnv, type ProviderEnv } from "./env.js";
import { getProject, listProjects, type ProjectRow } from "./registry.js";

export interface BackupEntry { key: string; size: number; uploaded: string; note?: string }

const storeUrl = (env: ProviderEnv) => (env.BACKUP_STORE_URL || "https://master.premium-cms.com").replace(/\/$/, "");
function storeHeaders(env: ProviderEnv): Record<string, string> {
	if (!env.BACKUP_STORE_SECRET) throw new Error("Set the backup store secret in the platform plugin settings first");
	return { "x-provision-secret": env.BACKUP_STORE_SECRET, "Content-Type": "application/json" };
}
async function store<T>(ctx: PluginContext, env: ProviderEnv, body: unknown): Promise<T> {
	const res = await http(ctx, `${storeUrl(env)}/backup-api`, { method: "POST", headers: storeHeaders(env), body: JSON.stringify(body) });
	const json = JSON.parse(res.text || "{}") as T & { error?: string };
	if (!res.ok) throw new Error(`backup store: ${json.error ?? res.status}`);
	return json;
}

async function childBackupApi<T>(ctx: PluginContext, project: ProjectRow, body: Record<string, unknown>): Promise<T> {
	if (!project.provision_secret) throw new Error("project has no provision secret");
	const res = await http(ctx, `https://${project.hostname}/backup-api`, { method: "POST", headers: { "x-provision-secret": project.provision_secret, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const json = JSON.parse(res.text || "{}") as T & { error?: string };
	if (!res.ok) throw new Error(`project backup-api: ${json.error ?? res.status}`);
	return json;
}

/** The project dumps its own database (data-only SQL) straight into the store. */
export async function backupProject(ctx: PluginContext, env: ProviderEnv, project: ProjectRow, note = "manual"): Promise<BackupEntry> {
	if (project.status !== "live") throw new Error("project is not live");
	if (!env.BACKUP_STORE_SECRET) throw new Error("Set the backup store secret in the platform plugin settings first");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
	const key = `backups/${project.id}/${stamp}.sql`;
	const r = await childBackupApi<{ key: string; size: number; tables: number; rows: number }>(ctx, project, { op: "dump", key, note, store: { url: storeUrl(env), secret: env.BACKUP_STORE_SECRET } });
	return { key: r.key, size: r.size, uploaded: new Date().toISOString(), note };
}

export async function listBackups(ctx: PluginContext, env: ProviderEnv, projectId: string): Promise<BackupEntry[]> {
	const r = await store<{ items: BackupEntry[] }>(ctx, env, { op: "list", prefix: `backups/${projectId}/` });
	return r.items;
}

export async function deleteBackup(ctx: PluginContext, env: ProviderEnv, key: string): Promise<void> {
	await store(ctx, env, { op: "delete", key });
}

async function prune(ctx: PluginContext, env: ProviderEnv, projectId: string, keep: number): Promise<number> {
	const items = await listBackups(ctx, env, projectId);
	const extra = items.slice(Math.max(1, keep));
	for (const e of extra) await deleteBackup(ctx, env, e.key);
	return extra.length;
}

export async function restoreProject(ctx: PluginContext, env: ProviderEnv, project: ProjectRow, key: string): Promise<{ restored: string; statements: number; safety: BackupEntry }> {
	if (!key.startsWith(`backups/${project.id}/`)) throw new Error("that backup belongs to another project");
	if (!env.BACKUP_STORE_SECRET) throw new Error("Set the backup store secret in the platform plugin settings first");
	const safety = await backupProject(ctx, env, project, `pre-restore of ${key.split("/").pop()}`);
	const r = await childBackupApi<{ restored: string; statements: number }>(ctx, project, { op: "restore", key, store: { url: storeUrl(env), secret: env.BACKUP_STORE_SECRET } });
	return { ...r, safety };
}

async function needProject(ctx: PluginContext, id: string): Promise<ProjectRow> {
	const p = await getProject(ctx, id);
	if (!p) throw new Error(`unknown project ${id}`);
	return p;
}

export async function projectBackup(ctx: RouteContext<{ id: string; note?: string }>) {
	const env = await loadEnv(ctx);
	const project = await needProject(ctx, ctx.input.id);
	const entry = await backupProject(ctx, env, project, ctx.input.note || "manual");
	return { backup: entry };
}

export async function projectBackups(ctx: RouteContext<{ id: string }>) {
	const env = await loadEnv(ctx);
	await needProject(ctx, ctx.input.id);
	return { items: await listBackups(ctx, env, ctx.input.id) };
}

export async function projectBackupDelete(ctx: RouteContext<{ id: string; key: string }>) {
	const env = await loadEnv(ctx);
	if (!ctx.input.key.startsWith(`backups/${ctx.input.id}/`)) throw new Error("key does not belong to this project");
	await deleteBackup(ctx, env, ctx.input.key);
	return { deleted: ctx.input.key };
}

export async function projectRestore(ctx: RouteContext<{ id: string; key: string; confirm?: boolean }>) {
	if (ctx.input.confirm !== true) throw new Error("Restoring replaces the project's database. Send confirm: true.");
	const env = await loadEnv(ctx);
	const project = await needProject(ctx, ctx.input.id);
	return await restoreProject(ctx, env, project, ctx.input.key);
}

/** Nightly: export every live project, then prune to the configured retention. */
export async function backupsNightly(ctx: PluginContext): Promise<{ ok: string[]; failed: Array<{ id: string; error: string }> }> {
	const enabled = await ctx.kv.get<unknown>("settings:BACKUPS_ENABLED");
	const out = { ok: [] as string[], failed: [] as Array<{ id: string; error: string }> };
	if (enabled === false) return out;
	const env = await loadEnv(ctx);
	if (!env.BACKUP_STORE_SECRET) return out;
	const keep = Math.max(1, Number(await ctx.kv.get<unknown>("settings:BACKUP_KEEP")) || 14);
	for (const p of await listProjects(ctx)) {
		if (p.status !== "live" || !p.d1_id) continue;
		try {
			await backupProject(ctx, env, p, "nightly");
			await prune(ctx, env, p.id, keep);
			out.ok.push(p.id);
		} catch (err) {
			out.failed.push({ id: p.id, error: err instanceof Error ? err.message : String(err) });
		}
	}
	await ctx.kv.set("backups:last-run", { at: new Date().toISOString(), ...out });
	return out;
}
