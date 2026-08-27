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
import { readSettings, validate } from "./settings.js";

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
const ALLOWED_HOSTS = ["api.cloudflare.com", "marketplace.premium-cms.com", "*.premium-cms.com"];

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
				handler: async (ctx) => ({ success: true, ...(await runProvisionTick(ctx)) }),
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
