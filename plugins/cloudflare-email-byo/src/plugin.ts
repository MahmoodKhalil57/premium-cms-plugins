/**
 * Cloudflare Email (own account) — a bring-your-own-credentials email provider.
 *
 * EmDash's built-in `cloudflareEmail` provider sends through the Worker's
 * `send_email` binding, which is bound to whichever Cloudflare account
 * deployed the Worker — the platform's. That is fine for a single site, but
 * on a fleet every project's mail then leaves from the parent account, on the
 * parent's sending domain and reputation, counting against the parent's quota.
 *
 * This provider instead calls the Cloudflare Email Sending REST API with an
 * API token the site owner enters in the admin, so mail leaves from their
 * account and their verified domain. The platform never holds the credential.
 *
 * Registered as the exclusive `email:deliver` hook. EmDash auto-selects a
 * provider only when exactly one is active, so with both this and the
 * built-in provider installed an admin must choose under Settings → Email.
 *
 * Setup for the owner:
 *   1. Onboard a domain for Email Sending in their Cloudflare dashboard.
 *   2. Create an API token with email sending permission.
 *   3. Enter the account ID, token and sender address on this plugin's
 *      settings page, then send a test.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

// ── Types ────────────────────────────────────────────────────────────────

interface Settings {
	accountId: string;
	fromAddress: string;
	fromName: string;
	replyTo: string;
	/** Present only in the internal read; never returned by a route. */
	apiToken?: string;
}

/** Shape of a Cloudflare API envelope, narrowed to what we read. */
interface CloudflareEnvelope {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	result?: {
		delivered?: string[];
		permanent_bounces?: string[];
		queued?: string[];
	} | null;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const KV_PREFIX = "settings:";

// Cloudflare account IDs are 32 lowercase hex characters. Validated so a
// pasted dashboard URL or stray whitespace fails on the settings page with a
// clear message, rather than as an opaque 404 at the first send.
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

// ── Helpers ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function looksLikeEmail(value: string): boolean {
	// Deliberately loose: Cloudflare is the authority on whether the sender is
	// valid. This only catches obvious typos before a send is attempted.
	const at = value.indexOf("@");
	return at > 0 && at < value.length - 1 && !/\s/.test(value);
}

/** Read settings from kv. Never throws — a failed read degrades to blanks. */
async function readSettings(ctx: PluginContext): Promise<Settings> {
	const blank: Settings = {
		accountId: "",
		fromAddress: "",
		fromName: "",
		replyTo: "",
		apiToken: "",
	};
	try {
		const entries = await ctx.kv.list(KV_PREFIX);
		const map: Record<string, unknown> = {};
		for (const entry of entries) map[entry.key.replace(KV_PREFIX, "")] = entry.value;
		return {
			accountId: asString(map.accountId).trim(),
			fromAddress: asString(map.fromAddress).trim(),
			fromName: asString(map.fromName).trim(),
			replyTo: asString(map.replyTo).trim(),
			apiToken: asString(map.apiToken),
		};
	} catch (error) {
		ctx.log.error("Failed to read settings", error);
		return blank;
	}
}

/**
 * Everything needed to send, or a list of what is missing.
 *
 * Returned as a discriminated union rather than throwing so both the delivery
 * hook and the settings page can report the same reasons.
 */
function validate(settings: Settings): { ok: true } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	if (!settings.accountId) missing.push("account ID");
	else if (!ACCOUNT_ID_RE.test(settings.accountId))
		missing.push("a valid account ID (32 hex characters)");
	if (!settings.apiToken) missing.push("API token");
	if (!settings.fromAddress) missing.push("sender address");
	else if (!looksLikeEmail(settings.fromAddress)) missing.push("a valid sender address");
	return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** Redact everything but the shape of a secret, for safe display. */
function redact(token: string): string {
	if (!token) return "";
	return token.length <= 8 ? "••••••••" : `••••••••${token.slice(-4)}`;
}

/**
 * Turn a Cloudflare API response into an error message, or null on success.
 *
 * Retryability follows the documented status codes: 429 and 500 are worth
 * retrying, 400/401 never are. The distinction is surfaced in the message so
 * an operator reading the log knows whether to act or wait.
 */
