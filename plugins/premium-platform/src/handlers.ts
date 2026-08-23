/**
 * Routes.
 *
 * Admin (plugins:manage): projects/*, domains/*, registry/import, bundles
 * Public (machine-auth by provision secret): child/domain, child/github
 * Public (browser, via the golden /oauth/github/<step> stub): oauth/github/*
 */

import { applyDnsRecords, detectDnsHost, deleteChildSecret, type DnsApplyCreds, emailDomainStatus, patchChildSecrets, setEmailDomain, setSiteDomain, siteDomainStatus } from "./domains.js";
import { deployService, http, loadEnv, type ProviderEnv, siteUrl, randomToken } from "./env.js";
import { githubAuthorizeUrl, githubCompleteInstall, githubCompleteOAuth, githubConfigured, githubCreateRepo, githubDisconnect, githubPagesOrigin, githubSyncTheme, githubThemeDrift, githubRebuild, frontendTemplateRepo, peekState, templateRepoFor } from "./github.js";
import { attachDomain, createProject, deployWorker, destroyProject, setupCms } from "./provisioner.js";
import { type DomainRow, domains, getDomains, getProject, listProjects, type ProjectRow, projects, updateProject } from "./registry.js";
import { applyBillingEvent, childBalance, confirmCheckout, createCheckout, CREDIT_PACKS_CENTS, grantCredits, paymentProvider, priceBook, pushCreditsSettings, syncExternalUsage } from "./credits.js";
import type { PluginContext, RouteContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";

const publicProject = (p: ProjectRow) => ({
	id: p.id,
	hostname: p.hostname,
	admin_email: p.admin_email,
	site_title: p.site_title,
	tagline: p.tagline,
	status: p.status,
	error: p.error,
	bundle_version: p.bundle_version,
	github_login: p.github_login,
	github_repo: p.github_repo,
	created_at: p.created_at,
	updated_at: p.updated_at,
});

/* ---- admin: projects --------------------------------------------------- */

export async function projectsList(ctx: RouteContext) {
	return { projects: (await listProjects(ctx)).map(publicProject) };
}

async function withError<T>(ctx: RouteContext, id: string | undefined, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (id) await projects(ctx).get(id.toLowerCase()).then((p) => p && projects(ctx).put(p.id, { ...p, status: "error", error: message, updated_at: new Date().toISOString() })).catch(() => {});
		throw PluginRouteError.badRequest(message);
	}
}

export async function projectCreate(ctx: RouteContext<{ id: string; adminEmail: string; siteTitle: string; tagline?: string }>) {
	const env = await loadEnv(ctx);
	return withError(ctx, ctx.input.id, async () => ({ project: publicProject(await createProject(ctx, env, ctx.input)) }));
}

export async function projectDeploy(ctx: RouteContext<{ id: string; version?: string }>) {
	const env = await loadEnv(ctx);
	return withError(ctx, ctx.input.id, async () => ({ project: publicProject(await deployWorker(ctx, env, ctx.input.id, ctx.input.version)) }));
}

export async function projectDomain(ctx: RouteContext<{ id: string }>) {
	const env = await loadEnv(ctx);
	return withError(ctx, ctx.input.id, async () => ({ project: publicProject(await attachDomain(ctx, env, ctx.input.id)) }));
}

export async function projectSetup(ctx: RouteContext<{ id: string }>) {
	return withError(ctx, ctx.input.id, async () => {
		const r = await setupCms(ctx, ctx.input.id);
		return { project: publicProject(r.project), retryable: r.retryable ?? false, detail: r.detail };
	});
}

export async function projectDestroy(ctx: RouteContext<{ id: string }>) {
	const env = await loadEnv(ctx);
	return withError(ctx, undefined, () => destroyProject(ctx, env, ctx.input.id.toLowerCase()));
}

export async function projectDomains(ctx: RouteContext<{ id: string }>) {
	const env = await loadEnv(ctx);
	await siteDomainStatus(ctx, env, ctx.input.id).catch(() => {});
	await emailDomainStatus(ctx, env, ctx.input.id).catch(() => {});
	return { domains: await getDomains(ctx, ctx.input.id) };
}

