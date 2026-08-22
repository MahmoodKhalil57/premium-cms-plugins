/**
 * Custom domains & branded email (records-only; nothing is ever
 * transferred) — ported to the sandbox bridge.
 */

import type { ProviderEnv } from "./env.js";
import { cfApi, cfZone, cfZoneId, http, httpJson } from "./env.js";
import { type DnsRecord, type DomainRow, getDomains, getProject, saveDomain } from "./registry.js";
import { sesDkimRecords, sesEnsureIdentity, sesIdentityVerified, sesMailFromRecords, sesSetMailFrom } from "./ses.js";
import type { PluginContext } from "./shim.js";

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

function inPlatformZone(domain: string, env: ProviderEnv): boolean {
	return domain === env.PLATFORM_ZONE || domain.endsWith(`.${env.PLATFORM_ZONE}`);
}

async function setChildOption(ctx: PluginContext, env: ProviderEnv, d1Id: string, name: string, value: unknown): Promise<void> {
	const res = await cfApi(ctx, env, "POST", `/d1/database/${d1Id}/query`, {
		sql: "INSERT INTO options (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value=?2",
		params: [name, JSON.stringify(value)],
	});
	if (!res.success) throw new Error(`child option write failed: ${JSON.stringify(res.errors)}`);
}

/** Per-secret endpoint only — the script-settings PATCH can drop bindings. */
export async function patchChildSecrets(ctx: PluginContext, env: ProviderEnv, script: string, secrets: Array<{ name: string; text: string }>): Promise<void> {
	for (const s of secrets) {
		const res = await cfApi(ctx, env, "PUT", `/workers/scripts/${script}/secrets`, { name: s.name, text: s.text, type: "secret_text" });
		if (!res.success) throw new Error(`secret ${s.name} failed: ${JSON.stringify(res.errors)}`);
	}
}

export async function deleteChildSecret(ctx: PluginContext, env: ProviderEnv, script: string, name: string): Promise<void> {
	await cfApi(ctx, env, "DELETE", `/workers/scripts/${script}/secrets/${name}`).catch(() => {});
}

async function activateSiteDomain(ctx: PluginContext, env: ProviderEnv, projectId: string, domain: string): Promise<void> {
	const project = await getProject(ctx, projectId);
	if (!project?.d1_id) return;
	await setChildOption(ctx, env, project.d1_id, "emdash:site_url", `https://${domain}`);
	await patchChildSecrets(ctx, env, projectId, [{ name: "EMDASH_SITE_URL", text: `https://${domain}` }]);
}

export async function setSiteDomain(ctx: PluginContext, env: ProviderEnv, projectId: string, domain: string): Promise<{ status: string; records: DnsRecord[] }> {
	domain = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	if (!DOMAIN_RE.test(domain)) throw new Error(`invalid domain "${domain}"`);
	const project = await getProject(ctx, projectId);
	if (!project) throw new Error("unknown project");
	const zoneId = await cfZoneId(ctx, env);

	if (inPlatformZone(domain, env)) {
		const res = await cfApi(ctx, env, "PUT", `/workers/domains`, { zone_id: zoneId, hostname: domain, service: projectId, environment: "production" });
		if (!res.success && !JSON.stringify(res.errors).includes("already")) throw new Error(`domain attach failed: ${JSON.stringify(res.errors)}`);
		await saveDomain(ctx, { project_id: projectId, kind: "site", domain, status: "active", records: "[]" });
		await activateSiteDomain(ctx, env, projectId, domain);
		return { status: "active", records: [] };
	}

	const fallback = `fallback.${env.PLATFORM_ZONE}`;
	await cfZone(ctx, env, zoneId, "POST", `/dns_records`, { type: "A", name: fallback, content: "192.0.2.1", proxied: true, ttl: 1 }).catch(() => {});
	await cfZone(ctx, env, zoneId, "PUT", `/custom_hostnames/fallback_origin`, { origin: fallback }).catch(() => {});

	const records: DnsRecord[] = [];
	let chId: string | null = null;
	for (const host of [domain, `www.${domain}`]) {
		const ch = await cfZone<{ id: string; ownership_verification?: { name: string; value: string } }>(ctx, env, zoneId, "POST", `/custom_hostnames`, {
			hostname: host,
			ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
		});
		let id = ch.result?.id;
		let ov = ch.result?.ownership_verification;
		if (!ch.success) {
			if (!JSON.stringify(ch.errors).includes("Duplicate")) throw new Error(`custom hostname ${host}: ${ch.errors?.[0]?.message}`);
			const list = await cfZone<Array<{ id: string; ownership_verification?: { name: string; value: string } }>>(ctx, env, zoneId, "GET", `/custom_hostnames?hostname=${host}`);
			id = list.result?.[0]?.id;
			ov = list.result?.[0]?.ownership_verification;
		}
		if (host === domain && id) chId = id;
		if (ov) records.push({ type: "TXT", name: ov.name, content: ov.value });
		await cfZone(ctx, env, zoneId, "POST", `/workers/routes`, { pattern: `${host}/*`, script: projectId }).catch(() => {});
	}
	const dcv = await cfZone<{ uuid?: string }>(ctx, env, zoneId, "GET", `/dcv_delegation/uuid`);
	records.unshift({ type: "CNAME", name: domain, content: fallback }, { type: "CNAME", name: `www.${domain}`, content: fallback });
	if (dcv.result?.uuid) {
		for (const host of [domain, `www.${domain}`]) records.push({ type: "CNAME", name: `_acme-challenge.${host}`, content: `${host}.${dcv.result.uuid}.dcv.cloudflare.com` });
	}
	await saveDomain(ctx, { project_id: projectId, kind: "site", domain, status: "pending-dns (add the records below at your DNS host)", records: JSON.stringify(records), external_id: chId ? `ch:${chId}` : null });
	return { status: "pending-dns", records };
}

