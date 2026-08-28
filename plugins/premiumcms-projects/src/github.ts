/**
 * GitHub App integration for the static-frontend hosting mode.
 *
 * A project's public site is a static build on GitHub Pages (never Cloudflare):
 * this module, using an OAuth **user** access token (the customer authorizes the
 * premium-cms App once), creates the frontend repo in the customer's account,
 * pushes the frontend-static tooling + the project's seed, sets the build
 * secrets, enables Pages, and can trigger rebuilds via repository_dispatch.
 *
 * Why a user token (not an installation token): GitHub Apps can only create
 * repos in ORGS, not personal accounts — but an App *user* token can (verified).
 * Config is written as Actions *secrets* (encrypted); Actions *variables* are
 * not writable by the App token, so everything goes through secrets.
 *
 * Crypto: GitHub secrets require a libsodium sealed box. Cloudflare Workers
 * block runtime WASM, so we use pure-JS tweetnacl + blakejs (verified accepted).
 */

import nacl from "tweetnacl";
import { blake2b } from "blakejs";

import { http } from "./cf.js";
import type { PluginContext } from "@premium-cms/emdash/plugin";
import type { Settings } from "./settings.js";

const GH = "https://api.github.com";

interface GhResult {
	status: number;
	ok: boolean;
	json<T = Record<string, unknown>>(): T;
	text: string;
}

/** Authenticated GitHub REST call over ctx.http (pinned to api.github.com). */
async function gh(
	ctx: PluginContext,
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<GhResult> {
	const res = await http(ctx, `${GH}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "premium-cms",
			"X-GitHub-Api-Version": "2022-11-28",
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return {
		status: res.status,
		ok: res.ok,
		text: res.text,
		json<T = Record<string, unknown>>(): T {
			try {
				return JSON.parse(res.text) as T;
			} catch {
				return {} as T;
			}
		},
	};
}

/* ── OAuth (redirect flow) ─────────────────────────────────────────── */

/** The URL to send a customer to so they authorize the App on their account. */
export function authorizeUrl(settings: Settings, redirectUri: string, state: string): string {
	const p = new URLSearchParams({
		client_id: settings.githubClientId,
		redirect_uri: redirectUri,
		state,
	});
	return `https://github.com/login/oauth/authorize?${p.toString()}`;
}

/** Exchange an OAuth `code` for a user access token. */
export async function exchangeCode(
	ctx: PluginContext,
	settings: Settings,
	code: string,
): Promise<string | null> {
	const res = await http(ctx, "https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: settings.githubClientId,
			client_secret: settings.githubClientSecret,
			code,
		}),
	});
	const data = res.json<{ access_token?: string }>();
	return data.access_token ?? null;
}

/* ── Provisioning primitives ───────────────────────────────────────── */

/** crypto_box_seal (libsodium) in pure JS, for GitHub Actions secrets. */
function sealBox(message: Uint8Array, recipientPk: Uint8Array): Uint8Array {
	const eph = nacl.box.keyPair();
	const nonce = blake2b(new Uint8Array([...eph.publicKey, ...recipientPk]), undefined, 24);
	const boxed = nacl.box(message, nonce, recipientPk, eph.secretKey);
	const out = new Uint8Array(eph.publicKey.length + boxed.length);
	out.set(eph.publicKey);
	out.set(boxed, eph.publicKey.length);
	return out;
}

const toB64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface GithubUser {
	login: string;
}

/** The authenticated user (repo owner). */
export async function whoami(ctx: PluginContext, token: string): Promise<GithubUser | null> {
	const r = await gh(ctx, token, "GET", "/user");
	if (!r.ok) return null;
	return r.json<GithubUser>();
}