export async function projectSiteDomain(ctx: RouteContext<{ id: string; domain: string }>) {
	const env = await loadEnv(ctx);
	return withError(ctx, undefined, () => setSiteDomain(ctx, env, ctx.input.id, ctx.input.domain));
}

export async function projectEmailDomain(ctx: RouteContext<{ id: string; domain: string }>) {
	const env = await loadEnv(ctx);
	return withError(ctx, undefined, () => setEmailDomain(ctx, env, ctx.input.id, ctx.input.domain));
}

export async function bundlesList(ctx: RouteContext) {
	const env = await loadEnv(ctx);
	return deployService(ctx, env, "/api/v1/bundles", undefined, "GET");
}

/** One-time import of the legacy D1 registry (platform_projects / platform_domains rows). */
export async function registryImport(ctx: RouteContext<{ projects?: ProjectRow[]; domains?: DomainRow[] }>) {
	let n = 0;
	for (const p of ctx.input.projects ?? []) {
		if (!p.id) continue;
		await projects(ctx).put(p.id, { ...p, tagline: p.tagline ?? null, error: p.error ?? null });
		n++;
	}
	let m = 0;
	for (const d of ctx.input.domains ?? []) {
		if (!d.project_id || !d.kind) continue;
		await domains(ctx).put(`${d.project_id}:${d.kind}`, { ...d, records: d.records ?? "[]", external_id: d.external_id ?? null, error: d.error ?? null });
		m++;
	}
	return { projects: n, domains: m };
}

/* ---- child machine-auth --------------------------------------------------- */

async function authChild(ctx: RouteContext, id: string | undefined, secret: string | undefined): Promise<ProjectRow> {
	if (!id || !secret) throw PluginRouteError.badRequest("id and secret required");
	const project = await getProject(ctx, id);
	if (!project?.provision_secret || project.provision_secret !== secret) throw PluginRouteError.forbidden("unauthorized");
	return project;
}

export async function childGithub(ctx: RouteContext<{ id?: string; secret?: string; op?: string; repoName?: string; private?: boolean; drift?: boolean; hosting?: string; themeId?: string }>) {
	const env = await loadEnv(ctx);
	const project = await authChild(ctx, ctx.input.id, ctx.input.secret);
	const hostingOf = (p: ProjectRow) => p.frontend_hosting ?? (p.github_repo ? "github" : "platform");
	const statusOf = async (p: ProjectRow, withDrift: boolean) => ({
		available: githubConfigured(env),
		connected: Boolean(p.github_login),
		login: p.github_login,
		repo: p.github_repo,
		repoUrl: p.github_repo ? `https://github.com/${p.github_repo}` : null,
		pagesUrl: p.github_repo ? `${githubPagesOrigin(p.github_repo)}/` : null,
		mode: p.github_mode ?? (p.github_repo ? "template" : null),
		hosting: hostingOf(p),
		theme: { id: p.theme_id ?? "premiumcms", repo: templateRepoFor(env, p), url: `https://github.com/${templateRepoFor(env, p)}` },
		syncedAt: p.github_synced_at ?? null,
		drift: withDrift ? await githubThemeDrift(ctx, env, p).catch(() => null) : undefined,
	});
	switch (ctx.input.op ?? "status") {
		case "status":
			return statusOf(project, ctx.input.drift === true);
		case "create-repo": {
			const r = await githubCreateRepo(ctx, env, project.id, ctx.input.repoName?.trim() || `${project.id}-frontend`, ctx.input.private === true);
			await patchChildSecrets(ctx, env, project.id, [{ name: "FRONTEND_ORIGIN", text: r.origin }]);
			return r;
		}
		case "drift":
			return { drift: await githubThemeDrift(ctx, env, project) };
		case "rebuild":
			return githubRebuild(ctx, env, project);
		case "sync": {
			const r = await githubSyncTheme(ctx, env, project);
			const fresh = (await getProject(ctx, project.id)) ?? project;
			return { ...r, drift: await githubThemeDrift(ctx, env, fresh).catch(() => null) };
		}
		case "hosting": {
			const hosting = ctx.input.hosting === "github" ? "github" : "platform";
			if (hosting === "github") {
				if (!project.github_repo) throw PluginRouteError.badRequest("Set up the GitHub repository first.");
				await patchChildSecrets(ctx, env, project.id, [{ name: "FRONTEND_ORIGIN", text: githubPagesOrigin(project.github_repo) }]);
			} else {
				await deleteChildSecret(ctx, env, project.id, "FRONTEND_ORIGIN");
			}
			const updated = await updateProject(ctx, project.id, { frontend_hosting: hosting });
			return statusOf(updated, false);
		}
		case "apply-theme": {
			const themeId = String(ctx.input.themeId ?? "").trim();
			if (!themeId) throw PluginRouteError.badRequest("themeId required");
			const theme = await marketplaceTheme(ctx, env, themeId);
			const repo = theme?.premiumcms?.templateRepo?.trim();
			if (!repo) throw PluginRouteError.badRequest("This theme has no PremiumCMS template repository, so it cannot be applied here.");
			if (!project.provision_secret) throw PluginRouteError.badRequest("project has no provision secret");
			let updated = await updateProject(ctx, project.id, { theme_id: themeId, theme_repo: repo, github_theme_sha: null });
			const seed = await deployService<{ applied: boolean; entries: number; sections: number; status: number; detail?: string }>(ctx, env, "/api/v1/theme-seed", { template: repo, cmsUrl: `https://${project.hostname}`, secret: project.provision_secret });
			let sync: { merged: boolean; conflict: boolean; message: string } | null = null;
			if (hostingOf(updated) === "github" && updated.github_repo) {
				sync = await githubSyncTheme(ctx, env, updated).catch((err: unknown) => ({ merged: false, conflict: false, message: `theme push failed: ${err instanceof Error ? err.message : String(err)}` }));
				updated = (await getProject(ctx, project.id)) ?? updated;
			}
			return { ...(await statusOf(updated, false)), seed, sync };
		}
		case "disconnect":
			await deleteChildSecret(ctx, env, project.id, "FRONTEND_ORIGIN");
			await githubDisconnect(ctx, project.id);
			return { ok: true };
		default:
			throw PluginRouteError.badRequest("unknown op");
	}
}

