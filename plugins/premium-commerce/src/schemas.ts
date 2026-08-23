import { v } from "./validate.js";

const id = v.string({ min: 1, max: 200 });
const addr = v.string({ max: 200 }).optional();
const addressSchema = v.object({ id: v.string({ max: 64 }).optional(), label: addr, name: addr, line1: addr, line2: addr, city: addr, state: addr, postalCode: addr, country: addr, phone: addr, isDefault: v.boolean().optional() });

export const checkoutSchema = v.object({
	items: v.array(
		v.object({
			/** A CMS product (id or slug) or a provider line `<pluginId>:<ref>`. */
			productId: id,
			quantity: v.number({ int: true, min: 1, max: 999 }),
			options: v.record(v.unknown()).optional(),
			customization: v.object({ design: v.unknown().optional(), previewMediaId: v.string({ max: 64 }).optional() }).optional(),
		}),
		{ min: 1 },
	),
	method: v.enumOf(["online", "stripe", "polar", "manual"] as const).default("online"),
	email: v.string({ email: true }).optional(),
	name: v.string({ max: 200 }).optional(),
	phone: v.string({ max: 50 }).optional(),
	note: v.string({ max: 2000 }).optional(),
	successUrl: v.string({ url: true }).optional(),
	cancelUrl: v.string({ url: true }).optional(),
	/** Server-side cart this checkout converts (marked converted on success). */
	cartId: v.string({ max: 80 }).optional(),
	cartToken: v.string({ max: 80 }).optional(),
	shippingAddress: addressSchema.optional(),
	billingAddress: addressSchema.optional(),
	/** Signed-in shoppers: pick saved entries instead of sending them. */
	shippingAddressId: v.string({ max: 64 }).optional(),
	billingAddressId: v.string({ max: 64 }).optional(),
	saveAddress: v.boolean().optional(),
	/** Signed-in shoppers: pay with a vaulted card, or vault the one used. */
	paymentMethodId: v.string({ max: 64 }).optional(),
	savePaymentMethod: v.boolean().optional(),
	couponCode: v.string({ max: 40 }).optional(),
	/** Per-plugin checkout data (`{ "premium-restaurant": { mode, … } }`), validated by that plugin. */
	extensions: v.record(v.unknown()).optional(),
});
export type CheckoutInput = {
	items: Array<{ productId: string; quantity: number; options?: Record<string, unknown>; customization?: { design?: unknown; previewMediaId?: string } }>;
	method: "online" | "stripe" | "polar" | "manual";
	email?: string;
	name?: string;
	phone?: string;
	note?: string;
	successUrl?: string;
	cancelUrl?: string;
	cartId?: string;
	cartToken?: string;
	shippingAddress?: AddressInput;
	billingAddress?: AddressInput;
	shippingAddressId?: string;
	billingAddressId?: string;
	saveAddress?: boolean;
	paymentMethodId?: string;
	savePaymentMethod?: boolean;
	couponCode?: string;
	extensions?: Record<string, unknown>;
};
export type AddressInput = { id?: string; label?: string; name?: string; line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string; phone?: string; isDefault?: boolean };

export const availabilitySchema = v.object({ ids: v.or(v.string(), v.array(v.string())).optional() });
export const confirmSchema = v.object({ session_id: id });
export const orderLookupSchema = v.object({ order: v.or(v.string(), v.number()), token: v.string({ min: 1 }).optional(), email: v.string().optional() });
export const webhookSchema = v.object({ id: v.string().optional(), provider: v.enumOf(["stripe", "polar"] as const).optional(), key: v.string().optional(), type: v.string({ min: 1 }), data: v.record(v.unknown()) });

export const ordersListSchema = v.object({
	status: v.string().optional(),
	limit: v.number({ int: true, min: 1, max: 100 }).default(50),
	cursor: v.string().optional(),
});
export const orderGetSchema = v.object({ id });
export const orderUpdateSchema = v.object({
	id,
	status: v.enumOf(["paid", "fulfilled", "cancelled", "awaiting_payment"] as const).optional(),
	tracking: v.string({ max: 200 }).optional(),
	note: v.string({ max: 2000 }).optional(),
});
export const orderRefundSchema = v.object({ id, amount: v.number({ int: true, min: 1 }).optional() });
export const exportSchema = v.object({ status: v.string().optional(), format: v.enumOf(["csv", "json"] as const).default("csv") });
export const inventoryAdjustSchema = v.object({ productId: id, sold: v.number({ int: true }).optional(), reserved: v.number({ int: true }).optional() });

