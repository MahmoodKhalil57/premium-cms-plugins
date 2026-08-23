/**
 * premium-commerce data model.
 *
 * Products live in the CMS (`products` collection, seeded by the frontend
 * template); the plugin owns orders, carts, customers, discounts and
 * inventory counters in plugin storage. All money is in minor units (cents)
 * of the store currency.
 *
 * Other plugins take part in an order in two ways (see README § Interop):
 *  - provider lines: an item whose `productId` is `<pluginId>:<ref>` is priced
 *    by that plugin (`commerce/line`), e.g. an appointment deposit;
 *  - checkout extensions: `extensions[pluginId]` in the checkout body is
 *    validated by that plugin (`commerce/checkout`), which may add
 *    adjustments (fees, tips) and keep public-safe meta on the order.
 * Every state change is published as a `premium-commerce:order.*` event.
 */

import type { DesignDoc, FormField } from "./fields.js";

export type OrderStatus =
	| "pending" // checkout started, stock reserved, awaiting the provider
	| "awaiting_payment" // pay-later: order placed, money collected offline
	| "paid"
	| "fulfilled"
	| "cancelled"
	| "refunded"
	| "failed";

export type PaymentMethod = "stripe" | "polar" | "manual";
export type PaymentProvider = "none" | "stripe" | "polar";

export interface OrderItem {
	productId: string;
	slug: string;
	title: string;
	sku?: string;
	unitAmount: number;
	quantity: number;
	requiresShipping: boolean;
	/** Chosen option values (field name → value), validated server-side. */
	options?: Record<string, unknown>;
	/** Labels for summaries, in field order. */
	optionsDisplay?: Array<{ name: string; label: string; value: string }>;
	/** Price breakdown above the base price (minor units). */
	extras?: Array<{ label: string; amount: number }>;
	/** Unit price before discounts (minor units) and what took it down. */
	originalUnitAmount?: number;
	discounts?: Array<{ id: string; title: string; code: string | null; perUnit: number }>;
	baseUnitAmount?: number;
	/** Custom print design attached to this line. */
	customization?: Customization;
	/** Inventory rows this line draws from: the product and any tracked choices. */
	stockKeys?: string[];
	/** Provider line: the plugin that priced it and what it refers to. */
	provider?: string;
	ref?: string;
}

export interface Customization {
	field: string;
	design: DesignDoc;
	previewMediaId?: string;
	previewUrl?: string;
	/** Upload media id → public URL, captured at checkout. */
	uploads?: Record<string, string>;
}

/** Amounts other than items: delivery fee, service charge, tip … (minor units; negative = reduction). */
export interface OrderAdjustment {
	label: string;
	amount: number;
	/** Plugin that added it. */
	provider?: string;
	/** Stable key for the provider ("delivery", "tip"). */
	key?: string;
}

/** Money taken outside the PSP (till, terminal, bank transfer). */
export interface OfflinePayment {
	method: string;
	tendered?: number;
	change?: number;
	note?: string;
	/** Who took it (staff name / user id). */
	by?: string;
}

export interface OrderEvent {
	at: string;
	type: string;
	note?: string;
}

export interface Order {
	number: number;
	status: OrderStatus;
	paymentMethod: PaymentMethod;
	currency: string;
	items: OrderItem[];
	subtotal: number;
	shipping: number;
	tax: number;
	discount: number;
	adjustments?: OrderAdjustment[];
	/** Deposit orders: the full amount and what is still owed. */
	paymentPlan?: { fullAmount: number; depositAmount: number; balanceDue: number; balanceStatus: "due" | "paid" | "waived"; balanceRef?: string | null; balanceOrderId?: string | null } | null;
	/** Coupon applied at checkout, if any. */
	coupon?: { id: string; code: string; title: string; freeShipping: boolean } | null;
	total: number;
	email: string;
	customerName?: string;
	phone?: string;
	shippingAddress?: Address;
	billingAddress?: Address;
	/** Signed-in shopper who placed it (null for guests). */
	userId?: string | null;
	/** Server-side cart this order came from. */
	cartId?: string | null;
	/** Where it was placed: web (default), pos, phone … */
	channel?: string;
	/** Public-safe state other plugins keep on the order (`extensions[pluginId]`). */
	extensions?: Record<string, unknown>;
	offline?: OfflinePayment | null;
	note?: string;
	tracking?: string;
	sessionId?: string;
	paymentRef?: string;
	accessToken: string;
	createdAt: string;
	updatedAt: string;
	paidAt?: string;
	expiresAt?: string;
	events: OrderEvent[];
	meta: { ip: string | null; country: string | null; userAgent: string | null };
}

