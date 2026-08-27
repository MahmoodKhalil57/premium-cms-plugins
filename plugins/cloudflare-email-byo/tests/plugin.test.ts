/**
 * Tests run the plugin object directly against a stubbed context. The HTTP
 * stub records what was sent, so the REST contract (field names, auth header,
 * endpoint) is asserted rather than assumed — those are exactly the details
 * that fail as a confusing 400 in production.
 */

import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

type Captured = { url: string; init: RequestInit };

function makeTestContext(
	settings: Record<string, unknown> = {},
	httpResponse: { status: number; body: unknown } = {
		status: 200,
		body: { success: true, result: { delivered: ["to@example.com"], permanent_bounces: [] } },
	},
) {
	const kv = new Map<string, unknown>(
		Object.entries(settings).map(([k, v]) => [`settings:${k}`, v]),
	);
	const captured: Captured[] = [];
	const logs: Array<{ level: string; message: string; data?: unknown }> = [];

	const ctx = {
		plugin: { id: "cloudflare-email-byo", version: "0.1.0" },
		storage: {},
		kv: {
			get: async <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null),
			set: async (k: string, v: unknown) => {
				kv.set(k, v);
			},
			delete: async (k: string) => kv.delete(k),
			list: async (prefix = "") =>
				[...kv.entries()]
					.filter(([k]) => k.startsWith(prefix))
					.map(([key, value]) => ({ key, value })),
		},
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				captured.push({ url, init: init ?? {} });
				return {
					status: httpResponse.status,
					json: async () => httpResponse.body,
				} as unknown as Response;
			},
		},
		log: {
			info: (m: string, d?: unknown) => logs.push({ level: "info", message: m, data: d }),
			warn: (m: string) => logs.push({ level: "warn", message: m }),
			error: (m: string) => logs.push({ level: "error", message: m }),
			debug: () => {},
		},
	} as unknown as import("@premium-cms/emdash").PluginContext;

	return { ctx, kv, captured, logs };
}

const GOOD = {
	accountId: "0123456789abcdef0123456789abcdef",
	apiToken: "cf-token-value",
	fromAddress: "cms@mail.example.com",
	fromName: "Example",
};

async function callDeliver(
	ctx: import("@premium-cms/emdash").PluginContext,
	message?: Partial<{
		to: string;
		subject: string;
		text: string;
		html: string;
	}>,
) {
	const hook = plugin.hooks?.["email:deliver"];
	if (!hook || typeof hook !== "object" || !("handler" in hook)) throw new Error("no hook");
	return hook.handler(
		{
			message: {
				to: "to@example.com",
				subject: "Hi",
				text: "body",
				...message,
			},
			source: "test",
		} as never,
		ctx,
	);
}

async function callAdmin(ctx: import("@premium-cms/emdash").PluginContext, input: unknown) {
	const route = plugin.routes?.admin;
	if (!route || typeof route !== "object" || !("handler" in route)) throw new Error("no route");
	return (await route.handler({ input } as never, ctx)) as {
		blocks: Array<Record<string, unknown>>;
	};
}

async function callRoute(
	ctx: import("@premium-cms/emdash").PluginContext,
	name: string,
	input: unknown = {},
) {
	const route = plugin.routes?.[name];
	if (!route || typeof route !== "object" || !("handler" in route)) throw new Error("no route");
	return route.handler({ input } as never, ctx);
}

// ── Registration ─────────────────────────────────────────────────────────

describe("hook registration", () => {
	it("registers email:deliver as exclusive", () => {
		const hook = plugin.hooks?.["email:deliver"];
		expect(hook).toBeTypeOf("object");
		expect((hook as { exclusive?: boolean }).exclusive).toBe(true);
	});
});

// ── Delivery ─────────────────────────────────────────────────────────────

