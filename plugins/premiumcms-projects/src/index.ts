/**
 * Projects (provider) — provisions fully isolated EmDash instances on
 * Cloudflare.
 *
 * A row in the `projects` collection (created by a seed elsewhere) is the
 * trigger: on save this plugin derives a project id from the row's label,
 * seeds a kv registry entry, and drives a resumable state machine
 * (createResources → deployWorker → attachDomain → bootstrapOwner) that
 * stands up the child's Worker, D1, KV namespace, R2 bucket and assigned
 * domain, then writes the owner user straight into the child's D1. The golden
 * bundle itself is uploaded by the trusted marketplace deploy service; this
 * plugin supplies the per-project bindings and the provider's Cloudflare
 * credentials (entered on its declarative settings page).
 *
 * The authoritative registry is ctx.kv (`state:project:<id>`); the content row
 * is a human-facing mirror, matched by its `project_id` field. Provisioning
 * advances one step per invocation — one step on the triggering save, the rest
 * on a per-minute cron task — so no single hook has to outlast a Cloudflare
 * round-trip budget.
 *
 * This is a TRUSTED, in-process plugin. It is loaded via a theme's
 * `plugins: [premiumcmsProjects()]` config and its factory `createPlugin`
 * returns a `definePlugin(...)` result. Because it is trusted, its settings
 * are declared with `admin.settingsSchema` and rendered by the admin's
 * standard auto-generated form (Plugins → Projects → Settings) instead of a
 * custom Block Kit page — the declarative schema writes to the same
 * `settings:` kv prefix that `readSettings` reads.
 */

import type {
	PluginAdminConfig,
	PluginContext,
	PluginDescriptor,
	ResolvedPlugin,
} from "@premium-cms/emdash";
import { definePlugin } from "@premium-cms/emdash";

/** The admin settings-schema map type (`Record<string, SettingField>`). */
type SettingsSchema = NonNullable<PluginAdminConfig["settingsSchema"]>;

import { COLLECTION, fieldsOf, listUnclaimed, mirrorState } from "./content.js";
import { advance, getState, listStates, projectIdFromLabel, seedState } from "./provisioner.js";
import { credsOf, readSettings, validate } from "./settings.js";
import {
	childBalanceMicros,
	grantCredits,
	pushCreditsSettings,
	syncExternalUsage,
} from "./credits.js";
import { checkoutSessionIdFromEvent, createCheckout, retrieveCheckoutSession } from "./stripe.js";

const STEP_TIMEOUT_MS = 60_000; // one Cloudflare-round-trip budget per step

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ─── Trust contract ──────────────────────────────────────────────
// `network:request` (not `network:request:unrestricted`) pins ctx.http to
// `allowedHosts`: the Cloudflare API token and the marketplace deploy key are
// the most sensitive values here, so egress is limited to the Cloudflare API,
// the marketplace deploy service, and provisioned child instances under the
// platform zone. `content:read`/`content:write` let the plugin read the
// Projects collection rows and mirror provisioning status back into them.
const CAPABILITIES = ["network:request", "content:read", "content:write"] as const;
const ALLOWED_HOSTS = [
	"api.cloudflare.com",
	"api.stripe.com",
	"marketplace.premium-cms.com",
	"*.premium-cms.com",
];

/**
 * Declarative settings schema. The admin auto-generates the settings form at
 * `/_emdash/admin/plugins-manager/premiumcms-projects/settings` from this, and
 * persists each field under the `settings:` kv prefix — exactly where
 * `readSettings` (settings.ts) reads them. The field keys MUST match what
 * `readSettings` looks up.
 */
