/**
 * Platform-zone hostnames, handed out by the PARENT.
 *
 * A child may bring its own domain through the Cloudflare-for-SaaS flow
 * (domains.ts), but hostnames on the platform zone itself (premium-cms.com,
 * shop.premium-cms.com…) are the control plane's to assign: the operator sets
 * `domain` on the project row, and this attaches it to the child's Worker as
 * a Workers custom domain, makes it the child's canonical URL (and its
 * "default" for the Reset button), and rebuilds the frontend. Clearing the
 * field puts the instance back on its p<ulid> hostname. Reconciled on every
 * save, so it is idempotent; a rejected value is cleared with the reason
 * logged.
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import { cfApi, cfZoneId, d1Query, findD1IdByName, resolveZone } from "./cf.js";
import { normalizeDomain } from "./domains.js";
import { dispatchRebuild, setSecret } from "./github.js";
import { isUlid, resourceName } from "./provisioner.js";
import { credsOf, siteZone, type Settings } from "./settings.js";

const RESERVED_LABELS = new Set(["master", "router", "marketplace", "www"]);
const INSTANCE_LABEL = /^p[0-9a-hjkmnp-tv-z]{26}$/;

interface WorkerDomain {
	id: string;
	hostname: string;
	service: string;
}

/**
 * Make `url` an instance's canonical origin: write its `site:url` option and
 * rebuild its static frontend with the new SITE_URL (so the build's links and
 * its snapshot's absolute media URLs use it). The rebuild is best-effort.
 */
export async function applyCanonicalUrl(
	ctx: PluginContext,
	settings: Settings,
	project: string,
	url: string,
	defaultUrl?: string,
): Promise<void> {
	const creds = credsOf(settings);
	const rn = resourceName(project);
	const d1Id = await findD1IdByName(ctx, creds, `${rn}-db`);
	if (d1Id) {
		const rows: Array<[string, string]> = [["site:url", url]];
		if (defaultUrl) rows.push(["custom_domain:default_url", defaultUrl]);
		for (const [name, value] of rows) {
			await d1Query(
				ctx,
				creds,
				d1Id,
				"INSERT INTO options (name,value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
				[name, JSON.stringify(value)],
			);
		}
	}
	const token = await ctx.kv.get<string>(`github:token:${project}`);
	const owner = await ctx.kv.get<string>(`github:owner:${project}`);
	const repo = await ctx.kv.get<string>(`github:repo:${project}`);
	if (token && owner && repo) {
		try {
			await setSecret(ctx, token, owner, repo, "SITE_URL", url);
			await dispatchRebuild(ctx, token, owner, repo);
		} catch (err) {
			ctx.log.warn(`[premiumcms-projects] frontend rebuild for ${project} failed`, err);
		}
	}
}

/** Why a requested platform hostname can't be assigned, or null when it can. */
export function rejectPlatformDomain(
	domain: string,
	zone: string,
	rows: Array<{ id: string; data: Record<string, unknown> }>,
	project: string,
): string | null {
	if (domain !== zone && !domain.endsWith(`.${zone}`))
		return `${domain} is not on the platform zone ${zone}`;
	const label = domain === zone ? "" : domain.slice(0, -(zone.length + 1));
	if (label.includes(".")) return `${domain}: only one level below ${zone} is supported`;
	if (RESERVED_LABELS.has(label) || INSTANCE_LABEL.test(label))
		return `${domain} is reserved by the platform`;
	for (const r of rows) {
		if (r.id === project) continue;
		if (normalizeDomain(typeof r.data.domain === "string" ? r.data.domain : "") === domain)
			return `${domain} is already assigned to project ${r.id}`;
	}
	return null;
}

/**
 * Reconcile a project's platform hostname with what is attached to its Worker.
 * Returns what changed (empty when already in sync) or throws with the reason.
 */
export async function applyPlatformDomain(
	ctx: PluginContext,
	settings: Settings,
	project: string,
	requested: string,
	rows: Array<{ id: string; data: Record<string, unknown> }>,
): Promise<string[]> {
	if (!isUlid(project)) throw new Error("not a ULID");
	const creds = credsOf(settings);
	const rn = resourceName(project);
	const zone = (await resolveZone(ctx, creds, siteZone(ctx))).name;
	const home = `${rn}.${zone}`;
	const domain = normalizeDomain(requested);
	if (domain) {
		const why = rejectPlatformDomain(domain, zone, rows, project);
		if (why) throw new Error(why);
	}

	const all = await cfApi<WorkerDomain[]>(ctx, creds, "GET", "/workers/domains");
	const mine = (all.result ?? []).filter((d) => d.service === rn);
	const changes: string[] = [];

	for (const d of mine) {
		if (d.hostname === home || d.hostname === domain) continue;
		const r = await cfApi(ctx, creds, "DELETE", `/workers/domains/${d.id}`);
		if (!r.success) throw new Error(`detach ${d.hostname}: ${JSON.stringify(r.errors)}`);
		changes.push(`detached ${d.hostname}`);
	}
	if (domain && !mine.some((d) => d.hostname === domain)) {
		const r = await cfApi(ctx, creds, "PUT", "/workers/domains", {
			zone_id: await cfZoneId(ctx, creds, zone),
			hostname: domain,
			service: rn,
			environment: "production",
		});
		if (!r.success) throw new Error(`attach ${domain}: ${JSON.stringify(r.errors)}`);
		changes.push(`attached ${domain}`);
	}

	if (changes.length) {
		const url = `https://${domain || home}`;
		await applyCanonicalUrl(ctx, settings, project, url, url);
		changes.push(`canonical ${url}`);
	}
	return changes;
}