describe("email:deliver", () => {
	it("posts to the owner's account with the REST field names", async () => {
		const { ctx, captured } = makeTestContext(GOOD);
		await callDeliver(ctx, { html: "<p>body</p>" });

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${GOOD.accountId}/email/sending/send`,
		);

		const headers = captured[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${GOOD.apiToken}`);

		const body = JSON.parse(String(captured[0].init.body));
		// REST uses `address`, NOT `email` as the Workers binding does.
		expect(body.from).toEqual({ address: GOOD.fromAddress, name: GOOD.fromName });
		expect(body.from.email).toBeUndefined();
		expect(body.to).toBe("to@example.com");
		expect(body.html).toBe("<p>body</p>");
	});

	it("uses snake_case reply_to and omits it when unset", async () => {
		const withReply = makeTestContext({ ...GOOD, replyTo: "hi@example.com" });
		await callDeliver(withReply.ctx);
		const a = JSON.parse(String(withReply.captured[0].init.body));
		expect(a.reply_to).toBe("hi@example.com");
		expect(a.replyTo).toBeUndefined();

		const without = makeTestContext(GOOD);
		await callDeliver(without.ctx);
		expect("reply_to" in JSON.parse(String(without.captured[0].init.body))).toBe(false);
	});

	it("omits the sender name when it is not set", async () => {
		const { ctx, captured } = makeTestContext({ ...GOOD, fromName: "" });
		await callDeliver(ctx);
		expect(JSON.parse(String(captured[0].init.body)).from).toEqual({
			address: GOOD.fromAddress,
		});
	});

	it("throws, and sends nothing, when unconfigured", async () => {
		const { ctx, captured } = makeTestContext({});
		await expect(callDeliver(ctx)).rejects.toThrow(/not configured/i);
		expect(captured).toHaveLength(0);
	});

	it("rejects a malformed account ID before making a request", async () => {
		const { ctx, captured } = makeTestContext({ ...GOOD, accountId: "not-an-account" });
		await expect(callDeliver(ctx)).rejects.toThrow(/account ID/i);
		expect(captured).toHaveLength(0);
	});

	it("surfaces an auth failure as an actionable error", async () => {
		const { ctx } = makeTestContext(GOOD, {
			status: 401,
			body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
		});
		await expect(callDeliver(ctx)).rejects.toThrow(/email sending permission/i);
	});

	it("marks rate limiting as retryable", async () => {
		const { ctx } = makeTestContext(GOOD, {
			status: 429,
			body: { success: false, errors: [{ code: 10000, message: "Too many requests" }] },
		});
		await expect(callDeliver(ctx)).rejects.toThrow(/retryable/i);
	});

	it("treats a permanent bounce as a failure even on HTTP 200", async () => {
		const { ctx } = makeTestContext(GOOD, {
			status: 200,
			body: { success: true, result: { delivered: [], permanent_bounces: ["to@example.com"] } },
		});
		await expect(callDeliver(ctx)).rejects.toThrow(/bounced/i);
	});

	it("never logs the API token or the message body", async () => {
		const { ctx, logs } = makeTestContext(GOOD);
		await callDeliver(ctx, { text: "secret-magic-link-token", html: "<a>secret</a>" });
		const dump = JSON.stringify(logs);
		expect(dump).not.toContain(GOOD.apiToken);
		expect(dump).not.toContain("secret-magic-link-token");
	});
});

// ── Settings ─────────────────────────────────────────────────────────────

describe("settings", () => {
	it("never returns the raw token", async () => {
		const { ctx } = makeTestContext(GOOD);
		const result = (await callRoute(ctx, "settings")) as Record<string, unknown>;
		expect(result.apiToken).not.toBe(GOOD.apiToken);
		expect(String(result.apiToken)).toContain("•");
		expect(result.configured).toBe(true);
	});

	it("reports what is missing when unconfigured", async () => {
		const { ctx } = makeTestContext({});
		const result = (await callRoute(ctx, "settings")) as { configured: boolean; missing: string[] };
		expect(result.configured).toBe(false);
		expect(result.missing.length).toBeGreaterThan(0);
	});

	it("keeps the stored token when the secret field is submitted empty", async () => {
		// Block Kit secret_input submits "" for an untouched field — writing
		// that blindly would wipe a working credential on every save.
		const { ctx, kv } = makeTestContext(GOOD);
		await callAdmin(ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { fromName: "Renamed", apiToken: "" },
		});
		expect(kv.get("settings:apiToken")).toBe(GOOD.apiToken);
		expect(kv.get("settings:fromName")).toBe("Renamed");
	});

	it('clears the token only on an explicit "clear"', async () => {
		const { ctx, kv } = makeTestContext(GOOD);
		await callAdmin(ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { apiToken: "clear" },
		});
		expect(kv.get("settings:apiToken")).toBe("");
	});

	it("normalises the account ID", async () => {
		const { ctx, kv } = makeTestContext({});
		await callAdmin(ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { accountId: "  0123456789ABCDEF0123456789ABCDEF  " },
		});
		expect(kv.get("settings:accountId")).toBe("0123456789abcdef0123456789abcdef");
	});
});

// ── Admin page ───────────────────────────────────────────────────────────

describe("admin page", () => {
	it("renders a form and never leaks the token into the blocks", async () => {
		const { ctx } = makeTestContext(GOOD);
		const result = await callAdmin(ctx, { type: "page_load", page: "/settings" });
		expect(result.blocks.map((b) => b.type)).toContain("form");
		expect(JSON.stringify(result.blocks)).not.toContain(GOOD.apiToken);
	});

	it("says what is missing when unconfigured", async () => {
		const { ctx } = makeTestContext({});
		const result = await callAdmin(ctx, { type: "page_load", page: "/settings" });
		expect(JSON.stringify(result.blocks)).toMatch(/Not sending yet/i);
	});

	it("reports the outcome of a test send", async () => {
		const { ctx } = makeTestContext(GOOD);
		const result = await callAdmin(ctx, { type: "block_action", action_id: "send_test" });
		expect(JSON.stringify(result.blocks)).toContain("Test sent");
	});

	it("returns no blocks for an unknown interaction", async () => {
		const { ctx } = makeTestContext(GOOD);
		expect(await callAdmin(ctx, { type: "nonsense" })).toEqual({ blocks: [] });
	});
});
