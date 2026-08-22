/**
 * Project registry in plugin storage (replaces the platform_projects /
 * platform_domains D1 tables). Field names stay snake_case so the admin UI
 * and child contracts are unchanged.
 */

import type { PluginContext, StorageCollection } from "./shim.js";

export interface ProjectRow {
	id: string;
	hostname: string;
	admin_email: string;
	site_title: string;
	tagline: string | null;
	status: string;
	error: string | null;
	d1_id: string | null;
	kv_id: string | null;
	bucket: string | null;
	bundle_version: string | null;
	provision_secret: string | null;
	encryption_key: string | null;
	github_token: string | null;
	github_installation_id: string | null;
	github_login: string | null;
	github_repo: string | null;
	/** How the frontend repo was created: a fork of the official theme (drift + sync available) or generated from the template. */
	github_mode?: "fork" | "template" | null;
	/** Who serves the site's frontend: the platform (theme as is) or the GitHub Pages build proxied on the site's domain. */
	frontend_hosting?: "platform" | "github" | null;
	github_synced_at?: string | null;
	/** Theme commit last pushed into a template-generated repo (drift baseline). */
	github_theme_sha?: string | null;
	/** Marketplace theme the site runs (null = the platform default) and its template repository. */
	theme_id?: string | null;
	theme_repo?: string | null;
	stripe_customer_id?: string | null;
	created_at: string;
	updated_at: string;
}

export interface DomainRow {
	project_id: string;
	kind: "site" | "email";
	domain: string;
	status: string;
	records: string;
	external_id: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
}

export interface DnsRecord {
	type: string;
	name: string;
	content: string;
	priority?: number;
}

export const projects = (ctx: PluginContext) => ctx.storage.projects as StorageCollection<ProjectRow>;
export const domains = (ctx: PluginContext) => ctx.storage.domains as StorageCollection<DomainRow>;

export function getProject(ctx: PluginContext, id: string): Promise<ProjectRow | null> {
	return projects(ctx).get(id.toLowerCase());
}

export async function listProjects(ctx: PluginContext): Promise<ProjectRow[]> {
	const res = await projects(ctx).query({ orderBy: { created_at: "desc" }, limit: 100 });
	return res.items.map((i) => i.data);
}

export async function updateProject(ctx: PluginContext, id: string, patch: Partial<ProjectRow>): Promise<ProjectRow> {
	const row = await getProject(ctx, id);
	if (!row) throw new Error("unknown project");
	const next = { ...row, ...patch, updated_at: new Date().toISOString() };
	await projects(ctx).put(row.id, next);
	return next;
}

export async function getDomains(ctx: PluginContext, projectId: string): Promise<DomainRow[]> {
	const res = await domains(ctx).query({ where: { project_id: projectId }, limit: 10 });
	return res.items.map((i) => i.data);
}

export async function saveDomain(ctx: PluginContext, row: Partial<DomainRow> & { project_id: string; kind: "site" | "email" }): Promise<DomainRow> {
	const key = `${row.project_id}:${row.kind}`;
	const existing = await domains(ctx).get(key);
	const now = new Date().toISOString();
	const next: DomainRow = {
		project_id: row.project_id,
		kind: row.kind,
		domain: row.domain ?? existing?.domain ?? "",
		status: row.status ?? existing?.status ?? "pending",
		records: row.records ?? existing?.records ?? "[]",
		external_id: row.external_id !== undefined ? row.external_id : (existing?.external_id ?? null),
		error: row.error !== undefined ? row.error : (existing?.error ?? null),
		created_at: existing?.created_at ?? now,
		updated_at: now,
	};
	await domains(ctx).put(key, next);
	return next;
}

export async function deleteProjectRows(ctx: PluginContext, projectId: string): Promise<void> {
	await domains(ctx).deleteMany([`${projectId}:site`, `${projectId}:email`]);
	await projects(ctx).delete(projectId);
}
