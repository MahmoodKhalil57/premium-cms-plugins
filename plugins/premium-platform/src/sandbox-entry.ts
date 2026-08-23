/** premium-platform — sandbox entry. Capabilities/storage/admin live in manifest.json. */

import { adminHandler } from "./admin.js";
import { invalidateEnv } from "./env.js";
import {
	billingEvent,
	bundlesList,
	childCredits,
	childDomain,
	childGithub,
	oauthGithubCallback,
	oauthGithubSetup,
	oauthGithubStart,
	accountCredits,
	meProjectCreate,
	meProjectStep,
	meProjects,
	pricing,
	billingOverview,
	projectCreate,
	projectCreateFree,
	projectsListAll,
	projectCredits,
	projectDeploy,
	projectDestroy,
	projectDomain,
	projectDomains,
	projectEmailDomain,
	projectSeed,
	projectSetup,
	projectSiteDomain,
	projectsList,
	registryImport,
	fleetExport,
} from "./handlers.js";
import { definePlugin, route, type PluginContext, type RouteContext } from "./shim.js";
import { v } from "./validate.js";

const id = v.string({ min: 1, max: 64 });
const withId = v.object({ id });
const createSchema = v.object({ id, adminEmail: v.string({ min: 3, max: 200 }), siteTitle: v.string({ min: 1, max: 200 }), tagline: v.string({ max: 300 }).optional(), ownerEmail: v.string({ max: 200 }).optional() });
const accountCreditsSchema = v.object({ op: v.string({ max: 20 }).optional(), amountCents: v.number({ int: true, min: 0 }).optional(), sessionId: v.string({ max: 200 }).optional(), origin: v.string({ max: 200 }).optional() });
const billingSchema = v.object({ op: v.string({ max: 20 }).optional(), userId: v.string({ max: 64 }).optional(), email: v.string({ max: 200 }).optional(), cents: v.number({ int: true }).optional(), note: v.string({ max: 200 }).optional() });
const deploySchema = v.object({ id, version: v.string({ max: 40 }).optional() });
const backupSchema = v.object({ id, note: v.string({ max: 200 }).optional() });
const backupKeySchema = v.object({ id, key: v.string({ min: 1, max: 300 }), confirm: v.boolean().optional() });
const domainSchema = v.object({ id, domain: v.string({ min: 4, max: 253 }) });
const creditsSchema = v.object({ id, op: v.string({ max: 40 }).optional(), cents: v.string({ max: 20 }).optional(), note: v.string({ max: 200 }).optional(), days: v.string({ max: 20 }).optional() });

function validated<TIn, TOut>(schema: { parse(x: unknown): TIn }, handler: (ctx: RouteContext<TIn>) => Promise<TOut>) {
	return route<unknown, TOut>(async (ctx) => {
		let input: TIn;
		try {
			input = schema.parse(ctx.input ?? {});
		} catch (err) {
			throw new Error(`Invalid input: ${err instanceof Error ? err.message : "validation failed"}`);
		}
		return handler({ ...ctx, input } as RouteContext<TIn>);
	});
}

import { fleetDemos, fleetSync } from "./handlers.js";
import { backupsNightly, projectBackup, projectBackupDelete, projectBackups, projectRestore } from "./backups.js";

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				invalidateEnv();
				if (ctx.cron) await ctx.cron.schedule("backups-nightly", { schedule: "10 3 * * *" }).catch(() => {});
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "backups-nightly") await backupsNightly(ctx);
			},
		},
	},
	routes: {
		admin: { handler: route(adminHandler as never) },
		"projects/list": { handler: route(projectsList as never) },
		"projects/create": { handler: validated(createSchema, projectCreate as never) },
		"projects/create-free": { handler: validated(createSchema, projectCreateFree as never) },
		"projects/list-all": { handler: route(projectsListAll as never) },
		"account/credits": { handler: validated(accountCreditsSchema, accountCredits as never) },
		pricing: { public: true, handler: route(pricing as never) },
		"me/credits": { session: true, handler: validated(accountCreditsSchema, accountCredits as never) },
		"me/projects": { session: true, handler: route(meProjects as never) },
		"me/projects/create": { session: true, handler: validated(v.object({ id, adminEmail: v.string({ max: 200 }).default(""), siteTitle: v.string({ min: 1, max: 200 }), tagline: v.string({ max: 300 }).optional() }), meProjectCreate as never) },
		"me/projects/step": { session: true, handler: validated(v.object({ id, step: v.enumOf(["deploy", "domain", "setup", "destroy"] as const) }), meProjectStep as never) },
		"billing/overview": { handler: validated(billingSchema, billingOverview as never) },
		"projects/deploy": { handler: validated(deploySchema, projectDeploy as never) },
		"projects/domain": { handler: validated(withId, projectDomain as never) },
		"projects/setup": { handler: validated(withId, projectSetup as never) },
		"projects/seed": { handler: validated(withId, projectSeed as never) },
		"projects/destroy": { handler: validated(withId, projectDestroy as never) },
		"projects/domains": { handler: validated(withId, projectDomains as never) },
		"projects/site-domain": { handler: validated(domainSchema, projectSiteDomain as never) },
		"projects/email-domain": { handler: validated(domainSchema, projectEmailDomain as never) },
		bundles: { handler: route(bundlesList as never) },
		"registry/import": { handler: route(registryImport as never) },
		"child/github": { public: true, handler: route(childGithub as never) },
		"child/domain": { public: true, handler: route(childDomain as never) },
		"child/credits": { public: true, handler: route(childCredits as never) },
		"billing/event": { public: true, handler: route(billingEvent as never) },
		"fleet/sync": { public: true, handler: route(fleetSync as never) },
		"fleet/demos": { public: true, handler: route(fleetDemos as never) },
		"fleet/export": { public: true, handler: route(fleetExport as never) },
		"projects/backup": { handler: validated(backupSchema, projectBackup as never) },
		"projects/backups": { handler: validated(withId, projectBackups as never) },
		"projects/backup-delete": { handler: validated(backupKeySchema, projectBackupDelete as never) },
		"projects/restore": { handler: validated(backupKeySchema, projectRestore as never) },
		"projects/credits": { handler: validated(creditsSchema, projectCredits as never) },
		"oauth/github/start": { public: true, handler: route(oauthGithubStart as never) },
		"oauth/github/setup": { public: true, handler: route(oauthGithubSetup as never) },
		"oauth/github/callback": { public: true, handler: route(oauthGithubCallback as never) },
	},
});
