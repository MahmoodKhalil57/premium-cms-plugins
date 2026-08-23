/**
 * premium-bookings — sandbox entry (runs in the plugin isolate).
 * Capabilities, storage and admin metadata live in manifest.json.
 */

import { adminHandler, automationDeleteHandler, automationRunHandler, automationSaveHandler, automationsListHandler, bookingCreateHandler, bookingsListHandler, bookingsTick, bookingUpdateHandler, resourceDeleteHandler, resourceSaveHandler, resourcesListHandler, serviceDeleteHandler, serviceSaveHandler, servicesListHandler, statsHandler, usersListHandler } from "./handlers/admin.js";
import { bookingsQueryHandler, commerceLineHandler, internalConfigHandler, onCommerceEvent, resourcesSyncHandler, resourcesUnsyncHandler, servicesSyncHandler } from "./handlers/internal.js";
import { accountBookingsHandler, availabilityHandler, availableDaysHandler, bookingCancelHandler, bookingLookupHandler, configHandler, holdHandler, servicesHandler } from "./handlers/public.js";
import { definePlugin, route, type PluginContext, type PluginEvent, type RouteContext } from "./shim.js";
import { v } from "./validate.js";

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

const id = v.string({ min: 1, max: 64 });
const customer = v.object({ name: v.string({ min: 1, max: 200 }), email: v.string({ email: true }), phone: v.string({ max: 50 }).optional() });
const recordSave = v.object({ id: v.string({ max: 64 }).optional(), record: v.record(v.unknown()) });
const recordDelete = v.object({ id });
const kindFilter = v.object({ kind: v.enumOf(["appointment", "reservation", "staff", "asset"] as const).optional() });
const availability = v.object({ serviceId: id, date: v.string({ min: 10, max: 10 }), resourceId: v.string({ max: 64 }).optional(), staffId: v.string({ max: 64 }).optional(), partySize: v.number({ int: true, min: 1, max: 500 }).optional() });
const hold = v.object({ serviceId: id, resourceId: v.string({ max: 64 }).optional(), staffId: v.string({ max: 64 }).optional(), startsAt: v.string({ min: 10, max: 40 }), partySize: v.number({ int: true, min: 1, max: 500 }).optional(), customer, notes: v.string({ max: 2000 }).optional(), intakeSubmissionId: v.string({ max: 64 }).optional() });
const lookup = v.object({ id, token: v.string({ max: 64 }).optional() });
const bookingsList = v.object({ from: v.string({ max: 40 }).optional(), to: v.string({ max: 40 }).optional(), status: v.string({ max: 30 }).optional(), serviceId: v.string({ max: 64 }).optional(), resourceId: v.string({ max: 64 }).optional(), kind: v.string({ max: 20 }).optional(), limit: v.number({ int: true, min: 1, max: 500 }).default(200) });
const bookingUpdate = v.object({ id, status: v.enumOf(["confirmed", "seated", "completed", "cancelled", "no_show"] as const).optional(), startsAt: v.string({ max: 40 }).optional(), resourceId: v.string({ max: 64 }).optional(), staffId: v.string({ max: 64 }).optional(), notes: v.string({ max: 2000 }).optional(), partySize: v.number({ int: true, min: 1, max: 500 }).optional() });
const bookingCreate = v.object({ serviceId: id, resourceId: v.string({ max: 64 }).optional(), startsAt: v.string({ min: 10, max: 40 }), partySize: v.number({ int: true, min: 1, max: 500 }).optional(), customer: v.object({ name: v.string({ min: 1, max: 200 }), email: v.string({ max: 200 }).optional(), phone: v.string({ max: 50 }).optional() }), notes: v.string({ max: 2000 }).optional(), source: v.string({ max: 40 }).optional() });

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				if (ctx.cron) await ctx.cron.schedule("bookings-tick", { schedule: "*/15 * * * *" }).catch(() => {});
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "bookings-tick") await bookingsTick(ctx);
			},
		},
		"plugin:event": {
			handler: async (event: PluginEvent, ctx: PluginContext) => {
				await onCommerceEvent(event as never, ctx);
			},
		},
	},
	routes: {
		config: { public: true, handler: route(configHandler as never) },
		services: { public: true, handler: validated(kindFilter, servicesHandler as never) },
		availability: { public: true, handler: validated(availability, availabilityHandler as never) },
		days: { public: true, handler: validated(v.object({ serviceId: id, days: v.number().optional(), partySize: v.number({ int: true, min: 1, max: 500 }).optional(), resourceId: v.string({ max: 64 }).optional() }), availableDaysHandler as never) },
		hold: { public: true, handler: validated(hold, holdHandler as never) },
		lookup: { public: true, handler: validated(lookup, bookingLookupHandler as never) },
		cancel: { public: true, handler: validated(lookup, bookingCancelHandler as never) },
		"account/bookings": { session: true, handler: route(accountBookingsHandler as never) },
		admin: { handler: route(adminHandler as never) },
		stats: { handler: route(statsHandler as never) },
		"bookings/list": { handler: validated(bookingsList, bookingsListHandler as never) },
		"bookings/update": { handler: validated(bookingUpdate, bookingUpdateHandler as never) },
		"bookings/create": { handler: validated(bookingCreate, bookingCreateHandler as never) },
		"services/list": { handler: validated(kindFilter, servicesListHandler as never) },
		"services/save": { handler: validated(recordSave, serviceSaveHandler as never) },
		"services/delete": { handler: validated(recordDelete, serviceDeleteHandler as never) },
		"resources/list": { handler: validated(kindFilter, resourcesListHandler as never) },
		"resources/save": { handler: validated(recordSave, resourceSaveHandler as never) },
		"resources/delete": { handler: validated(recordDelete, resourceDeleteHandler as never) },
		"users/list": { handler: route(usersListHandler as never) },
		"automations/list": { handler: route(automationsListHandler as never) },
		"automations/save": { handler: validated(recordSave, automationSaveHandler as never) },
		"automations/delete": { handler: validated(recordDelete, automationDeleteHandler as never) },
		"automations/run": { handler: validated(v.object({ id: v.string({ max: 64 }).optional(), dryRun: v.boolean().default(false) }), automationRunHandler as never) },
		// Sibling plugins
		"commerce/line": { handler: validated(v.object({ ref: id, quantity: v.number().optional(), email: v.string().optional(), userId: v.string().nullable().optional() }), commerceLineHandler as never) },
		"resources/sync": { handler: validated(v.object({ externalId: v.string({ min: 1, max: 160 }), record: v.record(v.unknown()) }), resourcesSyncHandler as never) },
		"resources/unsync": { handler: validated(v.object({ externalId: v.string({ min: 1, max: 160 }) }), resourcesUnsyncHandler as never) },
		"services/sync": { handler: validated(v.object({ slug: v.string({ min: 1, max: 80 }), record: v.record(v.unknown()) }), servicesSyncHandler as never) },
		"bookings/query": { handler: validated(v.object({ from: v.string({ max: 40 }).optional(), to: v.string({ max: 40 }).optional(), serviceId: v.string({ max: 64 }).optional(), resourceId: v.string({ max: 64 }).optional(), externalId: v.string({ max: 160 }).optional(), kind: v.string({ max: 20 }).optional(), status: v.string({ max: 30 }).optional() }), bookingsQueryHandler as never) },
		"internal/config": { handler: route(internalConfigHandler as never) },
	},
});