export async function siteDomainStatus(ctx: PluginContext, env: ProviderEnv, projectId: string): Promise<DomainRow | undefined> {
	const row = (await getDomains(ctx, projectId)).find((r) => r.kind === "site");
	if (!row || row.status === "active" || !row.external_id?.startsWith("ch:")) return row;
	const zoneId = await cfZoneId(ctx, env);
	const res = await cfZone<{ status?: string; ssl?: { status?: string } }>(ctx, env, zoneId, "GET", `/custom_hostnames/${row.external_id.slice(3)}`);
	if (res.result?.status === "active" && res.result.ssl?.status === "active") {
		await activateSiteDomain(ctx, env, projectId, row.domain);
		return saveDomain(ctx, { ...row, status: "active", records: "[]" });
	}
	return saveDomain(ctx, { ...row, status: `pending-dns (hostname: ${res.result?.status}, certificate: ${res.result?.ssl?.status})` });
}

async function flipEmailProviderSes(ctx: PluginContext, env: ProviderEnv, projectId: string, fromAddress: string): Promise<void> {
	const project = await getProject(ctx, projectId);
	if (!project?.d1_id) throw new Error("project has no database");
	await setChildOption(ctx, env, project.d1_id, "emdash:exclusive_hook:email:deliver", "ses-email");
	await patchChildSecrets(ctx, env, projectId, [
		{ name: "SES_FROM_EMAIL", text: fromAddress },
		{ name: "SES_ACCESS_KEY_ID", text: env.SES_ACCESS_KEY_ID },
		{ name: "SES_SECRET_ACCESS_KEY", text: env.SES_SECRET_ACCESS_KEY },
		{ name: "SES_REGION", text: env.SES_REGION },
	]);
}

export async function setEmailDomain(ctx: PluginContext, env: ProviderEnv, projectId: string, domain: string): Promise<{ status: string; records: DnsRecord[] }> {
	domain = domain.trim().toLowerCase();
	if (!DOMAIN_RE.test(domain)) throw new Error(`invalid domain "${domain}"`);
	const project = await getProject(ctx, projectId);
	if (!project) throw new Error("unknown project");
	if (inPlatformZone(domain, env)) {
		await flipEmailProviderSes(ctx, env, projectId, `no-reply@${domain}`);
		await saveDomain(ctx, { project_id: projectId, kind: "email", domain, status: "active", records: "[]" });
		return { status: "active", records: [] };
	}
	const identity = await sesEnsureIdentity(ctx, env, domain);
	const mailFrom = `notify.${domain}`;
	await sesSetMailFrom(ctx, env, domain, mailFrom).catch(() => {});
	const records: DnsRecord[] = [...sesDkimRecords(domain, identity.dkimTokens), ...sesMailFromRecords(mailFrom, env.SES_REGION || "eu-north-1")];
	const status = identity.verified ? "active" : "verifying-email (add the records below at your DNS host)";
	await saveDomain(ctx, { project_id: projectId, kind: "email", domain, status, records: identity.verified ? "[]" : JSON.stringify(records), external_id: null });
	if (identity.verified) await flipEmailProviderSes(ctx, env, projectId, `no-reply@${domain}`);
	return { status, records: identity.verified ? [] : records };
}

export async function emailDomainStatus(ctx: PluginContext, env: ProviderEnv, projectId: string): Promise<DomainRow | undefined> {
	const row = (await getDomains(ctx, projectId)).find((r) => r.kind === "email");
	if (!row || row.status === "active" || !row.status.startsWith("verifying-email")) return row;
	const verified = await sesIdentityVerified(ctx, env, row.domain).catch(() => false);
	if (!verified) return row;
	await flipEmailProviderSes(ctx, env, projectId, `no-reply@${row.domain}`);
	return saveDomain(ctx, { ...row, status: "active", records: "[]" });
}