/** A theme from our marketplace catalogue (deploy service), or null when unknown. */
async function marketplaceTheme(ctx: PluginContext, env: ProviderEnv, id: string): Promise<{ id: string; premiumcms?: { templateRepo?: string; plugins?: string[]; colorScheme?: string } | null } | null> {
	const res = await http(ctx, `${env.DEPLOY_SERVICE_URL}/api/v1/themes/${encodeURIComponent(id)}`, { method: "GET" });
	if (!res.ok) return null;
	return res.json<{ id: string; premiumcms?: { templateRepo?: string } | null }>();
}

/** Provider action: (re)apply the theme's content seed to a project (pages designed for the page builder, sections, menus). */
export async function projectSeed(ctx: RouteContext<{ id?: string }>) {
	const env = await loadEnv(ctx);
	const project = await getProject(ctx, ctx.input.id ?? "");
	if (!project) throw PluginRouteError.badRequest("unknown project");
	if (!project.provision_secret) throw PluginRouteError.badRequest("project has no provision secret");
	const r = await deployService<{ applied: boolean; entries: number; sections: number; status: number; detail?: string }>(ctx, env, "/api/v1/theme-seed", { template: templateRepoFor(env, project), cmsUrl: `https://${project.hostname}`, secret: project.provision_secret });
	return { project: project.id, ...r };
}

/** Child-side credits: purchases through Stripe and just-in-time hosting usage, both owned by the parent. */
export async function childCredits(ctx: RouteContext<{ id?: string; secret?: string; op?: string; amountCents?: number; sessionId?: string; origin?: string; days?: number }>) {
	const env = await loadEnv(ctx);
	const project = await authChild(ctx, ctx.input.id, ctx.input.secret);
	switch (ctx.input.op ?? "status") {
		case "status":
			return { available: true, provider: paymentProvider(env), stripe: paymentProvider(env) !== "none", packsCents: CREDIT_PACKS_CENTS, markup: priceBook(env).markup, enforce: env.CREDITS_ENFORCE === "true" };
		case "checkout": {
			const origin = typeof ctx.input.origin === "string" && /^https:\/\//.test(ctx.input.origin) ? ctx.input.origin : `https://${project.hostname}`;
			return createCheckout(ctx, env, project, Number(ctx.input.amountCents), origin);
		}
		case "confirm":
			return confirmCheckout(ctx, env, project, String(ctx.input.sessionId ?? ""));
		case "refresh":
			return syncExternalUsage(ctx, env, project, Math.min(90, Math.max(1, Number(ctx.input.days) || 30)));
		default:
			throw PluginRouteError.badRequest("unknown op");
	}
}