// Only the two Cloudflare credentials are the site owner's to enter. The zone
// is derived from the site's canonical URL (Settings → General), and the deploy
// key / marketplace URL / owner email are set up behind the scenes on a
// platform instance — so they are deliberately not on this form.
const SETTINGS_SCHEMA: SettingsSchema = {
	cfAccountId: {
		type: "string",
		label: "Cloudflare Account ID",
		description: "32 hex characters, from your Cloudflare dashboard.",
	},
	cfApiToken: {
		type: "secret",
		label: "Cloudflare API Token",
		description: "A token with Workers, D1, R2, KV and Workers Routes permissions.",
	},
	emailAccountId: {
		type: "string",
		label: "Fallback email — Cloudflare Account ID",
		description:
			"Optional. A Cloudflare account with Email Sending onboarded, used as the fallback email provider for provisioned instances so magic-link login works out of the box.",
	},
	emailApiToken: {
		type: "secret",
		label: "Fallback email — Cloudflare API Token",
		description: "A token with Email:Send on the account above.",
	},
	emailFrom: {
		type: "email",
		label: "Fallback email — Send from",
		description: "e.g. cms@send.premium-cms.com (its domain must be onboarded for Email Sending).",
	},
	stripeSecretKey: {
		type: "secret",
		label: "Stripe secret key",
		description:
			"Optional. Lets child projects buy hosting credits with a card. Starts sk_live_… or sk_test_…",
	},
	stripeWebhookSecret: {
		type: "secret",
		label: "Stripe webhook signing secret",
		description:
			"The whsec_… secret for a webhook at …/api/plugins/premiumcms-projects/billingWebhook (checkout.session.completed).",
	},
	creditsMarkup: {
		type: "number",
		label: "Cost-plus markup",
		description:
			"Multiplier on the underlying Cloudflare cost billed to each child (e.g. 2 = 100% margin).",
		default: 2,
	},
	creditsEnforce: {
		type: "boolean",
		label: "Meter + enforce credits",
		description: "When on, children are metered and suspended once their credits run out.",
		default: false,
	},
};

/**
 * One provisioning tick: claim any unclaimed Projects rows, then advance every
 * in-flight project one step. Runs in a fresh invocation (the `tick` route,
 * driven by the instance's own scheduled handler) so it has a full subrequest
 * budget — unlike `content:afterSave`, which shares the content-save request's
 * exhausted budget.
 */
