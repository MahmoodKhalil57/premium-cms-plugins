import { v } from "./validate.js";

const id = v.string({ min: 1, max: 200 });
const addr = v.string({ max: 200 }).optional();
const addressSchema = v.object({ id: v.string({ max: 64 }).optional(), label: addr, name: addr, line1: addr, line2: addr, city: addr, state: addr, postalCode: addr, country: addr, phone: addr, isDefault: v.boolean().optional() });

export const checkoutSchema = v.object({
	items: v.array(
		v.object({
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
	/** Restaurant orders: how the food reaches the guest. */
	fulfilment: v
		.object({
			mode: v.enumOf(["delivery", "pickup", "dine_in"] as const),
			at: v.string({ max: 40 }).optional(),
			tableCode: v.string({ max: 20 }).optional(),
			postcode: v.string({ max: 20 }).optional(),
			tipPercent: v.number({ min: 0, max: 100 }).optional(),
			tipAmount: v.number({ min: 0 }).optional(),
			payLater: v.boolean().optional(),
		})
		.optional(),
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
	fulfilment?: { mode: "delivery" | "pickup" | "dine_in"; at?: string; tableCode?: string; postcode?: string; tipPercent?: number; tipAmount?: number; payLater?: boolean };
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

/* ---- bookings --------------------------------------------------------------- */
export const availabilitySlotsSchema = v.object({ serviceId: id, date: v.string({ min: 10, max: 10 }), staffId: v.string({ max: 64 }).optional() });
export const holdSchema = v.object({
	serviceId: id,
	staffId: v.string({ max: 64 }).optional(),
	startsAt: v.string({ min: 10, max: 40 }),
	customer: v.object({ name: v.string({ min: 1, max: 200 }), email: v.string({ email: true }), phone: v.string({ max: 50 }).optional() }),
	notes: v.string({ max: 2000 }).optional(),
	intakeSubmissionId: v.string({ max: 64 }).optional(),
});
export const bookingLookupSchema = v.object({ id: id, token: v.string({ min: 1, max: 64 }).optional() });
export const bookingCancelSchema = v.object({ id: id, token: v.string({ max: 64 }).optional() });
export const bookingUpdateSchema = v.object({ id: id, status: v.enumOf(["confirmed", "cancelled", "completed", "no_show"] as const).optional(), startsAt: v.string({ max: 40 }).optional(), staffId: v.string({ max: 64 }).optional(), notes: v.string({ max: 2000 }).optional() });
export const bookingsListSchema = v.object({ from: v.string({ max: 40 }).optional(), to: v.string({ max: 40 }).optional(), status: v.string().optional(), limit: v.number({ int: true, min: 1, max: 500 }).default(200) });
export const recordSaveSchema = v.object({ id: v.string({ max: 64 }).optional(), record: v.record(v.unknown()) });
export const recordDeleteSchema = v.object({ id: v.string({ min: 1, max: 64 }) });
export const collectBalanceSchema = v.object({ id, mode: v.enumOf(["saved_card", "pay_link", "waive"] as const).default("pay_link") });
export const automationRunSchema = v.object({ id: v.string({ max: 64 }).optional(), dryRun: v.boolean().default(false) });