/** Provider actions on a project's credits: balance, manual grants, push price settings, sync usage. */
export async function projectCredits(ctx: RouteContext<{ id?: string; op?: string; cents?: number; note?: string; days?: number }>) {
	const env = await loadEnv(ctx);
	const project = await getProject(ctx, ctx.input.id ?? "");
	if (!project?.d1_id) throw PluginRouteError.badRequest("unknown project or no database");
	switch (ctx.input.op ?? "status") {
		case "status":
			return { project: project.id, ...(await childBalance(ctx, env, project.d1_id)), book: priceBook(env), enforce: env.CREDITS_ENFORCE === "true" };
		case "grant": {
			const cents = Number(ctx.input.cents);
			if (!Number.isFinite(cents) || cents === 0) throw PluginRouteError.badRequest("cents required");
			const ok = await grantCredits(ctx, env, project, cents * 10_000, `manual:${randomToken(8)}`, ctx.input.note ?? "Granted by provider");
			return { project: project.id, granted: ok, cents, ...(await childBalance(ctx, env, project.d1_id)) };
		}
		case "push-settings":
			await pushCreditsSettings(ctx, env, project);
			return { project: project.id, pushed: true, book: priceBook(env), enforce: env.CREDITS_ENFORCE === "true" };
		case "sync":
			return { project: project.id, ...(await syncExternalUsage(ctx, env, project, Math.min(90, Math.max(1, Number(ctx.input.days) || 30)))) };
		default:
			throw PluginRouteError.badRequest("unknown op");
	}
}

/** Verified provider webhook events, forwarded by this instance's /billing-webhook/<provider> route with the deploy key. */
export async function billingEvent(ctx: RouteContext<{ key?: string; provider?: string; sessionId?: string; project?: string; creditsCents?: number; paid?: boolean; eventId?: string }>) {
	const env = await loadEnv(ctx);
	if (!env.DEPLOY_KEY || ctx.input.key !== env.DEPLOY_KEY) throw PluginRouteError.forbidden("unauthorized");
	return applyBillingEvent(ctx, env, { provider: String(ctx.input.provider ?? ""), sessionId: String(ctx.input.sessionId ?? ""), project: String(ctx.input.project ?? ""), creditsCents: Number(ctx.input.creditsCents ?? 0), paid: ctx.input.paid === true, eventId: ctx.input.eventId });
}

export async function childDomain(ctx: RouteContext<{ id?: string; secret?: string; op?: string; siteDomain?: string; emailDomain?: string; creds?: DnsApplyCreds }>) {
	const env = await loadEnv(ctx);
	const project = await authChild(ctx, ctx.input.id, ctx.input.secret);
	if (ctx.input.op === "dns-apply") {
		const creds = ctx.input.creds;
		if (!creds?.provider || !creds.apiKey) throw PluginRouteError.badRequest("provider and apiKey required");
		const result = await applyDnsRecords(ctx, env, project.id, creds);
		return { ...result, domains: await getDomains(ctx, project.id) };
	}
	const errors: Record<string, string> = {};
	const existing = await getDomains(ctx, project.id);
	const siteRow = existing.find((d) => d.kind === "site");
	const siteSettled = siteRow?.status === "active" || siteRow?.external_id?.startsWith("ch:");
	if (ctx.input.siteDomain && !(siteRow?.domain === ctx.input.siteDomain && siteSettled)) {
		await setSiteDomain(ctx, env, project.id, ctx.input.siteDomain).catch((err) => {
			errors.site = err instanceof Error ? err.message : String(err);
		});
	}
	const emailRow = existing.find((d) => d.kind === "email");
	const emailSettled = emailRow?.status === "active" || emailRow?.status?.startsWith("unavailable");
	if (ctx.input.emailDomain && !(emailRow?.domain === ctx.input.emailDomain && emailSettled) && !emailSettled) {
		await setEmailDomain(ctx, env, project.id, ctx.input.emailDomain).catch((err) => {
			errors.email = err instanceof Error ? err.message : String(err);
		});
	}
	await siteDomainStatus(ctx, env, project.id).catch(() => {});
	await emailDomainStatus(ctx, env, project.id).catch(() => {});
	const dnsHost = ctx.input.siteDomain ? await detectDnsHost(ctx, ctx.input.siteDomain).catch(() => null) : null;
	return { domains: await getDomains(ctx, project.id), platformAccountId: env.CF_ACCOUNT_ID, dnsHost, errors: Object.keys(errors).length ? errors : undefined };
}

