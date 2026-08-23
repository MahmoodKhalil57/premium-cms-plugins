/**
 * premium-restaurant — sandbox entry (runs in the plugin isolate).
 * Capabilities, storage and admin metadata live in manifest.json.
 */
import { adminHandler, boardHandler, orderStatusHandler, printerDeleteHandler, printerSaveHandler, printersListHandler, printTestHandler, reservationsListHandler, reservationsSyncHandler, shiftsListHandler, staffDeleteHandler, staffListHandler, staffSaveHandler, tableDeleteHandler, tableSaveHandler, tablesListHandler } from "./handlers/admin.js";
import { commerceCheckoutHandler, internalFulfilmentHandler, onCommerceEvent } from "./handlers/internal.js";
import { configHandler, menuHandler, slotsHandler, tableHandler, trackHandler, zoneHandler } from "./handlers/public.js";
import { kdsBumpHandler, kdsTicketsHandler, posDispatchHandler, posMenuHandler, posOrderHandler, posOrdersHandler, posPayHandler, posVoidHandler, printAckHandler, printJobsHandler, reprintHandler, shiftCloseHandler, shiftHandler, shiftMovementHandler, shiftOpenHandler, staffLoginHandler, staffLogoutHandler, staffMeHandler } from "./handlers/staff.js";
import { syncReservations } from "./reservations.js";
import { loadSettings } from "./settings.js";
import { migrateFromCommerceHandler } from "./handlers/migrate.js";
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

