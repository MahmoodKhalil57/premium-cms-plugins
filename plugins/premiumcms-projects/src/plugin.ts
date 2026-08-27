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
 * credentials (entered on its settings page).
 *
 * The authoritative registry is ctx.kv (`state:project:<id>`); the content row
 * is a human-facing mirror, matched by its `project_id` field. Provisioning
 * advances one step per invocation — one step on the triggering save, the rest
 * on a per-minute cron task — so no single hook has to outlast a Cloudflare
 * round-trip budget.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";
import { COLLECTION, fieldsOf, listUnclaimed, mirrorState } from "./content.js";
import { advance, getState, listStates, projectIdFromLabel, seedState } from "./provisioner.js";
import { readSettings, redact, saveSettings, validate } from "./settings.js";
import { adminHandler } from "./admin.js";

const STEP_TIMEOUT_MS = 60_000; // one Cloudflare-round-trip budget per step

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * One provisioning tick: claim any unclaimed Projects rows, then advance every
 * in-flight project one step. Runs in a fresh invocation (the `tick` route,
 * driven by the instance's own scheduled handler) so it has a full subrequest
 * budget — unlike `content:afterSave`, which shares the content-save request's
 * exhausted budget, and unlike a sandboxed cron hook, which the host does not
 * register.
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

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			ctx.log.info(
				"Projects (provider) installed — add Cloudflare credentials + the deploy key on its settings page, then create a Projects row.",
			);
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
					ctx.log.warn(`[premiumcms-projects] ${err instanceof Error ? err.message : String(err)}`);
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
		admin: {
			handler: adminHandler,
		},

		/**
		 * Provisioning tick — claims and advances projects one step. Requires
		 * admin auth (the default for a plugin route); the instance's own
		 * scheduled() handler drives it every minute with a stored admin token.
		 * Each call is a fresh invocation, so provisioning has a full subrequest
		 * budget — which afterSave (inside the save request) and a sandboxed
		 * cron hook (never registered by the host) do not.
		 */
		tick: {
			handler: async (_routeCtx, ctx) => {
				const result = await runProvisionTick(ctx);
				return { success: true, ...result };
			},
		},

		/** Current settings, with secrets replaced by redacted previews. */
		settings: {
			handler: async (_routeCtx, ctx) => {
				const settings = await readSettings(ctx);
				const check = validate(settings);
				return {
					cfAccountId: settings.cfAccountId,
					zone: settings.zone,
					marketplaceUrl: settings.marketplaceUrl,
					ownerEmail: settings.ownerEmail,
					cfApiToken: redact(settings.cfApiToken),
					deployKey: redact(settings.deployKey),
					configured: check.ok,
					missing: check.ok ? [] : check.missing,
				};
			},
		},

		"settings/save": {
			handler: async (routeCtx, ctx) => {
				try {
					const input = routeCtx.input;
					const values =
						input && typeof input === "object" ? (input as Record<string, unknown>) : {};
					const note = await saveSettings(ctx, values);
					const settings = await readSettings(ctx);
					return { success: true, note, configured: validate(settings).ok };
				} catch (error) {
					ctx.log.error("Failed to save settings", error);
					return { success: false, error: String(error) };
				}
			},
		},

		/** Provisioned projects (kv registry), for a custom admin screen. */
		projects: {
			handler: async (_routeCtx, ctx) => {
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
};

export default plugin;