/* ---- GitHub OAuth / App install (browser) ---------------------------------- */

type Redirect = { redirect: string } | { message: string };

export async function oauthGithubStart(ctx: RouteContext<{ project?: string; secret?: string; return?: string }>): Promise<Redirect> {
	const env = await loadEnv(ctx);
	if (!githubConfigured(env)) throw PluginRouteError.badRequest("GitHub is not configured on this provider — add the GitHub App (or OAuth app) under Plugins → Platform → Settings.");
	const project = await authChild(ctx, ctx.input.project, ctx.input.secret);
	return { redirect: await githubAuthorizeUrl(env, siteUrl(ctx), project, ctx.input.return ?? "/") };
}

export async function oauthGithubSetup(ctx: RouteContext<{ installation_id?: string; state?: string }>): Promise<Redirect> {
	const env = await loadEnv(ctx);
	const installationId = ctx.input.installation_id ?? "";
	const state = ctx.input.state ?? "";
	if (installationId && !state) return { message: "GitHub App installed. To link it to a site, open that site's admin → Settings → General and click “Connect GitHub” — the installation will be picked up automatically." };
	if (!installationId || !state) throw PluginRouteError.badRequest("missing installation_id or state");
	const peeked = peekState(state);
	const self = siteUrl(ctx);
	if (peeked.origin && peeked.origin !== self) {
		const forward = new URL(`${peeked.origin}/oauth/github/setup`);
		forward.searchParams.set("installation_id", installationId);
		forward.searchParams.set("state", state);
		return { redirect: forward.toString() };
	}
	const { returnTo, login } = await githubCompleteInstall(ctx, env, installationId, state);
	const back = new URL(returnTo);
	back.searchParams.set("github", `connected:${login}`);
	return { redirect: back.toString() };
}

export async function oauthGithubCallback(ctx: RouteContext<{ code?: string; state?: string }>): Promise<Redirect> {
	const env = await loadEnv(ctx);
	const { returnTo, login } = await githubCompleteOAuth(ctx, env, siteUrl(ctx), ctx.input.code ?? "", ctx.input.state ?? "");
	const back = new URL(returnTo);
	back.searchParams.set("github", `connected:${login}`);
	return { redirect: back.toString() };
}

export { deleteChildSecret };

/* ---- fleet sync (CI) ------------------------------------------------------ */

/**
 * Apply a platform-wide change to every live project, a batch at a time so a
 * single call stays inside the sandbox wall time. CI loops until remaining = 0.
 *   op "deploy"  → redeploy on the latest published bundle;  op "setup" → run setup (migrations, seed)
 *   op "bundle"  → both in one call (small fleets only; each step can take a minute)
 *   op "plugins" → update installed marketplace plugins on each project (+ install)
 *   op "themes"  → re-apply the theme seed (projects on the given theme ids, or all with a theme)
 * Auth: the DEPLOY_KEY plugin setting (same as billing/event).
 */
