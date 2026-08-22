/**
 * premium-forms — sandbox entry (runs in the plugin isolate).
 * Capabilities, storage and admin metadata live in manifest.json.
 */
import { adminHandler } from "./admin.js";
import { handleCleanup, handleDigest } from "./handlers/cron.js";
import { formsCreateHandler, formsDeleteHandler, formsDuplicateHandler, formsListHandler, formsUpdateHandler } from "./handlers/forms.js";
import { exportHandler, submissionDeleteHandler, submissionGetHandler, submissionsListHandler, submissionUpdateHandler } from "./handlers/submissions.js";
import { definitionHandler, submitHandler } from "./handlers/submit.js";
import {
	definitionSchema,
	exportSchema,
	formCreateSchema,
	formDeleteSchema,
	formDuplicateSchema,
	formUpdateSchema,
	submissionDeleteSchema,
	submissionGetSchema,
	submissionsListSchema,
	submissionUpdateSchema,
	submitSchema,
} from "./schemas.js";
import { definePlugin, route, type PluginContext, type RouteContext } from "./shim.js";
import manifest from "../manifest.json";

/** Validate ctx.input with a zod schema inside the isolate, then run the handler. */
function validated<TIn, TOut>(schema: { parse(v: unknown): TIn }, handler: (ctx: RouteContext<TIn>) => Promise<TOut>) {
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

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				if (ctx.cron) await ctx.cron.schedule("cleanup", { schedule: "@weekly" }).catch(() => {});
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "cleanup") await handleCleanup(ctx as never);
				else if (event.name.startsWith("digest:")) await handleDigest(event.name.slice("digest:".length), ctx as never);
			},
		},
	},
	routes: {
		submit: { public: true, handler: validated(submitSchema, submitHandler as never) },
		// `pluginVersion` lets the frontend (and ops) see which bundle an isolate serves.
		definition: {
			public: true,
			handler: validated(definitionSchema, (async (ctx: never) => ({
				...(await definitionHandler(ctx)),
				pluginVersion: manifest.version,
			})) as never),
		},
		admin: { handler: route(adminHandler as never) },
		"forms/list": { handler: route(formsListHandler as never) },
		"forms/create": { handler: validated(formCreateSchema, formsCreateHandler as never) },
		"forms/update": { handler: validated(formUpdateSchema, formsUpdateHandler as never) },
		"forms/delete": { handler: validated(formDeleteSchema, formsDeleteHandler as never) },
		"forms/duplicate": { handler: validated(formDuplicateSchema, formsDuplicateHandler as never) },
		"submissions/list": { handler: validated(submissionsListSchema, submissionsListHandler as never) },
		"submissions/get": { handler: validated(submissionGetSchema, submissionGetHandler as never) },
		"submissions/update": { handler: validated(submissionUpdateSchema, submissionUpdateHandler as never) },
		"submissions/delete": { handler: validated(submissionDeleteSchema, submissionDeleteHandler as never) },
		"submissions/export": { handler: validated(exportSchema, exportHandler as never) },
	},
});