const staffTok = { staffToken: v.string({ max: 120 }).optional() };
const modeSchema = v.enumOf(["delivery", "pickup", "dine_in", "pos"] as const);
const id = v.string({ min: 1, max: 64 });
const recordSave = v.object({ id: v.string({ max: 64 }).optional(), record: v.record(v.unknown()) });
const recordDelete = v.object({ id });
const posItem = v.object({ productId: v.string({ min: 1, max: 80 }), quantity: v.number({ int: true, min: 1, max: 99 }), options: v.record(v.unknown()).optional(), notes: v.string({ max: 300 }).optional() });
const posOrder = v.object({
	...staffTok,
	items: v.array(posItem, { min: 1 }),
	mode: modeSchema,
	tableId: v.string({ max: 64 }).optional(),
	customerName: v.string({ max: 120 }).optional(),
	phone: v.string({ max: 40 }).optional(),
	email: v.string({ max: 200 }).optional(),
	note: v.string({ max: 1000 }).optional(),
	tip: v.number({ min: 0 }).optional(),
	discount: v.number({ min: 0 }).optional(),
	payment: v.object({ type: v.enumOf(["cash", "card_terminal", "later"] as const), tendered: v.number({ min: 0 }).optional(), note: v.string({ max: 200 }).optional() }),
});

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				const s = await loadSettings(ctx);
				await syncReservations(ctx, s).catch(() => null);
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
		menu: { public: true, handler: route(menuHandler as never) },
		slots: { public: true, handler: validated(v.object({ mode: modeSchema, date: v.string({ min: 10, max: 10 }) }), slotsHandler as never) },
		zone: { public: true, handler: validated(v.object({ postcode: v.string({ min: 1, max: 20 }) }), zoneHandler as never) },
		table: { public: true, handler: validated(v.object({ code: v.string({ min: 1, max: 20 }) }), tableHandler as never) },
		track: { public: true, handler: validated(v.object({ order: v.or(v.string({ min: 1, max: 20 }), v.number()), token: v.string({ min: 1, max: 120 }) }), trackHandler as never) },
		"staff/login": { public: true, handler: validated(v.object({ pin: v.string({ min: 4, max: 12 }) }), staffLoginHandler as never) },
		"staff/logout": { public: true, handler: validated(v.object({ ...staffTok }), staffLogoutHandler as never) },
		"staff/me": { public: true, handler: validated(v.object({ ...staffTok }), staffMeHandler as never) },
		"pos/menu": { public: true, handler: validated(v.object({ ...staffTok }), posMenuHandler as never) },
		"pos/orders": { public: true, handler: validated(v.object({ ...staffTok, mode: modeSchema.optional(), includeDone: v.boolean().optional() }), posOrdersHandler as never) },
		"pos/order": { public: true, handler: validated(posOrder, posOrderHandler as never) },
		"pos/pay": { public: true, handler: validated(v.object({ ...staffTok, orderId: id, type: v.enumOf(["cash", "card_terminal"] as const), tendered: v.number({ min: 0 }).optional(), note: v.string({ max: 200 }).optional(), tip: v.number({ min: 0 }).optional() }), posPayHandler as never) },
		"pos/void": { public: true, handler: validated(v.object({ ...staffTok, orderId: id, reason: v.string({ max: 200 }).optional() }), posVoidHandler as never) },
		"pos/dispatch": { public: true, handler: validated(v.object({ ...staffTok, orderId: id, driverId: v.string({ max: 64 }).optional(), delivered: v.boolean().optional() }), posDispatchHandler as never) },
		"pos/reprint": { public: true, handler: validated(v.object({ ...staffTok, orderId: id }), reprintHandler as never) },
		"pos/shift": { public: true, handler: validated(v.object({ ...staffTok }), shiftHandler as never) },
		"pos/shift/open": { public: true, handler: validated(v.object({ ...staffTok, float: v.number({ min: 0 }), note: v.string({ max: 200 }).optional() }), shiftOpenHandler as never) },
		"pos/shift/close": { public: true, handler: validated(v.object({ ...staffTok, counted: v.number({ min: 0 }), note: v.string({ max: 500 }).optional() }), shiftCloseHandler as never) },
		"pos/shift/movement": { public: true, handler: validated(v.object({ ...staffTok, kind: v.enumOf(["pay_in", "pay_out"] as const), amount: v.number({ min: 0 }), note: v.string({ max: 200 }).optional() }), shiftMovementHandler as never) },
		"kds/tickets": { public: true, handler: validated(v.object({ ...staffTok, station: v.string({ max: 40 }).optional(), includeRecent: v.boolean().optional() }), kdsTicketsHandler as never) },
		"kds/bump": { public: true, handler: validated(v.object({ ...staffTok, id, status: v.enumOf(["new", "preparing", "ready", "served", "cancelled"] as const) }), kdsBumpHandler as never) },
		"print/jobs": { public: true, handler: validated(v.object({ ...staffTok, printerId: v.string({ max: 64 }).optional(), limit: v.number({ int: true, min: 1, max: 50 }).optional() }), printJobsHandler as never) },
		"print/ack": { public: true, handler: validated(v.object({ ...staffTok, id, status: v.enumOf(["printed", "failed"] as const), error: v.string({ max: 300 }).optional() }), printAckHandler as never) },
		admin: { handler: route(adminHandler as never) },
		board: { handler: route(boardHandler as never) },
		"order-status": { handler: validated(v.object({ id, kitchen: v.enumOf(["new", "preparing", "ready", "served", "out_for_delivery", "delivered", "completed", "cancelled"] as const) }), orderStatusHandler as never) },
		"tables/list": { handler: route(tablesListHandler as never) },
		"tables/save": { handler: validated(recordSave, tableSaveHandler as never) },
		"tables/delete": { handler: validated(recordDelete, tableDeleteHandler as never) },
		"staff/list": { handler: route(staffListHandler as never) },
		"staff/save": { handler: validated(recordSave, staffSaveHandler as never) },
		"staff/delete": { handler: validated(recordDelete, staffDeleteHandler as never) },
		"printers/list": { handler: route(printersListHandler as never) },
		"printers/save": { handler: validated(recordSave, printerSaveHandler as never) },
		"printers/delete": { handler: validated(recordDelete, printerDeleteHandler as never) },
		"print/test": { handler: validated(recordDelete, printTestHandler as never) },
		"shifts/list": { handler: validated(v.object({ limit: v.number({ int: true, min: 1, max: 100 }).optional() }), shiftsListHandler as never) },
		"reservations/sync": { handler: route(reservationsSyncHandler as never) },
		"reservations/list": { handler: validated(v.object({ from: v.string({ max: 40 }).optional(), to: v.string({ max: 40 }).optional() }), reservationsListHandler as never) },
		"migrate/commerce": { handler: route(migrateFromCommerceHandler as never) },
		// Sibling plugins
		"commerce/checkout": { handler: route(commerceCheckoutHandler as never) },
		"internal/fulfilment": { handler: validated(recordDelete, internalFulfilmentHandler as never) },
	},
});