export interface DnsHostInfo {
	provider: "cloudflare" | "simply" | null;
	label: string | null;
}

export async function detectDnsHost(ctx: PluginContext, domain: string): Promise<DnsHostInfo> {
	try {
		const res = await http(ctx, `https://cloudflare-dns.com/dns-query?name=${domain}&type=NS`, { headers: { Accept: "application/dns-json" } });
		const ns = (res.json<{ Answer?: Array<{ data: string }> }>().Answer ?? []).map((a) => a.data.toLowerCase());
		const joined = ns.join(" ");
		if (joined.includes("cloudflare")) return { provider: "cloudflare", label: "Cloudflare" };
		if (joined.includes("simply") || joined.includes("unoeuro")) return { provider: "simply", label: "Simply.com" };
		if (ns.length > 0) return { provider: null, label: ns[0]!.replace(/\.$/, "") };
	} catch {
		/* best-effort */
	}
	return { provider: null, label: null };
}

export interface DnsApplyCreds {
	provider: "cloudflare" | "simply";
	apiKey: string;
	accountNumber?: string;
}

/** BYOK: the customer's DNS key is used for this call only — never stored or logged. */
export async function applyDnsRecords(ctx: PluginContext, env: ProviderEnv, projectId: string, creds: DnsApplyCreds): Promise<{ added: number; skipped: number; failed: string[] }> {
	const rows = await getDomains(ctx, projectId);
	const pending: DnsRecord[] = [];
	let root: string | null = null;
	for (const row of rows) {
		if (row.status === "active") continue;
		root ??= row.domain;
		for (const r of JSON.parse(row.records) as DnsRecord[]) pending.push(r);
	}
	if (!root || pending.length === 0) throw new Error("no pending DNS records for this project");
	const seen = new Set<string>();
	const records = pending.filter((r) => {
		const key = `${r.type}|${r.name}|${r.content}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	let added = 0, skipped = 0;
	const failed: string[] = [];
	if (creds.provider === "cloudflare") {
		const hdrs = { Authorization: `Bearer ${creds.apiKey}` };
		const z = await http(ctx, `https://api.cloudflare.com/client/v4/zones?name=${root}`, { headers: hdrs });
		const zdata = z.json<{ success: boolean; result?: Array<{ id: string }>; errors?: Array<{ message: string }> }>();
		const zone = zdata.result?.[0]?.id;
		if (!zdata.success || !zone) throw new Error(`Cloudflare: ${zdata.errors?.[0]?.message ?? `token cannot see the ${root} zone`} — create the token with Zone → DNS → Edit for ${root}`);
		for (const r of records) {
			const res = await httpJson(ctx, `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, "POST", {
				type: r.type, name: r.name, content: r.content, ttl: 1,
				...(r.type === "MX" ? { priority: r.priority ?? 10 } : {}),
				...(r.type === "CNAME" || r.type === "A" || r.type === "AAAA" ? { proxied: false } : {}),
			}, hdrs);
			const data = res.json<{ success: boolean; errors?: Array<{ message: string }> }>();
			if (data.success) added++;
			else if (JSON.stringify(data.errors).includes("already exists")) skipped++;
			else failed.push(`${r.type} ${r.name}: ${data.errors?.[0]?.message}`);
		}
	} else if (creds.provider === "simply") {
		if (!creds.accountNumber) throw new Error("Simply.com account number required (e.g. S123456)");
		const auth = "Basic " + btoa(`${creds.accountNumber}:${creds.apiKey}`);
		for (const r of records) {
			const res = await httpJson(ctx, `https://api.simply.com/2/my/products/${root}/dns/records/`, "POST", {
				type: r.type, name: r.name, data: r.content.replace(/^"|"$/g, ""), ttl: 3600,
				...(r.type === "MX" ? { priority: r.priority ?? 10 } : {}),
			}, { Authorization: auth });
			const data = res.json<{ status?: number; message?: string }>();
			if (res.ok && (!data.status || data.status < 400)) added++;
			else if ((data.message ?? "").toLowerCase().includes("exist")) skipped++;
			else failed.push(`${r.type} ${r.name}: ${data.message ?? `HTTP ${res.status}`}`);
		}
	} else {
		throw new Error("unknown provider");
	}
	await siteDomainStatus(ctx, env, projectId).catch(() => {});
	await emailDomainStatus(ctx, env, projectId).catch(() => {});
	return { added, skipped, failed };
}