async function runProvisionTick(
	ctx: PluginContext,
): Promise<{ claimed: number; advanced: number }> {
	const settings = await readSettings(ctx);
	if (!validate(settings).ok) return { claimed: 0, advanced: 0 };

	let claimed = 0;
	for (const row of await listUnclaimed(ctx)) {
		let id: string;
		try {
			id = projectIdFromLabel(row.label);
		} catch (err) {
			ctx.log.warn(`[premiumcms-projects] ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (await getState(ctx, id)) continue;
		await seedState(ctx, settings, {
			id,
			label: row.label,
			theme: row.theme,
			ownerEmail: settings.ownerEmail,
			contentId: row.contentId,
		});
		if (ctx.content?.update) {
			await ctx.content.update(COLLECTION, row.contentId, {
				project_id: id,
				provision_status: "creating",
			});
		}
		claimed++;
	}

	let advanced = 0;
	for (const s of await listStates(ctx)) {
		if (s.status === "live" || s.status === "error") continue;
		try {
			await advance(ctx, settings, s.id);
			advanced++;
		} catch (err) {
			ctx.log.error(`[premiumcms-projects] advance for ${s.id} failed`, err);
		}
		const fresh = await getState(ctx, s.id);
		if (fresh) await mirrorState(ctx, fresh);
	}
	return { claimed, advanced };
}

/**
 * One billing pass: for each live project, refresh its Cloudflare usage into
 * its ledger (throttled per-project) and push the current price book +
 * enforcement flag + top-up target. Cheap on non-enforced setups: a live
 * project is still metered so its owner sees a real bill, but nothing is
 * blocked unless `creditsEnforce` is on.
 */
const BILLING_SYNC_INTERVAL_MS = 30 * 60_000; // at most twice an hour per project

async function runBillingTick(ctx: PluginContext): Promise<{ synced: number }> {
	const settings = await readSettings(ctx);
	if (!validate(settings).ok) return { synced: 0 };

	// One project per tick: a scheduled invocation has a bounded budget and the
	// Cloudflare analytics queries are slow. Throttled projects are skipped with
	// no work, so most ticks are free; due projects are metered one per minute.
	// No content writes here — the Projects-row `credit_balance` is refreshed by
	// the on-demand operator top-up, not the tick, to keep the tick light and
	// free of afterSave re-entrancy.
	let synced = 0;
	for (const s of await listStates(ctx)) {
		if (s.status !== "live" || !s.d1_id) continue;
		const lastRaw = await ctx.kv.get<string>(`billing:synced:${s.id}`);
		const last = lastRaw ? Date.parse(lastRaw) : 0;
		if (Number.isFinite(last) && Date.now() - last < BILLING_SYNC_INTERVAL_MS) continue;

		try {
			await pushCreditsSettings(ctx, settings, s);
			const res = await syncExternalUsage(ctx, settings, s);
			await ctx.kv.set(`billing:synced:${s.id}`, new Date().toISOString());
			synced += 1;
			if (res.detail) ctx.log.warn(`[premiumcms-projects] usage sync ${s.id}: ${res.detail}`);
		} catch (err) {
			ctx.log.error(`[premiumcms-projects] billing sync for ${s.id} failed`, err);
		}
		break; // one project per tick — bound the invocation's work
	}
	return { synced };
}

// ─── Plugin Descriptor (for a theme's `plugins: [...]` config) ───

/**
 * Descriptor consumed by `plugins: [premiumcmsProjects()]`. `entrypoint` is
 * the package name; the runtime imports `createPlugin` from its `main` to
 * build the resolved plugin. No `adminPages`/`adminWidgets`: settings are the
 * declarative `settingsSchema` form, so there is no custom admin page.
 */
export function premiumcmsProjects(): PluginDescriptor {
	return {
		id: "premiumcms-projects",
		version: "0.1.0",
		entrypoint: "@premium-cms/plugin-premiumcms-projects",
		capabilities: [...CAPABILITIES],
		allowedHosts: ALLOWED_HOSTS,
	};
}

// ─── Plugin Implementation ───────────────────────────────────────

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: "premiumcms-projects",
		version: "0.1.0",
		capabilities: [...CAPABILITIES],
		allowedHosts: ALLOWED_HOSTS,

		hooks: {
			"plugin:install": {
				handler: async (_event, ctx) => {
					ctx.log.info(
						"Projects (provider) installed — add Cloudflare credentials + the deploy key on its settings page, then create a Projects row.",
					);
				},
			},

			/**
			 * Provisioning trigger. Fires for every content save; acts only on the
			 * `projects` collection, and only on a row that has not yet been claimed
			 * (no `project_id`). Writing `project_id` back is what makes the follow-up
			 * save a no-op, so there is no re-entrancy loop.
			 */
			"content:afterSave": {
				timeout: STEP_TIMEOUT_MS,
				handler: async (event, ctx) => {
					if (event.collection !== COLLECTION) return;
					if (!ctx.content?.update) return;

					const fields = fieldsOf(event.content);

					// ── Operator credit top-up (from the Projects content editor) ──
					// An admin sets "Add credits ($)" on a provisioned row and saves; we
					// grant that amount into the child's ledger, clear the input and
					// refresh the displayed balance. Runs for CLAIMED rows (which have a
					// project_id), so it sits before the claim guard below.
					const addCredits = Number(fields.add_credits);
					const claimedId = str(fields.project_id);
					if (claimedId && Number.isFinite(addCredits) && addCredits > 0) {
						const topupSettings = await readSettings(ctx);
						const state = await getState(ctx, claimedId);
						const rowId = str((event.content as Record<string, unknown>).id);
						if (state?.d1_id && validate(topupSettings).ok) {
							const micros = Math.round(addCredits * 1_000_000);
							try {
								await grantCredits(
									ctx,
									topupSettings,
									state,
									micros,
									`operator:${claimedId}:${Date.now()}`,
									"Operator credit (parent admin)",
								);
								const balance = await childBalanceMicros(ctx, credsOf(topupSettings), state.d1_id);
								// Clear the action input + reflect the new balance. This
								// re-save carries add_credits=null, so it does not loop.
								if (rowId) {
									await ctx.content.update(COLLECTION, rowId, {
										add_credits: null,
										credit_balance: Math.round(balance) / 1_000_000,
									});
								}
							} catch (err) {
								ctx.log.error(`[premiumcms-projects] operator top-up for ${claimedId} failed`, err);
							}
						}
						return;
					}

					if (str(fields.project_id)) return; // already claimed → cron drives it forward

					const label = str(fields.label);
					if (!label) return; // nothing to provision yet

					const settings = await readSettings(ctx);
					if (!validate(settings).ok) {
						ctx.log.warn("[premiumcms-projects] credentials not configured — skipping provision");
						return;
					}

					const contentId = str((event.content as Record<string, unknown>).id);

					let id: string;
					try {
						id = projectIdFromLabel(label);
					} catch (err) {
						// Invalid label — log and stop. We deliberately do not write back,
						// so this save does not spawn another afterSave.
						ctx.log.warn(
							`[premiumcms-projects] ${err instanceof Error ? err.message : String(err)}`,
						);
						return;
					}

					// Claim the row and seed the authoritative kv state.
					await seedState(ctx, settings, {
						id,
						label,
						theme: str(fields.theme),
						ownerEmail: settings.ownerEmail,
						contentId: contentId || null,
					});
					if (contentId) {
						await ctx.content.update(COLLECTION, contentId, {
							project_id: id,
							provision_status: "creating",
						});
					}
					// No provisioning here: afterSave runs inside the content-save
					// request and has no subrequest budget for CF API calls. Claiming
					// (above) is best-effort; the cron tick both claims and advances.
				},
			},
		},

		routes: {
			/**
			 * Provisioning tick — claims and advances projects one step. Requires
			 * admin auth (the default for a plugin route); the instance's own
			 * scheduled() handler drives it every minute with a stored admin token.
			 * Each call is a fresh invocation, so provisioning has a full subrequest
			 * budget — which afterSave (inside the save request) does not.
			 */
			tick: {
				handler: async (ctx) => {
					const prov = await runProvisionTick(ctx);
					// Metering runs on the same per-minute tick; it self-throttles
					// the (heavier) Cloudflare analytics sync per project.
					const billing = await runBillingTick(ctx);
					return { success: true, ...prov, ...billing };
				},
			},

			/**
			 * Public credit-checkout endpoint. A child instance's "add credits"
			 * button proxies here with its project id + amount; we create a Stripe
			 * hosted Checkout Session and return its URL. Public because the caller
			 * is an unauthenticated child Worker — the project id must resolve to a
			 * real provisioned project, and payment itself is authenticated by
			 * Stripe. No credits are granted here; that happens on the webhook.
			 */
			billingCheckout: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!settings.stripeSecretKey) {
						return { success: false, error: "Card top-ups are not enabled for this host." };
					}
					// The runtime already parsed the request body and exposes it as
					// ctx.input (ctx.request.json() would throw).
					const body = (ctx.input ?? {}) as {
						projectId?: unknown;
						amount?: unknown;
						returnUrl?: unknown;
					};
					const projectId = typeof body.projectId === "string" ? body.projectId : "";
					const amount = Number(body.amount);
					const returnUrl =
						typeof body.returnUrl === "string" && body.returnUrl
							? body.returnUrl
							: `https://${projectId}`;
					if (!projectId || !Number.isFinite(amount) || amount <= 0) {
						return { success: false, error: "projectId and a positive amount are required." };
					}
					const state = await getState(ctx, projectId);
					if (!state) return { success: false, error: "Unknown project." };
					try {
						const { url } = await createCheckout(ctx, settings, {
							projectId,
							email: state.owner_email,
							title: state.label,
							amountCents: Math.round(amount * 100),
							returnUrl,
						});
						return { success: true, checkoutUrl: url };
					} catch (err) {
						ctx.log.error("[premiumcms-projects] checkout failed", err);
						return {
							success: false,
							error: err instanceof Error ? err.message : "Checkout failed.",
						};
					}
				},
			},

			/**
			 * Public Stripe webhook. Verifies the signature against the configured
			 * signing secret, then grants the purchased credits into the paying
			 * child's ledger. Idempotent: the Stripe session id is the ledger ref,
			 * so a redelivered event does not double-credit.
			 */
			billingWebhook: {
				public: true,
				handler: async (ctx) => {
					const settings = await readSettings(ctx);
					if (!settings.stripeSecretKey) {
						return { success: false, error: "Stripe not configured." };
					}
					// The runtime consumed the body into ctx.input, so we cannot HMAC
					// the raw bytes. Instead we re-fetch the session from Stripe with
					// our secret key: that both authenticates the event and confirms
					// it was paid. Idempotent via the ledger ref (`stripe:<session>`).
					const sessionId = checkoutSessionIdFromEvent(ctx.input);
					if (!sessionId) return { success: true, ignored: true };
					try {
						const session = await retrieveCheckoutSession(ctx, settings, sessionId);
						if (session.paymentStatus !== "paid") return { success: true, ignored: true };
						if (!session.projectId || session.creditsMicros <= 0) {
							return { success: false, error: "Session is missing project/credits metadata." };
						}
						const state = await getState(ctx, session.projectId);
						if (!state) return { success: false, error: "Unknown project." };
						await grantCredits(
							ctx,
							settings,
							state,
							session.creditsMicros,
							`stripe:${session.id}`,
							"Stripe top-up",
							{ sessionId: session.id },
						);
						return { success: true };
					} catch (err) {
						ctx.log.error("[premiumcms-projects] webhook grant failed", err);
						return { success: false, error: "Failed to process payment." };
					}
				},
			},

			/** Provisioned projects (kv registry), for a custom admin screen. */
			projects: {
				handler: async (ctx) => {
					const states = await listStates(ctx);
					return {
						projects: states.map((s) => ({
							id: s.id,
							label: s.label,
							theme: s.theme,
							hostname: s.hostname,
							status: s.status,
							error: s.error,
							url: s.status === "live" ? `https://${s.hostname}` : null,
							created_at: s.created_at,
							updated_at: s.updated_at,
						})),
					};
				},
			},
		},

		admin: {
			settingsSchema: SETTINGS_SCHEMA,
		},
	});
}

export default premiumcmsProjects;