function describeFailure(status: number, body: CloudflareEnvelope | null): string | null {
	if (status === 200 && body?.success !== false) {
		const bounced = body?.result?.permanent_bounces ?? [];
		if (bounced.length > 0) return `permanently bounced: ${bounced.join(", ")}`;
		return null;
	}

	const detail =
		(body?.errors ?? [])
			.map((e) => (e.code ? `${e.code}: ${e.message ?? ""}` : (e.message ?? "")))
			.filter(Boolean)
			.join("; ") || `HTTP ${status}`;

	switch (status) {
		case 401:
		case 403:
			return `authentication rejected (${detail}) — check the API token has email sending permission`;
		case 400:
			return `request rejected (${detail}) — check the sender domain is onboarded for Email Sending`;
		case 429:
			return `rate limited (${detail}) — retryable`;
		default:
			return status >= 500 ? `Cloudflare error (${detail}) — retryable` : detail;
	}
}

// ── Delivery ─────────────────────────────────────────────────────────────

/**
 * POST one message to the Cloudflare Email Sending REST API.
 *
 * Note the REST field names differ from the Workers binding: the sender
 * object uses `address` (not `email`) and reply-to is `reply_to` (not
 * `replyTo`). Getting these wrong yields a 400 that reads like a domain
 * problem, so they are easy to misdiagnose.
 */
async function deliver(
	ctx: PluginContext,
	settings: Settings,
	message: {
		to: string;
		subject: string;
		text: string;
		html?: string;
	},
): Promise<void> {
	if (!ctx.http) {
		throw new Error(
			"[cloudflare-email-byo] ctx.http is unavailable — the plugin needs the " +
				"`network:request` capability.",
		);
	}

	const payload: Record<string, unknown> = {
		to: message.to,
		from: settings.fromName
			? { address: settings.fromAddress, name: settings.fromName }
			: { address: settings.fromAddress },
		subject: message.subject,
		text: message.text,
	};
	if (message.html) payload.html = message.html;
	if (settings.replyTo) payload.reply_to = settings.replyTo;

	const response = await ctx.http.fetch(
		`${API_BASE}/accounts/${settings.accountId}/email/sending/send`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${settings.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
	);

	let body: CloudflareEnvelope | null = null;
	try {
		body = (await response.json()) as CloudflareEnvelope;
	} catch {
		// A non-JSON body (gateway error page) leaves body null; the status
		// code alone still produces a usable message.
	}

	const failure = describeFailure(response.status, body);
	if (failure) {
		// Deliberately not logging the payload: `text`/`html` carry magic-link
		// and invite tokens, and the Authorization header carries the owner's
		// API token. Only the recipient and the reason are safe to record.
		throw new Error(`[cloudflare-email-byo] send failed for ${message.to} — ${failure}`);
	}

	ctx.log.info("email delivered via the site's own Cloudflare account", {
		to: message.to,
		subject: message.subject,
		accountId: settings.accountId,
	});
}

// ── Plugin definition ────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			ctx.log.info(
				"Cloudflare Email (own account) installed — add credentials on its settings page, " +
					"then select it under Settings → Email",
			);
		},

		/**
		 * Exclusive: exactly one provider delivers. Throwing here is correct —
		 * the caller (magic link, invite) needs to know the mail did not go out.
		 */
		"email:deliver": {
			exclusive: true,
			handler: async (event, ctx) => {
				const settings = await readSettings(ctx);
				const check = validate(settings);
				if (!check.ok) {
					throw new Error(
						`[cloudflare-email-byo] not configured — missing ${check.missing.join(", ")}. ` +
							"Add them on the plugin's settings page.",
					);
				}
				await deliver(ctx, settings, event.message);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const note = await saveSettings(ctx, interaction.values ?? {});
					return buildSettingsPage(ctx, note);
				}
				if (interaction.type === "block_action" && interaction.action_id === "send_test") {
					return buildSettingsPage(ctx, await sendTest(ctx));
				}
				return { blocks: [] };
			},
		},

		/** Current settings, with the token replaced by a redacted preview. */
		settings: {
			handler: async (_routeCtx, ctx) => {
				const settings = await readSettings(ctx);
				const check = validate(settings);
				return {
					accountId: settings.accountId,
					fromAddress: settings.fromAddress,
					fromName: settings.fromName,
					replyTo: settings.replyTo,
					apiToken: redact(settings.apiToken ?? ""),
					configured: check.ok,
					missing: check.ok ? [] : check.missing,
				};
			},
		},

		"settings/save": {
			handler: async (routeCtx, ctx) => {
				try {
					const note = await saveSettings(ctx, isRecord(routeCtx.input) ? routeCtx.input : {});
					const settings = await readSettings(ctx);
					const check = validate(settings);
					return { success: true, note, configured: check.ok };
				} catch (error) {
					ctx.log.error("Failed to save settings", error);
					return { success: false, error: String(error) };
				}
			},
		},

		test: {
			handler: async (_routeCtx, ctx) => ({ message: await sendTest(ctx) }),
		},
	},
};

export default plugin;

// ── Settings persistence ─────────────────────────────────────────────────