export async function fleetSync(ctx: RouteContext<{ key?: string; op?: string; projects?: string[]; themes?: string[]; install?: string[]; limit?: number; after?: string }>) {
	const env = await loadEnv(ctx);
	if (!env.DEPLOY_KEY || ctx.input.key !== env.DEPLOY_KEY) throw PluginRouteError.forbidden("unauthorized");
	const op = ctx.input.op ?? "bundle";
	// Deploy+setup and theme seeding take up to a minute each; keep a call inside the 120 s sandbox wall time.
	const limit = Math.min(op === "plugins" ? 10 : 2, Math.max(1, ctx.input.limit ?? (op === "plugins" ? 3 : 1)));
	// Between the deploy and setup passes a project sits in "deployed"; both are fleet-eligible.
	const ELIGIBLE = new Set(["live", "deployed", "domain"]);
	const all = (await listProjects(ctx)).filter((p) => ELIGIBLE.has(p.status) && p.provision_secret).sort((a, b) => a.id.localeCompare(b.id));
	const wanted = all.filter((p) => (!ctx.input.projects?.length || ctx.input.projects.includes(p.id)) && (op !== "themes" || (ctx.input.themes?.length ? ctx.input.themes.includes(p.theme_id ?? "") : Boolean(p.theme_id))));
	const pending = ctx.input.after ? wanted.filter((p) => p.id > ctx.input.after!) : wanted;
	const batch = pending.slice(0, limit);
	const done: Array<{ id: string; result: unknown }> = [];
	const failed: Array<{ id: string; error: string }> = [];
	for (const p of batch) {
		try {
			if (op === "deploy") {
				const r = await deployWorker(ctx, env, p.id);
				done.push({ id: p.id, result: { status: r.status, bundle: r.bundle_version } });
			} else if (op === "setup") {
				const r = await setupCms(ctx, p.id);
				done.push({ id: p.id, result: { status: r.project.status, bundle: r.project.bundle_version } });
			} else if (op === "bundle") {
				await deployWorker(ctx, env, p.id);
				const r = await setupCms(ctx, p.id);
				done.push({ id: p.id, result: { status: r.project.status, bundle: r.project.bundle_version } });
			} else if (op === "plugins") {
				const res = await http(ctx, `https://${p.hostname}/platform/plugins-sync`, { method: "POST", headers: { "x-provision-secret": p.provision_secret!, "Content-Type": "application/json" }, body: JSON.stringify({ install: ctx.input.install ?? [] }) });
				const parsed = JSON.parse(res.text || "{}") as { error?: string };
				if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
				done.push({ id: p.id, result: parsed });
			} else if (op === "themes") {
				const r = await deployService<{ applied: boolean; entries: number; status: number; detail?: string }>(ctx, env, "/api/v1/theme-seed", { template: templateRepoFor(env, p), cmsUrl: `https://${p.hostname}`, secret: p.provision_secret });
				if (!r.applied) throw new Error(r.detail ?? `theme-seed ${r.status}`);
				done.push({ id: p.id, result: { entries: r.entries } });
			} else throw new Error(`unknown op ${op}`);
		} catch (err) {
			failed.push({ id: p.id, error: err instanceof Error ? err.message : String(err) });
		}
	}
	const last = batch[batch.length - 1]?.id ?? ctx.input.after ?? null;
	return { op, done, failed, remaining: Math.max(0, pending.length - batch.length), after: last, total: wanted.length };
}

/* ---- demo projects (themes repo) ------------------------------------------ */

interface DemoSpec { theme: string; project: string; siteTitle?: string; tagline?: string; adminEmail?: string }

/**
 * Reconcile the platform's demo projects with the themes repo's demos.json:
 * create missing ones (and walk them to live), bind/refresh their theme,
 * plugins and colour scheme, and destroy demos that were removed. One step
 * per project per call; CI loops until `remaining` is 0. Only projects marked
 * `demo_of` are ever deleted.
 */
