/**
 * Provisioning steps: createProject → deployWorker → attachDomain → setupCms,
 * and destroyProject. Idempotent; state in the registry.
 *
 * The golden bundle itself (hundreds of modules + assets) is uploaded by
 * the trusted deploy service in the marketplace worker — the sandbox
 * bridge can't carry binary bodies — with this plugin supplying the
 * per-project bindings and the provider's Cloudflare credentials.
 */

import { pushCreditsSettings } from "./credits.js";
import { templateRepoFor } from "./github.js";
import type { ProviderEnv } from "./env.js";
import { cfApi, cfZone, cfZoneId, deployService, httpJson, http, randomToken, loadEnv } from "./env.js";
import { githubPagesOrigin } from "./github.js";
import { deleteProjectRows, getDomains, getProject, projects, type ProjectRow, updateProject } from "./registry.js";
import { sesDeleteIdentity } from "./ses.js";
import type { PluginContext } from "./shim.js";

const NAME_RE = /^[a-z][a-z0-9-]{1,28}$/;
const RESERVED = new Set(["apex", "www", "mail", "send", "api", "admin", "platform", "fallback", "marketplace", "master"]);

export async function createProject(ctx: PluginContext, env: ProviderEnv, input: { id: string; adminEmail: string; siteTitle: string; tagline?: string }): Promise<ProjectRow> {
	const id = input.id.trim().toLowerCase();
	if (!NAME_RE.test(id) || RESERVED.has(id)) throw new Error(`invalid project name "${id}"`);
	if (!input.adminEmail.includes("@")) throw new Error("invalid admin email");
	if (!input.siteTitle.trim()) throw new Error("site title required");
	if (!env.PLATFORM_ZONE) throw new Error("PLATFORM_ZONE is not configured");
	const existing = await getProject(ctx, id);
	if (existing) return existing;

	const now = new Date().toISOString();
	const row: ProjectRow = {
		id,
		hostname: `${id}.${env.PLATFORM_ZONE}`,
		admin_email: input.adminEmail.toLowerCase(),
		site_title: input.siteTitle.trim(),
		tagline: input.tagline?.trim() || null,
		status: "created",
		error: null,
		d1_id: null,
		kv_id: null,
		bucket: null,
		bundle_version: null,
		provision_secret: randomToken(32),
		encryption_key: `emdash_enc_v1_${randomToken(32)}`,
		github_token: null,
		github_installation_id: null,
		github_login: null,
		github_repo: null,
		created_at: now,
		updated_at: now,
	};
	await projects(ctx).put(id, row);

	const d1 = await cfApi<{ uuid: string }>(ctx, env, "POST", "/d1/database", { name: `${id}-db` });
	let d1Id: string | undefined = d1.result?.uuid;
	if (!d1.success) {
		const list = await cfApi<Array<{ uuid: string; name: string }>>(ctx, env, "GET", "/d1/database?per_page=100");
		d1Id = list.result?.find((d) => d.name === `${id}-db`)?.uuid;
		if (!d1Id) throw new Error(`d1 create failed: ${JSON.stringify(d1.errors)}`);
	}
	const kv = await cfApi<{ id: string }>(ctx, env, "POST", "/storage/kv/namespaces", { title: `${id}-session` });
	let kvId: string | undefined = kv.result?.id;
	if (!kv.success) {
		const list = await cfApi<Array<{ id: string; title: string }>>(ctx, env, "GET", "/storage/kv/namespaces?per_page=100");
		kvId = list.result?.find((n) => n.title === `${id}-session`)?.id;
		if (!kvId) throw new Error(`kv create failed: ${JSON.stringify(kv.errors)}`);
	}
	const r2 = await cfApi(ctx, env, "POST", "/r2/buckets", { name: `${id}-media` });
	if (!r2.success && !JSON.stringify(r2.errors).includes("already exists")) throw new Error(`r2 create failed: ${JSON.stringify(r2.errors)}`);

	return updateProject(ctx, id, { status: "resources", d1_id: d1Id ?? null, kv_id: kvId ?? null, bucket: `${id}-media`, error: null });
}