/**
 * Persist only the fields present and usable.
 *
 * The token gets special treatment: Block Kit `secret_input` submits an empty
 * string when the user leaves the field untouched, so writing it blindly
 * would wipe a working credential every time an unrelated field is edited.
 * An empty submission is therefore ignored, and clearing is an explicit
 * action (see the `clear` value below).
 */
async function saveSettings(
	ctx: PluginContext,
	values: Record<string, unknown>,
): Promise<string | undefined> {
	if (typeof values.accountId === "string") {
		await ctx.kv.set(`${KV_PREFIX}accountId`, values.accountId.trim().toLowerCase());
	}
	if (typeof values.fromAddress === "string") {
		await ctx.kv.set(`${KV_PREFIX}fromAddress`, values.fromAddress.trim());
	}
	if (typeof values.fromName === "string") {
		await ctx.kv.set(`${KV_PREFIX}fromName`, values.fromName.trim());
	}
	if (typeof values.replyTo === "string") {
		await ctx.kv.set(`${KV_PREFIX}replyTo`, values.replyTo.trim());
	}

	if (typeof values.apiToken === "string") {
		const token = values.apiToken.trim();
		if (token === "clear") {
			await ctx.kv.set(`${KV_PREFIX}apiToken`, "");
			return "API token cleared.";
		}
		if (token) {
			await ctx.kv.set(`${KV_PREFIX}apiToken`, token);
			return "API token updated.";
		}
	}
	return undefined;
}

/** Send a test message to the sender address itself. */
async function sendTest(ctx: PluginContext): Promise<string> {
	const settings = await readSettings(ctx);
	const check = validate(settings);
	if (!check.ok) return `Cannot send a test — missing ${check.missing.join(", ")}.`;

	try {
		await deliver(ctx, settings, {
			to: settings.fromAddress,
			subject: "Test email from your site",
			text:
				"This is a test from the Cloudflare Email (own account) provider.\n\n" +
				"If you received it, transactional email is sending through your own " +
				"Cloudflare account.",
		});
		return `Test sent to ${settings.fromAddress}.`;
	} catch (error) {
		return String(error instanceof Error ? error.message : error);
	}
}

// ── Block Kit admin page ─────────────────────────────────────────────────

async function buildSettingsPage(ctx: PluginContext, note?: string) {
	try {
		const settings = await readSettings(ctx);
		const check = validate(settings);
		const hasToken = Boolean(settings.apiToken);

		const status = check.ok
			? `Ready — sending as ${settings.fromAddress} from account ${settings.accountId}.`
			: `Not sending yet — missing ${check.missing.join(", ")}.`;

		const blocks: Array<Record<string, unknown>> = [
			{ type: "header", text: "Email from your own Cloudflare account" },
			{
				type: "context",
				text:
					"Transactional email (sign-in links, invites, notifications) is sent " +
					"through your Cloudflare account instead of the platform's.",
			},
			{ type: "divider" },
			{ type: "section", text: status },
		];

		if (note) blocks.push({ type: "context", text: note });

		blocks.push(
			{ type: "divider" },
			{
				type: "form",
				block_id: "cloudflare-email-byo-settings",
				fields: [
					{
						type: "text_input",
						action_id: "accountId",
						label: "Cloudflare account ID",
						placeholder: "32 hex characters, from the dashboard sidebar",
						initial_value: settings.accountId,
					},
					{
						type: "secret_input",
						action_id: "apiToken",
						label: hasToken
							? `API token (stored: ${redact(settings.apiToken ?? "")} — leave blank to keep, type "clear" to remove)`
							: "API token (needs email sending permission)",
					},
					{
						type: "text_input",
						action_id: "fromAddress",
						label: "Send from",
						placeholder: "cms@mail.yourdomain.com",
						initial_value: settings.fromAddress,
					},
					{
						type: "text_input",
						action_id: "fromName",
						label: "Sender name",
						placeholder: "Your Site",
						initial_value: settings.fromName,
					},
					{
						type: "text_input",
						action_id: "replyTo",
						label: "Reply-To (optional)",
						initial_value: settings.replyTo,
					},
				],
				submit: { label: "Save", action_id: "save_settings" },
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: "Send test email",
						action_id: "send_test",
						style: "primary",
					},
				],
			},
			{ type: "divider" },
			{
				type: "context",
				text:
					"The sending domain must be onboarded for Email Sending in your own " +
					"Cloudflare account, and the token needs email sending permission. " +
					"Once saved, choose this provider under Settings → Email.",
			},
		);

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build settings page", error);
		return { blocks: [{ type: "context", text: "Failed to load email settings." }] };
	}
}