export const uploadSchema = v.object({
	filename: v.string({ min: 1, max: 200 }),
	contentType: v.string({ min: 1, max: 100 }),
	/** Base64 (optionally a data: URL). */
	bytes: v.string({ min: 1 }),
	purpose: v.enumOf(["design-image", "design-preview"] as const).default("design-image"),
});
export const orderDesignSchema = v.object({ id, line: v.number({ int: true, min: 0 }).default(0) });

export const accountAddressSaveSchema = v.object({ address: addressSchema });
export const accountAddressDeleteSchema = v.object({ id: v.string({ min: 1, max: 64 }) });
export const accountPaymentMethodDeleteSchema = accountAddressDeleteSchema;
export const accountPortalSchema = v.object({ returnUrl: v.string().optional() });
export const cartGetSchema = v.object({ mergeToken: v.string({ max: 80 }).optional(), mergeLines: v.unknown().optional() });
export const cartSaveSchema = v.object({ lines: v.unknown(), email: v.string().optional() });
export const cartGuestSchema = v.object({ token: v.string({ min: 16, max: 64 }), op: v.enumOf(["get", "save"] as const).default("get"), lines: v.unknown().optional(), email: v.string().optional() });
export const listSchema = v.object({ limit: v.number({ int: true, min: 1, max: 100 }).default(50), cursor: v.string().optional(), status: v.string().optional() });

export const discountPreviewSchema = v.object({
	items: v.array(v.object({ productId: id, quantity: v.number({ int: true, min: 1, max: 999 }), options: v.record(v.unknown()).optional(), customization: v.unknown().optional() }), { min: 1 }),
	code: v.string({ max: 40 }).optional(),
	email: v.string().optional(),
});
export const discountSaveSchema = v.object({ id: v.string({ max: 64 }).optional(), discount: v.record(v.unknown()) });
export const discountDeleteSchema = v.object({ id: v.string({ min: 1, max: 64 }) });
export const collectBalanceSchema = v.object({ id, mode: v.enumOf(["saved_card", "pay_link", "waive"] as const).default("pay_link") });

/* ---- internal (sibling plugins) --------------------------------------------- */
const adjustment = v.object({ label: v.string({ min: 1, max: 80 }), amount: v.number({ int: true }), key: v.string({ max: 40 }).optional() });
export const internalOrderSchema = v.object({ id: v.string({ max: 64 }).optional(), number: v.or(v.string(), v.number()).optional(), token: v.string({ max: 120 }).optional() });
export const internalOrdersSchema = v.object({ status: v.string({ max: 30 }).optional(), channel: v.string({ max: 30 }).optional(), limit: v.number({ int: true, min: 1, max: 300 }).default(100), sinceHours: v.number({ min: 0, max: 24 * 90 }).optional() });
export const internalCreateOrderSchema = v.object({
	items: v.array(v.object({ productId: id, quantity: v.number({ int: true, min: 1, max: 999 }), options: v.record(v.unknown()).optional(), notes: v.string({ max: 300 }).optional() }), { min: 1 }),
	adjustments: v.array(adjustment).optional(),
	/** Minor units off the subtotal (manual discount). */
	discount: v.number({ int: true, min: 0 }).optional(),
	customer: v.object({ name: v.string({ max: 200 }).optional(), email: v.string({ max: 200 }).optional(), phone: v.string({ max: 50 }).optional() }).optional(),
	note: v.string({ max: 2000 }).optional(),
	channel: v.string({ min: 1, max: 30 }).default("pos"),
	paid: v.boolean().default(false),
	offline: v.object({ method: v.string({ min: 1, max: 40 }), tendered: v.number({ int: true, min: 0 }).optional(), note: v.string({ max: 200 }).optional(), by: v.string({ max: 120 }).optional() }).optional(),
	extensions: v.record(v.unknown()).optional(),
	sendEmails: v.boolean().default(true),
});
export const internalSettleSchema = v.object({ id, offline: v.object({ method: v.string({ min: 1, max: 40 }), tendered: v.number({ int: true, min: 0 }).optional(), note: v.string({ max: 200 }).optional(), by: v.string({ max: 120 }).optional() }), adjustments: v.array(adjustment).optional() });
export const internalCancelSchema = v.object({ id, note: v.string({ max: 300 }).optional() });
export const internalFulfilSchema = v.object({ id, note: v.string({ max: 300 }).optional() });
export const internalExtensionSchema = v.object({ id, meta: v.unknown() });
export const internalLegacyExportSchema = v.object({ collection: v.enumOf(["services", "staff", "bookings", "automations", "tables", "tickets", "printJobs", "printers", "shifts", "reservations"] as const), cursor: v.string().optional() });