export function projectBindings(env: ProviderEnv, project: ProjectRow): unknown[] {
	return [
		{ type: "assets", name: "ASSETS" },
		{ type: "d1", name: "DB", id: project.d1_id },
		{ type: "kv_namespace", name: "SESSION", namespace_id: project.kv_id },
		{ type: "r2_bucket", name: "MEDIA", bucket_name: project.bucket },
		{ type: "images", name: "IMAGES" },
		{ type: "worker_loader", name: "LOADER" },
		{ type: "secret_text", name: "EMDASH_ENCRYPTION_KEY", text: project.encryption_key },
		{ type: "secret_text", name: "EMDASH_SITE_URL", text: `https://${project.hostname}` },
		{ type: "secret_text", name: "PROVISION_SECRET", text: project.provision_secret },
		{ type: "secret_text", name: "EMAIL_FROM_NAME", text: project.site_title },
		{ type: "secret_text", name: "SES_FROM_EMAIL", text: `no-reply@${project.hostname}` },
		{ type: "secret_text", name: "PLATFORM_PARENT_URL", text: env.EMDASH_SITE_URL },
		{ type: "secret_text", name: "PLATFORM_ASSIGNED_DOMAIN", text: project.hostname },
		{ type: "secret_text", name: "PLATFORM_PROJECT_ID", text: project.id },
		{ type: "secret_text", name: "SES_ACCESS_KEY_ID", text: env.SES_ACCESS_KEY_ID },
		{ type: "secret_text", name: "SES_SECRET_ACCESS_KEY", text: env.SES_SECRET_ACCESS_KEY },
		{ type: "secret_text", name: "SES_REGION", text: env.SES_REGION },
		// Only while the site is hosted on GitHub Pages; "platform" hosting must survive redeploys.
		...(project.github_repo && project.frontend_hosting !== "platform" ? [{ type: "secret_text", name: "FRONTEND_ORIGIN", text: githubPagesOrigin(project.github_repo) }] : []),
	];
}

export async function deployWorker(ctx: PluginContext, env: ProviderEnv, id: string, version?: string): Promise<ProjectRow> {
	const project = await getProject(ctx, id);
	if (!project) throw new Error("unknown project");
	if (!project.d1_id || !project.kv_id) throw new Error("resources not created yet");
	const result = await deployService<{ version: string }>(ctx, env, "/api/v1/deploy", {
		accountId: env.CF_ACCOUNT_ID,
		apiToken: env.CF_API_TOKEN,
		script: id,
		version: version ?? "latest",
		bindings: projectBindings(env, project),
		cron: "* * * * *",
	});
	return updateProject(ctx, id, { status: "deployed", bundle_version: result.version, error: null });
}

export async function attachDomain(ctx: PluginContext, env: ProviderEnv, id: string): Promise<ProjectRow> {
	const project = await getProject(ctx, id);
	if (!project) throw new Error("unknown project");
	const zoneId = await cfZoneId(ctx, env);
	const res = await cfApi(ctx, env, "PUT", `/workers/domains`, { zone_id: zoneId, hostname: project.hostname, service: id, environment: "production" });
	if (!res.success && !JSON.stringify(res.errors).includes("already")) throw new Error(`domain attach failed: ${JSON.stringify(res.errors)}`);
	return updateProject(ctx, id, { status: "domain", error: null });
}

