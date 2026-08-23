/**
 * premium-commerce — sandbox entry (runs in the plugin isolate).
 * Capabilities, storage and admin metadata live in manifest.json.
 */

import { adminHandler } from "./admin.js";
import { accountAddressDeleteHandler, accountAddressSaveHandler, accountGetHandler, accountOrdersHandler, accountPaymentMethodDeleteHandler, accountPortalHandler, cartGetHandler, cartGuestHandler, cartSaveHandler } from "./handlers/account.js";
import { collectBalanceHandler, cartsListHandler, customersListHandler, discountDeleteHandler, discountSaveHandler, discountsListHandler, inventoryAdjustHandler, inventoryListHandler, orderGetHandler, orderRefundHandler, ordersExportHandler, ordersListHandler, orderUpdateHandler, statsHandler, transactionsListHandler } from "./handlers/admin-api.js";
import { expirePendingOrders } from "./handlers/cron.js";
import { internalCancelHandler, internalCatalogHandler, internalConfigHandler, internalCreateOrderHandler, internalExtensionHandler, internalFulfilHandler, internalLegacyExportHandler, internalOrderHandler, internalOrdersHandler, internalSettleHandler } from "./handlers/internal.js";
import { accountCheckoutHandler, availabilityHandler, catalogHandler, checkoutHandler, confirmHandler, discountPreviewHandler, orderDesignHandler, orderLookupHandler, uploadHandler, webhookHandler } from "./handlers/public.js";
import { accountAddressDeleteSchema, accountAddressSaveSchema, accountPaymentMethodDeleteSchema, accountPortalSchema, availabilitySchema, cartGetSchema, cartGuestSchema, cartSaveSchema, checkoutSchema, collectBalanceSchema, confirmSchema, discountDeleteSchema, discountPreviewSchema, discountSaveSchema, exportSchema, internalCancelSchema, internalCreateOrderSchema, internalExtensionSchema, internalFulfilSchema, internalLegacyExportSchema, internalOrderSchema, internalOrdersSchema, internalSettleSchema, inventoryAdjustSchema, listSchema, orderDesignSchema, orderGetSchema, orderLookupSchema, orderRefundSchema, ordersListSchema, orderUpdateSchema, uploadSchema, webhookSchema } from "./schemas.js";
import { definePlugin, route, type PluginContext, type RouteContext } from "./shim.js";

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
				if (ctx.cron) await ctx.cron.schedule("expire-checkouts", { schedule: "@hourly" }).catch(() => {});
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "expire-checkouts") await expirePendingOrders(ctx);
			},
		},
	},
	routes: {
		catalog: { public: true, handler: route(catalogHandler as never) },
		availability: { public: true, handler: validated(availabilitySchema, availabilityHandler as never) },
		checkout: { public: true, handler: validated(checkoutSchema, checkoutHandler as never) },
		confirm: { public: true, handler: validated(confirmSchema, confirmHandler as never) },
		webhook: { public: true, handler: validated(webhookSchema, webhookHandler as never) },
		order: { public: true, handler: validated(orderLookupSchema, orderLookupHandler as never) },
		upload: { public: true, handler: validated(uploadSchema, uploadHandler as never) },
		"cart/guest": { public: true, handler: validated(cartGuestSchema, cartGuestHandler as never) },
		"discounts/preview": { public: true, handler: validated(discountPreviewSchema, discountPreviewHandler as never) },
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
		"orders/collect-balance": { handler: validated(collectBalanceSchema, collectBalanceHandler as never) },
		"customers/list": { handler: validated(listSchema, customersListHandler as never) },
		"carts/list": { handler: validated(listSchema, cartsListHandler as never) },
		"transactions/list": { handler: validated(listSchema, transactionsListHandler as never) },
		"discounts/list": { handler: validated(listSchema, discountsListHandler as never) },
		"discounts/save": { handler: validated(discountSaveSchema, discountSaveHandler as never) },
		"discounts/delete": { handler: validated(discountDeleteSchema, discountDeleteHandler as never) },
		"inventory/list": { handler: route(inventoryListHandler as never) },
		"inventory/adjust": { handler: validated(inventoryAdjustSchema, inventoryAdjustHandler as never) },
		stats: { handler: route(statsHandler as never) },
		// Sibling plugins (manifest `callers`): bookings, restaurant, …
		"internal/config": { handler: route(internalConfigHandler as never) },
		"internal/catalog": { handler: route(internalCatalogHandler as never) },
		"internal/order": { handler: validated(internalOrderSchema, internalOrderHandler as never) },
		"internal/orders": { handler: validated(internalOrdersSchema, internalOrdersHandler as never) },
		"internal/create-order": { handler: validated(internalCreateOrderSchema, internalCreateOrderHandler as never) },
		"internal/settle": { handler: validated(internalSettleSchema, internalSettleHandler as never) },
		"internal/cancel": { handler: validated(internalCancelSchema, internalCancelHandler as never) },
		"internal/fulfil": { handler: validated(internalFulfilSchema, internalFulfilHandler as never) },
		"internal/extension": { handler: validated(internalExtensionSchema, internalExtensionHandler as never) },
		"internal/legacy-export": { handler: validated(internalLegacyExportSchema, internalLegacyExportHandler as never) },
	},
});