export interface Address {
	id?: string;
	label?: string;
	name?: string;
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string;
	phone?: string;
	isDefault?: boolean;
}

/** A card vaulted at the PSP — we hold the opaque token and display metadata only. */
export interface SavedPaymentMethod {
	id: string;
	provider: "stripe";
	token: string;
	brand: string;
	last4: string;
	expMonth: number;
	expYear: number;
	createdAt: string;
}

export interface CustomerRecord {
	userId: string;
	email: string;
	name?: string;
	stripeCustomerId: string | null;
	polarCustomerId: string | null;
	addresses: Address[];
	paymentMethods: SavedPaymentMethod[];
	createdAt: string;
	updatedAt: string;
}

export interface CartLine {
	productId: string;
	quantity: number;
	options?: Record<string, unknown>;
	customization?: { design?: unknown; previewMediaId?: string };
}

export interface CartRecord {
	userId: string | null;
	token: string | null;
	currency: string;
	lines: CartLine[];
	email?: string;
	status: "active" | "converted" | "abandoned";
	convertedOrderId?: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

export interface TransactionRecord {
	orderId: string;
	orderNumber: number;
	provider: PaymentMethod;
	kind: "payment" | "refund" | "failed";
	/** Minor units; refunds are positive amounts of kind "refund". */
	amount: number;
	currency: string;
	status: string;
	providerRef: string | null;
	note?: string;
	createdAt: string;
}

export interface InventoryRow {
	productId: string;
	sold: number;
	reserved: number;
	updatedAt: string;
}

export interface Product {
	id: string;
	slug: string;
	title: string;
	unitAmount: number;
	compareAtAmount?: number;
	sku?: string;
	/** null = unlimited */
	stock: number | null;
	requiresShipping: boolean;
	/** Size variants offered (from the product's `sizes` field); buyers must pick one. */
	sizes?: string[];
	/** Configurable options: fields with price deltas, conditions, per-choice stock, design areas. */
	options?: FormField[];
	summary?: string;
	image?: unknown;
	/** Grouping / routing fields other plugins use (menu category, kitchen station, dietary tags, availability). */
	category?: string;
	station?: string;
	tags?: string[];
	available?: boolean;
	popular?: boolean;
	description?: string;
}

export interface StoreSettings {
	currency: string;
	paymentProvider: PaymentProvider;
	stripeSecretKey: string;
	stripeWebhookSecret: string;
	polarAccessToken: string;
	polarProductId: string;
	polarWebhookSecret: string;
	allowManualPayment: boolean;
	/** Shoppers may sign in (email link) to save addresses and reuse payment methods. */
	customerAccounts: boolean;
	notifyEmail: string;
	storeName: string;
	automaticTax: boolean;
	shippingRates: string[];
	shippingCountries: string[];
	allowPromotionCodes: boolean;
	collectPhone: boolean;
	successPath: string;
	cancelPath: string;
}

/* ---- interop contracts (what sibling plugins implement / receive) --------- */

/** Answer of `<plugin>/commerce/line` for a provider line `<plugin>:<ref>`. */
export interface ProviderLine {
	title: string;
	/** Minor units; with a deposit this is the deposit, `fullAmount` the whole price. */
	unitAmount: number;
	quantity?: number;
	fullAmount?: number;
	depositAmount?: number;
	sku?: string;
	display?: Array<{ name: string; label: string; value: string }>;
}

/** Answer of `<plugin>/commerce/checkout` for `extensions[plugin]`. */
export interface CheckoutExtension {
	adjustments?: Array<{ label: string; amount: number; key?: string }>;
	/** Public-safe state kept at `order.extensions[plugin]` (shown on the receipt page). */
	meta?: unknown;
	/** The plugin vouches for pay-later on this order (e.g. pay at the table). */
	allowPayLater?: boolean;
	/** Default true; false when the plugin can reach the customer otherwise (dine-in). */
	requireEmail?: boolean;
	/** Shown on emails / receipts. */
	summary?: string;
}

export type OrderEventName = "order.created" | "order.paid" | "order.fulfilled" | "order.cancelled" | "order.refunded";
export interface OrderEventPayload {
	id: string;
	order: Order;
}

export interface CheckoutRequestItem {
	productId: string;
	quantity: number;
}