export async function setupCms(ctx: PluginContext, id: string): Promise<{ project: ProjectRow; retryable?: boolean; detail?: string }> {
	const project = await getProject(ctx, id);
	if (!project) throw new Error("unknown project");
	const env = await loadEnv(ctx);
	let res;
	try {
		res = await httpJson(ctx, `https://${project.hostname}/provision`, "POST", {
			email: project.admin_email,
			siteTitle: project.site_title,
			tagline: project.tagline ?? undefined,
			siteUrl: `https://${project.hostname}`,
			colorScheme: env.DEFAULT_COLOR_SCHEME?.trim() || "modern-minimal",
		}, { "x-provision-secret": project.provision_secret ?? "" });
	} catch (err) {
		return { project, retryable: true, detail: `fetch failed: ${String(err)}` };
	}
	if (res.status >= 500 || res.status === 404 || res.status === 421 || res.status === 522 || res.status === 530) return { project, retryable: true, detail: `child returned ${res.status}` };
	if (!res.ok) throw new Error(`child /provision returned ${res.status}: ${res.text.slice(0, 200)}`);
	const data = res.json<{ instance?: string }>();
	if (data.instance && data.instance !== `https://${project.hostname}`) return { project, retryable: true, detail: `wrong instance answered (${data.instance})` };
	try {
		const status = await http(ctx, `https://${project.hostname}/_emdash/api/setup/status`, { headers: { "X-EmDash-Request": "1" } });
		if (status.json<{ data?: { needsSetup?: boolean } }>().data?.needsSetup !== false) return { project, retryable: true, detail: "setup writes not yet visible — retrying" };
	} catch (err) {
		return { project, retryable: true, detail: `verification fetch failed: ${String(err)}` };
	}
	// Content-as-code: a platform-hosted site gets the theme's seed (pages designed
	// for the page builder, sections, menus) the way a GitHub Pages site gets it
	// from its deploy workflow. Re-runs are slug-matched upserts.
	if (project.provision_secret) {
		await deployService(ctx, env, "/api/v1/theme-seed", { template: templateRepoFor(env, project), cmsUrl: `https://${project.hostname}`, secret: project.provision_secret }).catch((err) => {
			console.warn(`[platform] theme seed skipped for ${project.id}: ${err instanceof Error ? err.message : String(err)}`);
		});
	}
	// Every project starts at zero credits; it gets the provider's price book + enforcement flag.
	try {
		await pushCreditsSettings(ctx, env, project);
	} catch (err) {
		console.warn(`[platform] credits settings skipped for ${project.id}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { project: await updateProject(ctx, id, { status: "live", error: null }) };
}

export async function destroyProject(ctx: PluginContext, env: ProviderEnv, id: string): Promise<{ removed: string[]; warnings: string[] }> {
	const project = await getProject(ctx, id);
	if (!project) throw new Error("unknown project");
	const removed: string[] = [];
	const warnings: string[] = [];
	const domainRows = await getDomains(ctx, id);

	const wd = await cfApi<Array<{ id: string; hostname: string; service: string }>>(ctx, env, "GET", `/workers/domains`);
	for (const d of wd.result ?? []) {
		if (d.service !== id) continue;
		const r = await cfApi(ctx, env, "DELETE", `/workers/domains/${d.id}`);
		if (r.success) removed.push(`domain ${d.hostname}`);
		else warnings.push(`domain ${d.hostname}: ${JSON.stringify(r.errors)}`);
	}
	try {
		const zoneId = await cfZoneId(ctx, env);
		const routes = await cfZone<Array<{ id: string; pattern: string; script?: string }>>(ctx, env, zoneId, "GET", `/workers/routes`);
		for (const r of routes.result ?? []) {
			if (r.script !== id) continue;
			await cfZone(ctx, env, zoneId, "DELETE", `/workers/routes/${r.id}`).catch(() => {});
			removed.push(`route ${r.pattern}`);
		}
		const site = domainRows.find((r) => r.kind === "site");
		if (site) {
			for (const host of [site.domain, `www.${site.domain}`]) {
				const list = await cfZone<Array<{ id: string }>>(ctx, env, zoneId, "GET", `/custom_hostnames?hostname=${host}`);
				for (const ch of list.result ?? []) {
					await cfZone(ctx, env, zoneId, "DELETE", `/custom_hostnames/${ch.id}`).catch(() => {});
					removed.push(`custom hostname ${host}`);
				}
			}
		}
	} catch (err) {
		warnings.push(`zone cleanup: ${err instanceof Error ? err.message : String(err)}`);
	}
	const email = domainRows.find((r) => r.kind === "email");
	if (email && !(email.domain === env.PLATFORM_ZONE || email.domain.endsWith(`.${env.PLATFORM_ZONE}`))) {
		await sesDeleteIdentity(ctx, env, email.domain);
		removed.push(`SES identity ${email.domain}`);
	}
	const ws = await cfApi(ctx, env, "DELETE", `/workers/scripts/${id}?force=true`);
	if (ws.success) removed.push("worker");
	else warnings.push(`worker: ${JSON.stringify(ws.errors)}`);

	// Bucket purge + delete runs in the trusted deploy service (unbounded object count).
	if (project.bucket) {
		try {
			const r = await deployService<{ purged: number; deleted: boolean }>(ctx, env, "/api/v1/destroy-bucket", { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, bucket: project.bucket });
			removed.push(`R2 bucket (${r.purged} objects purged)`);
		} catch (err) {
			warnings.push(`R2 bucket: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (project.kv_id) {
		const kv = await cfApi(ctx, env, "DELETE", `/storage/kv/namespaces/${project.kv_id}`);
		if (kv.success) removed.push("KV namespace");
		else warnings.push(`KV: ${JSON.stringify(kv.errors)}`);
	}
	if (project.d1_id) {
		const d1 = await cfApi(ctx, env, "DELETE", `/d1/database/${project.d1_id}`);
		if (d1.success) removed.push("D1 database");
		else warnings.push(`D1: ${JSON.stringify(d1.errors)}`);
	}
	await deleteProjectRows(ctx, id);
	removed.push("registry rows");
	return { removed, warnings };
}
