/** Amazon SES v2 through the sandbox bridge (SigV4 via WebCrypto). */

import type { ProviderEnv } from "./env.js";
import { http } from "./env.js";
import type { PluginContext } from "./shim.js";

const enc = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", enc.encode(data));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const k = await crypto.subtle.importKey("raw", key as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export async function sesRequest(ctx: PluginContext, env: ProviderEnv, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
	const ak = env.SES_ACCESS_KEY_ID;
	const sk = env.SES_SECRET_ACCESS_KEY;
	const region = env.SES_REGION;
	if (!ak || !sk || !region) throw new Error("SES credentials (SES_ACCESS_KEY_ID/SECRET/REGION) are not configured");
	const host = `email.${region}.amazonaws.com`;
	const payload = body === undefined ? "" : JSON.stringify(body);
	const now = new Date();
	const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const datestamp = amzdate.slice(0, 8);
	const payloadHash = await sha256Hex(payload);
	const canonical = `${method}\n${path}\n\nhost:${host}\nx-amz-date:${amzdate}\n\nhost;x-amz-date\n${payloadHash}`;
	const scope = `${datestamp}/${region}/ses/aws4_request`;
	const toSign = `AWS4-HMAC-SHA256\n${amzdate}\n${scope}\n${await sha256Hex(canonical)}`;
	let key: ArrayBuffer = enc.encode(`AWS4${sk}`).buffer as ArrayBuffer;
	for (const part of [datestamp, region, "ses", "aws4_request"]) key = await hmac(key, part);
	const sig = [...new Uint8Array(await hmac(key, toSign))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const res = await http(ctx, `https://${host}${path}`, {
		method,
		headers: {
			"X-Amz-Date": amzdate,
			Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=host;x-amz-date, Signature=${sig}`,
			"Content-Type": "application/json",
		},
		body: payload || undefined,
	});
	return { status: res.status, data: res.json() };
}

export interface SesIdentity {
	verified: boolean;
	dkimTokens: string[];
}

export async function sesEnsureIdentity(ctx: PluginContext, env: ProviderEnv, domain: string): Promise<SesIdentity> {
	const create = await sesRequest(ctx, env, "POST", "/v2/email/identities", { EmailIdentity: domain });
	if (create.status === 200) {
		return { verified: create.data.VerifiedForSendingStatus === true, dkimTokens: (create.data.DkimAttributes as { Tokens?: string[] })?.Tokens ?? [] };
	}
	const get = await sesRequest(ctx, env, "GET", `/v2/email/identities/${domain}`);
	if (get.status !== 200) throw new Error(`SES identity failed: ${String(create.data.Message ?? create.data.message ?? get.data.Message ?? create.status)}`);
	return { verified: get.data.VerifiedForSendingStatus === true, dkimTokens: (get.data.DkimAttributes as { Tokens?: string[] })?.Tokens ?? [] };
}

export async function sesIdentityVerified(ctx: PluginContext, env: ProviderEnv, domain: string): Promise<boolean> {
	const get = await sesRequest(ctx, env, "GET", `/v2/email/identities/${domain}`);
	return get.status === 200 && get.data.VerifiedForSendingStatus === true;
}

export function sesDkimRecords(domain: string, tokens: string[]) {
	return tokens.map((tk) => ({ type: "CNAME", name: `${tk}._domainkey.${domain}`, content: `${tk}.dkim.amazonses.com` }));
}

export async function sesSetMailFrom(ctx: PluginContext, env: ProviderEnv, domain: string, mailFrom: string): Promise<void> {
	const res = await sesRequest(ctx, env, "PUT", `/v2/email/identities/${domain}/mail-from`, { MailFromDomain: mailFrom, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" });
	if (res.status !== 200) throw new Error(`SES mail-from failed: ${String(res.data.Message ?? res.status)}`);
}

export function sesMailFromRecords(mailFrom: string, region: string) {
	return [
		{ type: "MX", name: mailFrom, content: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
		{ type: "TXT", name: mailFrom, content: '"v=spf1 include:amazonses.com ~all"' },
	];
}

export async function sesDeleteIdentity(ctx: PluginContext, env: ProviderEnv, domain: string): Promise<void> {
	await sesRequest(ctx, env, "DELETE", `/v2/email/identities/${domain}`).catch(() => {});
}