/** Create the frontend repo from the platform's template repo (all files in one call). */
export async function createFromTemplate(
	ctx: PluginContext,
	token: string,
	template: string, // "owner/repo"
	owner: string,
	name: string,
	description: string,
): Promise<{ ok: boolean; error?: string }> {
	const [tOwner, tRepo] = template.split("/");
	if (!tOwner || !tRepo) return { ok: false, error: "frontendTemplate must be owner/repo" };
	const r = await gh(ctx, token, "POST", `/repos/${tOwner}/${tRepo}/generate`, {
		owner,
		name,
		description,
		private: false,
		include_all_branches: false,
	});
	if (r.ok || r.status === 201) return { ok: true };
	if (r.status === 422 && r.text.includes("already exists")) return { ok: true }; // idempotent
	return { ok: false, error: `generate ${r.status}: ${r.text.slice(0, 150)}` };
}

/** Commit a set of text files to the repo's default branch (git Trees API). */
export async function pushFiles(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
	files: Array<{ path: string; content: string }>,
	message: string,
	branch = "main",
): Promise<{ ok: boolean; error?: string }> {
	const ref = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
	if (!ref.ok) return { ok: false, error: `ref ${ref.status}` };
	const baseSha = ref.json<{ object: { sha: string } }>().object.sha;
	const baseCommit = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`);
	const baseTree = baseCommit.json<{ tree: { sha: string } }>().tree.sha;

	const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
	for (const f of files) {
		const blob = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/git/blobs`, {
			content: f.content,
			encoding: "utf-8",
		});
		if (!blob.ok) return { ok: false, error: `blob ${f.path}: ${blob.status}` };
		tree.push({
			path: f.path,
			mode: "100644",
			type: "blob",
			sha: blob.json<{ sha: string }>().sha,
		});
	}
	const treeRes = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/git/trees`, {
		base_tree: baseTree,
		tree,
	});
	if (!treeRes.ok) return { ok: false, error: `tree ${treeRes.status}` };
	const commit = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/git/commits`, {
		message,
		tree: treeRes.json<{ sha: string }>().sha,
		parents: [baseSha],
	});
	if (!commit.ok) return { ok: false, error: `commit ${commit.status}` };
	const upd = await gh(ctx, token, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
		sha: commit.json<{ sha: string }>().sha,
	});
	return upd.ok
		? { ok: true }
		: { ok: false, error: `ref update ${upd.status}: ${upd.text.slice(0, 120)}` };
}

/** Set an encrypted Actions secret (sealed box). */
export async function setSecret(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
	name: string,
	value: string,
): Promise<{ ok: boolean; error?: string }> {
	const pkRes = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/actions/secrets/public-key`);
	if (!pkRes.ok) return { ok: false, error: `public-key ${pkRes.status}` };
	const pk = pkRes.json<{ key: string; key_id: string }>();
	const enc = toB64(sealBox(new TextEncoder().encode(value), fromB64(pk.key)));
	const r = await gh(ctx, token, "PUT", `/repos/${owner}/${repo}/actions/secrets/${name}`, {
		encrypted_value: enc,
		key_id: pk.key_id,
	});
	return r.status === 201 || r.status === 204
		? { ok: true }
		: { ok: false, error: `secret ${r.status}` };
}

/** Enable GitHub Pages with the GitHub Actions build type. */
export async function enablePages(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
): Promise<{ ok: boolean; url?: string }> {
	let r = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/pages`, { build_type: "workflow" });
	if (r.status === 409) {
		r = await gh(ctx, token, "PUT", `/repos/${owner}/${repo}/pages`, { build_type: "workflow" });
	}
	const info = await gh(ctx, token, "GET", `/repos/${owner}/${repo}/pages`);
	const url = info.ok ? info.json<{ html_url?: string }>().html_url : undefined;
	return { ok: r.ok || r.status === 204 || r.status === 409, url };
}

/** Trigger a rebuild of the static site. */
export async function dispatchRebuild(
	ctx: PluginContext,
	token: string,
	owner: string,
	repo: string,
): Promise<boolean> {
	const r = await gh(ctx, token, "POST", `/repos/${owner}/${repo}/dispatches`, {
		event_type: "content-published",
	});
	return r.status === 204;
}
