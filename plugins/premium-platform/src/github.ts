/**
 * GitHub integration (App installations preferred, OAuth fallback) and
 * frontend repo generation — ported to the sandbox bridge.
 */

import type { ProviderEnv } from "./env.js";
import { deployService, http, httpJson, randomToken } from "./env.js";
import { getProject, type ProjectRow, updateProject } from "./registry.js";
import type { PluginContext } from "./shim.js";

const GH = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "premiumcms-platform/1.0", "X-GitHub-Api-Version": "2022-11-28" };
}

export function githubAppConfigured(env: ProviderEnv): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY);
}

export function githubConfigured(env: ProviderEnv): boolean {
	return githubAppConfigured(env) || Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function b64urlBytes(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64url = (s: string) => b64urlBytes(new TextEncoder().encode(s));

function derLen(n: number): number[] {
	if (n < 0x80) return [n];
	if (n < 0x100) return [0x81, n];
	return [0x82, n >> 8, n & 0xff];
}

async function importAppKey(pem: string): Promise<CryptoKey> {
	const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
	const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	if (isPkcs1) {
		const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
		const octet = [0x04, ...derLen(der.length)];
		const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
		der = Uint8Array.from([0x30, ...derLen(inner.length + der.length), ...inner, ...der]);
	}
	return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function githubAppJwt(env: ProviderEnv): Promise<string> {
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("GitHub App is not configured");
	const key = await importAppKey(env.GITHUB_APP_PRIVATE_KEY);
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
	return `${header}.${payload}.${b64urlBytes(new Uint8Array(sig))}`;
}

export async function githubInstallationToken(ctx: PluginContext, env: ProviderEnv, installationId: string): Promise<string> {
	const jwt = await githubAppJwt(env);
	const res = await http(ctx, `${GH}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: ghHeaders(jwt) });
	const data = res.json<{ token?: string; message?: string }>();
	if (!data.token) throw new Error(`GitHub App: installation token failed (${res.status}): ${data.message ?? "unknown"} — the app may have been uninstalled; reconnect from Settings → General.`);
	return data.token;
}

export async function githubTokenForProject(ctx: PluginContext, env: ProviderEnv, project: ProjectRow): Promise<string> {
	if (project.github_installation_id && githubAppConfigured(env)) return githubInstallationToken(ctx, env, project.github_installation_id);
	if (project.github_token) return project.github_token;
	throw new Error("GitHub is not connected for this project");
}

async function signState(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return b64urlBytes(new Uint8Array(sig));
}

export async function githubAuthorizeUrl(env: ProviderEnv, selfOrigin: string, project: ProjectRow, returnTo: string): Promise<string> {
	const payload = `${project.id}|${returnTo}|${selfOrigin}|${randomToken(12)}`;
	const sig = await signState(project.provision_secret ?? "", payload);
	const state = btoa(payload).replace(/=+$/, "") + "." + sig;
	if (githubAppConfigured(env)) return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
	const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${selfOrigin}/oauth/github/callback`, scope: "repo workflow", state });
	return `https://github.com/login/oauth/authorize?${params}`;
}

export function peekState(state: string): { projectId?: string; returnTo?: string; origin?: string } {
	try {
		const payload = atob((state.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/"));
		const [projectId, returnTo, origin] = payload.split("|");
		return { projectId, returnTo, origin };
	} catch {
		return {};
	}
}

async function verifyState(ctx: PluginContext, state: string): Promise<{ project: ProjectRow; returnTo: string }> {
	const [b64, sig] = state.split(".");
	if (!b64 || !sig) throw new Error("bad state");
	const payload = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
	const [projectId, returnTo] = payload.split("|");
	const project = await getProject(ctx, projectId ?? "");
	if (!project) throw new Error("unknown project in state");
	if ((await signState(project.provision_secret ?? "", payload)) !== sig) throw new Error("state signature mismatch");
	return { project, returnTo: returnTo ?? "/" };
}

export async function githubCompleteInstall(ctx: PluginContext, env: ProviderEnv, installationId: string, state: string) {
	const { project, returnTo } = await verifyState(ctx, state);
	const jwt = await githubAppJwt(env);
	const res = await http(ctx, `${GH}/app/installations/${installationId}`, { headers: ghHeaders(jwt) });
	const installation = res.json<{ account?: { login?: string }; message?: string }>();
	if (!res.ok || !installation.account?.login) throw new Error(`GitHub App: installation ${installationId} not found (${installation.message ?? res.status})`);
	await updateProject(ctx, project.id, { github_installation_id: installationId, github_login: installation.account.login, github_token: null });
	return { projectId: project.id, returnTo, login: installation.account.login };
}

export async function githubCompleteOAuth(ctx: PluginContext, env: ProviderEnv, selfOrigin: string, code: string, state: string) {
	const { project, returnTo } = await verifyState(ctx, state);
	const res = await httpJson(ctx, "https://github.com/login/oauth/access_token", "POST", { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${selfOrigin}/oauth/github/callback` }, { Accept: "application/json", "User-Agent": "premiumcms-platform/1.0" });
	const data = res.json<{ access_token?: string; error_description?: string; error?: string }>();
	if (!data.access_token) throw new Error(`GitHub: ${data.error_description ?? data.error ?? "token exchange failed"}`);
	const me = await http(ctx, `${GH}/user`, { headers: ghHeaders(data.access_token) });
	const user = me.json<{ login?: string }>();
	await updateProject(ctx, project.id, { github_token: data.access_token, github_login: user.login ?? null });
	return { projectId: project.id, returnTo, login: user.login ?? "" };
}

export async function githubDisconnect(ctx: PluginContext, projectId: string): Promise<void> {
	await updateProject(ctx, projectId, { github_token: null, github_installation_id: null, github_login: null, github_repo: null, github_mode: null, frontend_hosting: "platform" });
}

const DEFAULT_FRONTEND_TEMPLATE = "MahmoodKhalil57/premium-cms-frontend-template";

export function frontendTemplateRepo(env: ProviderEnv): string {
	return env.GITHUB_TEMPLATE_REPO?.trim() || DEFAULT_FRONTEND_TEMPLATE;
}

/** The template repository behind a project's frontend: its chosen marketplace theme, else the platform default. */
export function templateRepoFor(env: ProviderEnv, project: { theme_repo?: string | null }): string {
	return project.theme_repo?.trim() || frontendTemplateRepo(env);
}

function projectConfigTs(project: ProjectRow): string {
	return `/**
 * Site configuration — written by the platform when this repository was
 * created. Edit if your CMS URL or site identity changes.
 *
 * CMS_URL is only used when the frontend is viewed OFF your site's domain
 * (github.io, local dev). On your own domain the platform serves this
 * frontend and the CMS from the same origin, so requests need no base URL.
 */
export const CMS_URL = ${JSON.stringify(`https://${project.hostname}`)};
export const SITE_TITLE = ${JSON.stringify(project.site_title)};
export const TAGLINE = ${JSON.stringify(project.tagline ?? "")};
`;
}

/** GitHub wants a libsodium sealed box; the deploy service seals it (keeps nacl out of the sandbox bundle). */
async function ghSetActionsSecret(ctx: PluginContext, env: ProviderEnv, token: string, repo: string, name: string, value: string): Promise<void> {
	const keyRes = await http(ctx, `${GH}/repos/${repo}/actions/secrets/public-key`, { headers: ghHeaders(token) });
	if (!keyRes.ok) throw new Error(`GitHub: secrets public key failed (${keyRes.status})`);
	const key = keyRes.json<{ key_id: string; key: string }>();
	const sealed = await deployService<{ encrypted: string }>(ctx, env, "/api/v1/seal", { publicKey: key.key, value });
	const res = await httpJson(ctx, `${GH}/repos/${repo}/actions/secrets/${name}`, "PUT", { encrypted_value: sealed.encrypted, key_id: key.key_id }, ghHeaders(token));
	if (!res.ok) throw new Error(`GitHub: setting secret ${name} failed (${res.status})`);
}

async function ghPutFile(ctx: PluginContext, token: string, repo: string, path: string, content: string, message: string): Promise<void> {
	const existing = await http(ctx, `${GH}/repos/${repo}/contents/${path}`, { headers: ghHeaders(token) });
	const sha = existing.ok ? existing.json<{ sha?: string }>().sha : undefined;
	const res = await httpJson(ctx, `${GH}/repos/${repo}/contents/${path}`, "PUT", { message, content: btoa(unescape(encodeURIComponent(content))), ...(sha ? { sha } : {}) }, ghHeaders(token));
	if (!res.ok) throw new Error(`GitHub: writing ${path} failed (${res.status}) ${res.text.slice(0, 200)}`);
}

export function githubPagesOrigin(repoFullName: string): string {
	const [owner, name] = repoFullName.split("/");
	return `https://${(owner ?? "").toLowerCase()}.github.io/${name ?? ""}`;
}

/**
 * Create the site's frontend repository from the official theme.
 *
 * Forks first: a fork shares history with the theme, so GitHub can count how
 * far the site has drifted (compare) and merge theme updates without a
 * rebuild (merge-upstream). Falls back to "generate from template" when the
 * account already holds a fork of the theme (GitHub allows one per owner) or
 * the installation may not fork — those repos work the same, minus drift/sync.
 */
export async function githubCreateRepo(ctx: PluginContext, env: ProviderEnv, projectId: string, repoName: string, isPrivate: boolean) {
	const project = await getProject(ctx, projectId);
	if (!project) throw new Error("unknown project");
	const token = await githubTokenForProject(ctx, env, project);
	const name = repoName.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-") || `${project.id}-frontend`;
	const template = templateRepoFor(env, project);

	let fullName: string | undefined;
	let htmlUrl: string | undefined;
	let mode: "fork" | "template" = "fork";
	let note: string | null = null;

	const fork = await httpJson(ctx, `${GH}/repos/${template}/forks`, "POST", { name, default_branch_only: true }, ghHeaders(token));
	const forked = fork.json<{ full_name?: string; name?: string; html_url?: string; message?: string }>();
	if (fork.ok && forked.full_name && forked.name?.toLowerCase() === name) {
		fullName = forked.full_name;
		htmlUrl = forked.html_url;
	} else {
		if (fork.ok && forked.full_name) note = `Your GitHub account already has a fork of the theme (${forked.full_name}), so this repository was generated from the template instead; theme updates must be merged by hand for it.`;
		else note = `GitHub would not fork the theme (${forked.message ?? fork.status}), so this repository was generated from the template instead; theme updates must be merged by hand for it.`;
		mode = "template";
		const create = await httpJson(ctx, `${GH}/repos/${template}/generate`, "POST", { name, private: isPrivate, include_all_branches: false, description: `${project.site_title} — frontend (PremiumCMS)` }, ghHeaders(token));
		const created = create.json<{ full_name?: string; html_url?: string; message?: string; errors?: unknown }>();
		fullName = created.full_name;
		htmlUrl = created.html_url;
		if (!create.ok) {
			const detail = JSON.stringify(created.errors ?? created.message ?? "");
			if (create.status === 422 && detail.includes("already exists")) fullName = `${project.github_login}/${name}`;
			else if (create.status === 404) throw new Error(`GitHub: theme repository "${template}" not found or not accessible — check the GITHUB_TEMPLATE_REPO setting and that the repo is public and marked as a template.`);
			else throw new Error(`GitHub: ${created.message ?? `repo generation failed (${create.status})`}`);
		}
	}
	if (!fullName) throw new Error("GitHub: repo name unresolved");

	for (let attempt = 0; attempt < 10; attempt++) {
		const probe = await http(ctx, `${GH}/repos/${fullName}/contents/package.json`, { headers: ghHeaders(token) });
		if (probe.ok) break;
		await new Promise((r) => setTimeout(r, 1500));
	}
	if (mode === "fork" && isPrivate) await httpJson(ctx, `${GH}/repos/${fullName}`, "PATCH", { private: true }, ghHeaders(token)).catch(() => {});
	await ghPutFile(ctx, token, fullName, "src/config.ts", projectConfigTs(project), "Configure for this site");
	if (project.provision_secret) await ghSetActionsSecret(ctx, env, token, fullName, "CMS_SEED_TOKEN", project.provision_secret).catch(() => {});

	const pagesBody = { build_type: "workflow" };
	let pages = await httpJson(ctx, `${GH}/repos/${fullName}/pages`, "POST", pagesBody, ghHeaders(token));
	if (pages.status === 409) pages = await httpJson(ctx, `${GH}/repos/${fullName}/pages`, "PUT", { build_type: "workflow", cname: null }, ghHeaders(token));
	if (!pages.ok && pages.status !== 409) {
		if (pages.status === 422 && pages.text.includes("plan does not support GitHub Pages")) {
			const vis = await httpJson(ctx, `${GH}/repos/${fullName}`, "PATCH", { private: false }, ghHeaders(token));
			if (!vis.ok) throw new Error("GitHub Pages needs a public repository on your plan, and making it public failed.");
			pages = await httpJson(ctx, `${GH}/repos/${fullName}/pages`, "POST", pagesBody, ghHeaders(token));
			if (!pages.ok && pages.status !== 409) throw new Error(`GitHub Pages setup failed (${pages.status}): ${pages.text.slice(0, 200)}`);
		} else {
			throw new Error(`GitHub Pages setup failed (${pages.status}): ${pages.text.slice(0, 200)}`);
		}
	}
	// Forks start with Actions disabled until a workflow is enabled explicitly.
	await httpJson(ctx, `${GH}/repos/${fullName}/actions/workflows/deploy.yml/enable`, "PUT", {}, ghHeaders(token)).catch(() => {});
	await httpJson(ctx, `${GH}/repos/${fullName}/actions/workflows/deploy.yml/dispatches`, "POST", { ref: "main" }, ghHeaders(token)).catch(() => {});
	let themeSha: string | null = null;
	if (mode === "template") {
		const ref = await http(ctx, `${GH}/repos/${template}/git/ref/heads/main`, { headers: ghHeaders(token) });
		themeSha = ref.ok ? (ref.json<{ object?: { sha?: string } }>().object?.sha ?? null) : null;
	}
	await updateProject(ctx, projectId, { github_repo: fullName, github_mode: mode, frontend_hosting: "github", github_synced_at: new Date().toISOString(), github_theme_sha: themeSha });
	const origin = githubPagesOrigin(fullName);
	return { repo: fullName, url: htmlUrl ?? `https://github.com/${fullName}`, pagesUrl: `${origin}/`, origin, mode, note };
}

/**
 * Site-owned paths a theme update never overwrites. Theme-owned seed files
 * (designed sections, route pages) follow the theme: the deploy workflow
 * re-applies the repo's seed on every build, so a stale copy there would keep
 * overwriting the CMS with the old design.
 */
const THEME_PUSH_KEEP = ["src/config.ts", "seed/seed.json", "seed/content/posts/", "seed/content/products/"];

export interface ThemeDrift {
	upstream: string;
	/** Commits the site's repo has that the theme doesn't (customisations). */
	aheadBy: number;
	/** Theme commits the site's repo doesn't have yet. */
	behindBy: number;
	status: "identical" | "ahead" | "behind" | "diverged";
	/** A merge-upstream can bring the theme commits in (only meaningful when behind). */
	syncable: boolean;
	checkedAt: string;
}

/** How far the site's frontend has drifted from the official theme (forks only). */
export async function githubThemeDrift(ctx: PluginContext, env: ProviderEnv, project: ProjectRow): Promise<ThemeDrift | null> {
	if (!project.github_repo) return null;
	const token = await githubTokenForProject(ctx, env, project);
	const template = templateRepoFor(env, project);
	if (project.github_mode !== "fork") {
		// Template-generated repos share no history: measure only how far the theme moved since the last push.
		if (!project.github_theme_sha) return null;
		const res = await http(ctx, `${GH}/repos/${template}/compare/${project.github_theme_sha}...main`, { headers: ghHeaders(token) });
		if (!res.ok) return null;
		const behindBy = res.json<{ ahead_by?: number }>().ahead_by ?? 0;
		return { upstream: template, aheadBy: 0, behindBy, status: behindBy > 0 ? "behind" : "identical", syncable: behindBy > 0, checkedAt: new Date().toISOString() };
	}
	const [owner, repo] = project.github_repo.split("/");
	const res = await http(ctx, `${GH}/repos/${template}/compare/main...${owner}:${repo}:main`, { headers: ghHeaders(token) });
	if (!res.ok) return null;
	const data = res.json<{ ahead_by?: number; behind_by?: number; status?: string }>();
	const aheadBy = data.ahead_by ?? 0;
	const behindBy = data.behind_by ?? 0;
	const status = aheadBy === 0 && behindBy === 0 ? "identical" : aheadBy > 0 && behindBy > 0 ? "diverged" : aheadBy > 0 ? "ahead" : "behind";
	return { upstream: template, aheadBy, behindBy, status, syncable: behindBy > 0, checkedAt: new Date().toISOString() };
}

/** Merge the official theme's new commits into the site's repo; GitHub refuses when there are conflicts. */
export async function githubSyncTheme(ctx: PluginContext, env: ProviderEnv, project: ProjectRow): Promise<{ merged: boolean; conflict: boolean; message: string; mergeType?: string }> {
	if (!project.github_repo) throw new Error("no frontend repository");
	const token = await githubTokenForProject(ctx, env, project);
	if (project.github_mode !== "fork") {
		// No shared history to merge: the deploy service writes the theme's current files as one commit (site config + seed kept).
		const r = await deployService<{ commit: string; themeSha: string; files: number; skipped?: string[] }>(ctx, env, "/api/v1/theme-push", { token, repo: project.github_repo, template: templateRepoFor(env, project), branch: "main", keep: THEME_PUSH_KEEP });
		await updateProject(ctx, project.id, { github_synced_at: new Date().toISOString(), github_theme_sha: r.themeSha });
		const note = r.skipped?.length ? ` Workflow files (${r.skipped.join(", ")}) were left as they are — GitHub only lets the app change them with the "workflows" permission.` : "";
		return r.files > 0 ? { merged: true, conflict: false, message: `Updated ${r.files} theme file(s) to ${r.themeSha.slice(0, 7)}; your site config and seed were kept.${note}`, mergeType: "theme-push" } : { merged: false, conflict: false, message: `Already on the latest theme.${note}`, mergeType: "none" };
	}
	const res = await httpJson(ctx, `${GH}/repos/${project.github_repo}/merge-upstream`, "POST", { branch: "main" }, ghHeaders(token));
	const data = res.json<{ message?: string; merge_type?: string }>();
	if (res.status === 409) return { merged: false, conflict: true, message: "The theme's changes conflict with edits in your repository. Merge them manually on GitHub, then sync again." };
	if (!res.ok) throw new Error(`GitHub: ${data.message ?? `sync failed (${res.status})`}`);
	await updateProject(ctx, project.id, { github_synced_at: new Date().toISOString() });
	const merged = data.merge_type !== "none";
	return { merged, conflict: false, message: data.message ?? (merged ? "Theme updates merged." : "Already up to date."), mergeType: data.merge_type };
}

/** Rebuild the GitHub Pages site from current CMS content (re-runs the deploy workflow). */
export async function githubRebuild(ctx: PluginContext, env: ProviderEnv, project: ProjectRow): Promise<{ dispatched: boolean; status: number }> {
	if (!project.github_repo) throw new Error("no frontend repository");
	const token = await githubTokenForProject(ctx, env, project);
	const res = await httpJson(ctx, `${GH}/repos/${project.github_repo}/actions/workflows/deploy.yml/dispatches`, "POST", { ref: "main" }, ghHeaders(token));
	if (!res.ok) throw new Error(`GitHub: rebuild dispatch failed (${res.status}) ${res.text.slice(0, 120)}`);
	return { dispatched: true, status: res.status };
}
