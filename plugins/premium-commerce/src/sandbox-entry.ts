/**
 * premium-commerce — sandbox entry (runs in the plugin isolate).
 * Capabilities, storage and admin metadata live in manifest.json.
 */

import { adminHandler } from "./admin.js";
import { accountAddressDeleteHandler, accountAddressSaveHandler, accountGetHandler, accountOrdersHandler, accountPaymentMethodDeleteHandler, accountPortalHandler, cartGetHandler, cartGuestHandler, cartSaveHandler } from "./handlers/account.js";
import { collectBalanceHandler, cartsListHandler, customersListHandler, discountDeleteHandler, discountSaveHandler, discountsListHandler, inventoryAdjustHandler, inventoryListHandler, orderGetHandler, orderRefundHandler, ordersExportHandler, ordersListHandler, orderUpdateHandler, statsHandler, transactionsListHandler } from "./handlers/admin-api.js";
import { expirePendingOrders } from "./handlers/cron.js";
import { accountBookingsHandler, automationDeleteHandler, automationRunHandler, automationSaveHandler, automationsListHandler, availabilityHandler as slotsHandler, availableDaysHandler, bookingCancelHandler, bookingLookupHandler, bookingsListHandler, bookingsTick, bookingUpdateHandler, holdHandler, serviceDeleteHandler, serviceSaveHandler, servicesHandler, servicesListHandler, staffDeleteHandler, staffListHandler, staffSaveHandler } from "./handlers/bookings.js";
import { accountCheckoutHandler, availabilityHandler, catalogHandler, checkoutHandler, confirmHandler, discountPreviewHandler, orderDesignHandler, orderLookupHandler, uploadHandler, webhookHandler } from "./handlers/public.js";
import { automationRunSchema, availabilitySlotsSchema, bookingCancelSchema, bookingLookupSchema, bookingsListSchema, bookingUpdateSchema, collectBalanceSchema, holdSchema, recordDeleteSchema, recordSaveSchema, discountDeleteSchema, discountPreviewSchema, discountSaveSchema, accountAddressDeleteSchema, accountAddressSaveSchema, accountPaymentMethodDeleteSchema, accountPortalSchema, cartGetSchema, cartGuestSchema, cartSaveSchema, listSchema, availabilitySchema, checkoutSchema, confirmSchema, exportSchema, inventoryAdjustSchema, orderDesignSchema, orderGetSchema, orderLookupSchema, orderRefundSchema, ordersListSchema, orderUpdateSchema, uploadSchema, webhookSchema } from "./schemas.js";
import { definePlugin, route, type PluginContext, type RouteContext } from "./shim.js";
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

import {
	boardHandler, kdsBumpHandler, kdsTicketsHandler, orderStatusHandler, posDispatchHandler, posMenuHandler, posOrderHandler, posOrdersHandler, posPayHandler, posVoidHandler, printAckHandler, printJobsHandler, printTestHandler, printerDeleteHandler, printerSaveHandler, printersListHandler, reservationAvailabilityHandler, reservationCancelHandler, reservationCreateHandler, reservationLookupHandler, reservationUpdateHandler, reservationsListHandler, restaurantConfigHandler, restaurantMenuHandler, shiftCloseHandler, shiftHandler, shiftMovementHandler, shiftOpenHandler, shiftsListHandler, orderSlotsHandler, staffLoginHandler, staffLogoutHandler, staffMeHandler, staffSetPinHandler, tableDeleteHandler, tableHandler, tableSaveHandler, tablesListHandler, trackHandler, zoneHandler,
} from "./handlers/restaurant.js";