export async function fleetDemos(ctx: RouteContext<{ key?: string; demos?: DemoSpec[]; limit?: number }>) {
	const env = await loadEnv(ctx);
	if (!env.DEPLOY_KEY || ctx.input.key !== env.DEPLOY_KEY) throw PluginRouteError.forbidden("unauthorized");
	const demos = (ctx.input.demos ?? []).filter((d) => d && /^[a-z0-9][a-z0-9-]{1,40}$/.test(d.project ?? "") && d.theme);
	const limit = Math.min(3, Math.max(1, ctx.input.limit ?? 1));
	const all = await listProjects(ctx);
	const byId = new Map(all.map((p) => [p.id, p]));
	const desired = new Map(demos.map((d) => [d.project, d]));
	const actions: Array<{ id: string; step: string }> = [];
	const done: Array<{ id: string; step: string; result?: unknown }> = [];
	const failed: Array<{ id: string; step: string; error: string }> = [];
	// 1. demos that disappeared from the repo
	for (const p of all) if (p.demo_of && !desired.has(p.id)) actions.push({ id: p.id, step: "destroy" });
	// 2. desired demos: next step by state
	for (const d of demos) {
		const p = byId.get(d.project);
		if (!p) actions.push({ id: d.project, step: "create" });
		else if (p.status === "resources") actions.push({ id: p.id, step: "deploy" });
		else if (p.status === "deployed") actions.push({ id: p.id, step: "domain" });
		else if (p.status === "domain") actions.push({ id: p.id, step: "setup" });
		else if (p.status === "live" && (p.demo_of !== d.theme || p.theme_id !== d.theme)) actions.push({ id: p.id, step: "bind-theme" });
		else if (p.status === "live" && p.demo_of === d.theme && !(p as { demo_synced_at?: string | null }).demo_synced_at) actions.push({ id: p.id, step: "configure" });
		else if (p.status === "error") failed.push({ id: p.id, step: "state", error: p.error ?? "project is in error" });
	}
	for (const a of actions.slice(0, limit)) {
		const d = desired.get(a.id);
		try {
			if (a.step === "destroy") {
				const r = await destroyProject(ctx, env, a.id);
				done.push({ id: a.id, step: a.step, result: r });
			} else if (a.step === "create") {
				const adminEmail = d!.adminEmail || env.DEMO_ADMIN_EMAIL;
				if (!adminEmail) throw new Error("no admin email: set DEMO_ADMIN_EMAIL in the platform plugin settings or adminEmail in demos.json");
				await createProject(ctx, env, { id: a.id, adminEmail, siteTitle: d!.siteTitle || a.id, tagline: d!.tagline });
				await updateProject(ctx, a.id, { demo_of: d!.theme });
				done.push({ id: a.id, step: a.step });
			} else if (a.step === "deploy") {
				await deployWorker(ctx, env, a.id);
				done.push({ id: a.id, step: a.step });
			} else if (a.step === "domain") {
				await attachDomain(ctx, env, a.id);
				done.push({ id: a.id, step: a.step });
			} else if (a.step === "setup") {
				const r = await setupCms(ctx, a.id);
				done.push({ id: a.id, step: a.step, result: { status: r.project.status } });
			} else if (a.step === "bind-theme") {
				const theme = await marketplaceTheme(ctx, env, d!.theme);
				const repo = theme?.premiumcms?.templateRepo?.trim();
				if (!repo) throw new Error(`theme ${d!.theme} is not in the marketplace (or has no templateRepo)`);
				await updateProject(ctx, a.id, { demo_of: d!.theme, theme_id: d!.theme, theme_repo: repo, github_theme_sha: null, demo_synced_at: null } as Partial<ProjectRow>);
				done.push({ id: a.id, step: a.step });
			} else if (a.step === "configure") {
				const p = byId.get(a.id)!;
				const theme = await marketplaceTheme(ctx, env, d!.theme);
				// plugins + colour scheme on the child, then the theme seed (which also carries plugin settings)
				const res = await http(ctx, `https://${p.hostname}/platform/plugins-sync`, { method: "POST", headers: { "x-provision-secret": p.provision_secret!, "Content-Type": "application/json" }, body: JSON.stringify({ install: theme?.premiumcms?.plugins ?? [], colorScheme: theme?.premiumcms?.colorScheme ?? null }) });
				if (!res.ok) throw new Error(`plugins-sync: ${(JSON.parse(res.text || "{}") as { error?: string }).error ?? res.status}`);
				const seed = await deployService<{ applied: boolean; entries: number; status: number; detail?: string }>(ctx, env, "/api/v1/theme-seed", { template: templateRepoFor(env, p), cmsUrl: `https://${p.hostname}`, secret: p.provision_secret });
				if (!seed.applied) throw new Error(seed.detail ?? `theme-seed ${seed.status}`);
				await updateProject(ctx, a.id, { demo_synced_at: new Date().toISOString() } as Partial<ProjectRow>);
				done.push({ id: a.id, step: a.step, result: { entries: seed.entries, plugins: JSON.parse(res.text || "{}") } });
			}
		} catch (err) {
			failed.push({ id: a.id, step: a.step, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { done, failed, remaining: Math.max(0, actions.length - limit) + (actions.length ? 0 : 0), planned: actions.map((a) => `${a.id}:${a.step}`) };
}