const staffTok = { staffToken: v.string({ max: 120 }).optional() };
const modeSchema = v.enumOf(["delivery", "pickup", "dine_in", "pos"] as const);
const posItemSchema = v.object({ productId: v.string({ min: 1, max: 80 }), quantity: v.number({ int: true, min: 1, max: 99 }), options: v.record(v.unknown()).optional(), notes: v.string({ max: 300 }).optional() });
const posOrderSchema = v.object({
	...staffTok,
	items: v.array(posItemSchema, { min: 1 }),
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
const RESTAURANT_ROUTES = {
	"restaurant/config": { public: true, handler: route(restaurantConfigHandler as never) },
	"restaurant/menu": { public: true, handler: route(restaurantMenuHandler as never) },
	"restaurant/slots": { public: true, handler: validated(v.object({ mode: modeSchema, date: v.string({ min: 10, max: 10 }) }), orderSlotsHandler as never) },
	"restaurant/zone": { public: true, handler: validated(v.object({ postcode: v.string({ min: 1, max: 20 }) }), zoneHandler as never) },
	"restaurant/table": { public: true, handler: validated(v.object({ code: v.string({ min: 1, max: 20 }) }), tableHandler as never) },
	"restaurant/track": { public: true, handler: validated(v.object({ order: v.string({ min: 1, max: 20 }), token: v.string({ min: 1, max: 120 }) }), trackHandler as never) },
	"reservations/availability": { public: true, handler: validated(v.object({ date: v.string({ min: 10, max: 10 }), partySize: v.number({ int: true, min: 1, max: 50 }) }), reservationAvailabilityHandler as never) },
	"reservations/create": { public: true, handler: validated(v.object({ name: v.string({ min: 1, max: 120 }), email: v.string({ email: true }), phone: v.string({ max: 40 }).optional(), partySize: v.number({ int: true, min: 1, max: 50 }), at: v.string({ min: 10, max: 40 }), notes: v.string({ max: 500 }).optional() }), reservationCreateHandler as never) },
	"reservations/lookup": { public: true, handler: validated(v.object({ id: v.string({ min: 1, max: 64 }), token: v.string({ min: 1, max: 120 }) }), reservationLookupHandler as never) },
	"reservations/cancel": { public: true, handler: validated(v.object({ id: v.string({ min: 1, max: 64 }), token: v.string({ min: 1, max: 120 }) }), reservationCancelHandler as never) },
	"staff/login": { public: true, handler: validated(v.object({ pin: v.string({ min: 4, max: 12 }) }), staffLoginHandler as never) },
	"staff/logout": { public: true, handler: validated(v.object({ ...staffTok }), staffLogoutHandler as never) },
	"staff/me": { public: true, handler: validated(v.object({ ...staffTok }), staffMeHandler as never) },
	"pos/menu": { public: true, handler: validated(v.object({ ...staffTok }), posMenuHandler as never) },
	"pos/orders": { public: true, handler: validated(v.object({ ...staffTok, mode: modeSchema.optional(), includeDone: v.boolean().optional() }), posOrdersHandler as never) },
	"pos/order": { public: true, handler: validated(posOrderSchema, posOrderHandler as never) },
	"pos/pay": { public: true, handler: validated(v.object({ ...staffTok, orderId: v.string({ min: 1, max: 64 }), type: v.enumOf(["cash", "card_terminal"] as const), tendered: v.number({ min: 0 }).optional(), note: v.string({ max: 200 }).optional(), tip: v.number({ min: 0 }).optional() }), posPayHandler as never) },
	"pos/void": { public: true, handler: validated(v.object({ ...staffTok, orderId: v.string({ min: 1, max: 64 }), reason: v.string({ max: 200 }).optional() }), posVoidHandler as never) },
	"pos/dispatch": { public: true, handler: validated(v.object({ ...staffTok, orderId: v.string({ min: 1, max: 64 }), driverId: v.string({ max: 64 }).optional(), delivered: v.boolean().optional() }), posDispatchHandler as never) },
	"pos/shift": { public: true, handler: validated(v.object({ ...staffTok }), shiftHandler as never) },
	"pos/shift/open": { public: true, handler: validated(v.object({ ...staffTok, float: v.number({ min: 0 }), note: v.string({ max: 200 }).optional() }), shiftOpenHandler as never) },
	"pos/shift/close": { public: true, handler: validated(v.object({ ...staffTok, counted: v.number({ min: 0 }), note: v.string({ max: 500 }).optional() }), shiftCloseHandler as never) },
	"pos/shift/movement": { public: true, handler: validated(v.object({ ...staffTok, kind: v.enumOf(["pay_in", "pay_out"] as const), amount: v.number({ min: 0 }), note: v.string({ max: 200 }).optional() }), shiftMovementHandler as never) },
	"kds/tickets": { public: true, handler: validated(v.object({ ...staffTok, station: v.string({ max: 40 }).optional(), includeRecent: v.boolean().optional() }), kdsTicketsHandler as never) },
	"kds/bump": { public: true, handler: validated(v.object({ ...staffTok, id: v.string({ min: 1, max: 64 }), status: v.enumOf(["new", "preparing", "ready", "served", "cancelled"] as const) }), kdsBumpHandler as never) },
	"print/jobs": { public: true, handler: validated(v.object({ ...staffTok, printerId: v.string({ max: 64 }).optional(), limit: v.number({ int: true, min: 1, max: 50 }).optional() }), printJobsHandler as never) },
	"print/ack": { public: true, handler: validated(v.object({ ...staffTok, id: v.string({ min: 1, max: 64 }), status: v.enumOf(["printed", "failed"] as const), error: v.string({ max: 300 }).optional() }), printAckHandler as never) },
	"tables/list": { handler: route(tablesListHandler as never) },
	"tables/save": { handler: validated(recordSaveSchema, tableSaveHandler as never) },
	"tables/delete": { handler: validated(v.object({ id: v.string({ min: 1 }) }), tableDeleteHandler as never) },
	"printers/list": { handler: route(printersListHandler as never) },
	"printers/save": { handler: validated(recordSaveSchema, printerSaveHandler as never) },
	"printers/delete": { handler: validated(v.object({ id: v.string({ min: 1 }) }), printerDeleteHandler as never) },
	"print/test": { handler: validated(v.object({ id: v.string({ min: 1 }) }), printTestHandler as never) },
	"shifts/list": { handler: validated(v.object({ limit: v.number({ int: true, min: 1, max: 100 }).optional() }), shiftsListHandler as never) },
	"reservations/list": { handler: validated(v.object({ from: v.string({ max: 40 }).optional(), to: v.string({ max: 40 }).optional(), status: v.string({ max: 20 }).optional() }), reservationsListHandler as never) },
	"reservations/update": { handler: validated(v.object({ id: v.string({ min: 1, max: 64 }), status: v.enumOf(["confirmed", "seated", "completed", "cancelled", "no_show"] as const).optional(), tableId: v.string({ max: 64 }).optional(), notes: v.string({ max: 500 }).optional(), record: v.record(v.unknown()).optional() }), reservationUpdateHandler as never) },
	"restaurant/board": { handler: route(boardHandler as never) },
	"restaurant/order-status": { handler: validated(v.object({ id: v.string({ min: 1, max: 64 }), kitchen: v.enumOf(["new", "preparing", "ready", "served", "out_for_delivery", "delivered", "completed", "cancelled"] as const) }), orderStatusHandler as never) },
	"staff/set-pin": { handler: validated(v.object({ id: v.string({ min: 1, max: 64 }), pin: v.string({ max: 12 }), roles: v.array(v.string({ max: 30 })).optional() }), staffSetPinHandler as never) },
};

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				if (ctx.cron) await ctx.cron.schedule("expire-checkouts", { schedule: "@hourly" }).catch(() => {});
				if (ctx.cron) await ctx.cron.schedule("bookings-tick", { schedule: "*/15 * * * *" }).catch(() => {});
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "expire-checkouts") await expirePendingOrders(ctx);
				if (event.name === "bookings-tick") await bookingsTick(ctx);
			},
		},
	},
	routes: {
		...RESTAURANT_ROUTES,
		catalog: { public: true, handler: route(catalogHandler as never) },
		availability: { public: true, handler: validated(availabilitySchema, availabilityHandler as never) },
		checkout: { public: true, handler: validated(checkoutSchema, checkoutHandler as never) },
		confirm: { public: true, handler: validated(confirmSchema, confirmHandler as never) },
		webhook: { public: true, handler: validated(webhookSchema, webhookHandler as never) },
		order: { public: true, handler: validated(orderLookupSchema, orderLookupHandler as never) },
		upload: { public: true, handler: validated(uploadSchema, uploadHandler as never) },
		"cart/guest": { public: true, handler: validated(cartGuestSchema, cartGuestHandler as never) },
		"discounts/preview": { public: true, handler: validated(discountPreviewSchema, discountPreviewHandler as never) },
		"bookings/services": { public: true, handler: route(servicesHandler as never) },
		"bookings/availability": { public: true, handler: validated(availabilitySlotsSchema, slotsHandler as never) },
		"bookings/days": { public: true, handler: validated(v.object({ serviceId: v.string({ min: 1 }), days: v.number().optional() }), availableDaysHandler as never) },
		"bookings/hold": { public: true, handler: validated(holdSchema, holdHandler as never) },
		"bookings/lookup": { public: true, handler: validated(bookingLookupSchema, bookingLookupHandler as never) },
		"bookings/cancel": { public: true, handler: validated(bookingCancelSchema, bookingCancelHandler as never) },
		"account/bookings": { session: true, handler: route(accountBookingsHandler as never) },
		"checkout/account": { session: true, handler: validated(checkoutSchema, accountCheckoutHandler as never) },
		"account/get": { session: true, handler: route(accountGetHandler as never) },
		"account/address-save": { session: true, handler: validated(accountAddressSaveSchema, accountAddressSaveHandler as never) },
		"account/address-delete": { session: true, handler: validated(accountAddressDeleteSchema, accountAddressDeleteHandler as never) },
		"account/payment-method-delete": { session: true, handler: validated(accountPaymentMethodDeleteSchema, accountPaymentMethodDeleteHandler as never) },
		"account/portal": { session: true, handler: validated(accountPortalSchema, accountPortalHandler as never) },
		"account/orders": { session: true, handler: route(accountOrdersHandler as never) },
		"cart/get": { session: true, handler: validated(cartGetSchema, cartGetHandler as never) },
		"cart/save": { session: true, handler: validated(cartSaveSchema, cartSaveHandler as never) },
		admin: { handler: route(adminHandler as never) },
		"orders/list": { handler: validated(ordersListSchema, ordersListHandler as never) },
		"orders/get": { handler: validated(orderGetSchema, orderGetHandler as never) },
		"orders/update": { handler: validated(orderUpdateSchema, orderUpdateHandler as never) },
		"orders/refund": { handler: validated(orderRefundSchema, orderRefundHandler as never) },
		"orders/export": { handler: validated(exportSchema, ordersExportHandler as never) },
		"orders/design": { handler: validated(orderDesignSchema, orderDesignHandler as never) },
		"customers/list": { handler: validated(listSchema, customersListHandler as never) },
		"carts/list": { handler: validated(listSchema, cartsListHandler as never) },
		"transactions/list": { handler: validated(listSchema, transactionsListHandler as never) },
		"discounts/list": { handler: validated(listSchema, discountsListHandler as never) },
		"discounts/save": { handler: validated(discountSaveSchema, discountSaveHandler as never) },
		"discounts/delete": { handler: validated(discountDeleteSchema, discountDeleteHandler as never) },
		"bookings/list": { handler: validated(bookingsListSchema, bookingsListHandler as never) },
		"bookings/update": { handler: validated(bookingUpdateSchema, bookingUpdateHandler as never) },
		"services/list": { handler: route(servicesListHandler as never) },
		"services/save": { handler: validated(recordSaveSchema, serviceSaveHandler as never) },
		"services/delete": { handler: validated(recordDeleteSchema, serviceDeleteHandler as never) },
		"staff/list": { handler: route(staffListHandler as never) },
		"staff/save": { handler: validated(recordSaveSchema, staffSaveHandler as never) },
		"staff/delete": { handler: validated(recordDeleteSchema, staffDeleteHandler as never) },
		"automations/list": { handler: route(automationsListHandler as never) },
		"automations/save": { handler: validated(recordSaveSchema, automationSaveHandler as never) },
		"automations/delete": { handler: validated(recordDeleteSchema, automationDeleteHandler as never) },
		"automations/run": { handler: validated(automationRunSchema, automationRunHandler as never) },
		"orders/collect-balance": { handler: validated(collectBalanceSchema, collectBalanceHandler as never) },
		"inventory/list": { handler: route(inventoryListHandler as never) },
		"inventory/adjust": { handler: validated(inventoryAdjustSchema, inventoryAdjustHandler as never) },
		stats: { handler: route(statsHandler as never) },
	},
});
