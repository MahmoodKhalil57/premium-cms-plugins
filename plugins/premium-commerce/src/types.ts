/**
 * premium-commerce data model.
 *
 * Products live in the CMS (`products` collection, seeded by the frontend
 * template); the plugin owns orders and inventory counters in plugin storage.
 * All money is in minor units (cents) of the store currency.
 */

import type { DesignDoc, FormField } from "./fields.js";

export type OrderStatus =
	| "pending" // checkout started, stock reserved, awaiting Stripe
	| "awaiting_payment" // manual payment method: order placed, pay offline
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
}

export interface Customization {
	field: string;
	design: DesignDoc;
	previewMediaId?: string;
	previewUrl?: string;
	/** Upload media id → public URL, captured at checkout. */
	uploads?: Record<string, string>;
}


export type FulfilmentMode = "delivery" | "pickup" | "dine_in" | "pos";
export type KitchenStatus = "new" | "preparing" | "ready" | "served" | "out_for_delivery" | "delivered" | "completed" | "cancelled";
export interface Fulfilment {
	mode: FulfilmentMode;
	/** Requested time (ISO) or null for ASAP. */
	at: string | null;
	label?: string;
	table?: { id: string; name: string } | null;
	zone?: { id: string; name: string; fee: number } | null;
	deliveryFee: number;
	serviceCharge: number;
	tip: number;
	/** Guest chose to pay later at the table / counter / door. */
	payLater: boolean;
	kitchen: KitchenStatus;
	driverId?: string | null;
	driverName?: string | null;
	/** POS: who rang it up and on which cash-drawer shift. */
	staffId?: string | null;
	staffName?: string | null;
	shiftId?: string | null;
	/** POS settlement. */
	paidVia?: "cash" | "card_terminal" | "online" | "unpaid";
	tendered?: number;
	change?: number;
	paymentNote?: string;
	readyAt?: string | null;
	completedAt?: string | null;
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
	/** Deposit orders: the full amount and what is still owed. */
	paymentPlan?: { fullAmount: number; depositAmount: number; balanceDue: number; balanceStatus: "due" | "paid" | "waived"; balanceRef?: string | null; balanceOrderId?: string | null } | null;
	/** Bookings confirmed by this order. */
	bookingIds?: string[];
	/** Restaurant orders: how and when the food reaches the guest, and where it is in the kitchen. */
	fulfilment?: Fulfilment | null;
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
	/** Menu fields (restaurant themes): grouping, kitchen station, dietary tags, availability. */
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
	/** Bookings */
	bookingTimezone: string;
	slotIntervalMin: number;
	leadTimeHours: number;
	horizonDays: number;
	holdMinutes: number;
	notifyEmail: string;
	storeName: string;
	automaticTax: boolean;
	shippingRates: string[];
	shippingCountries: string[];
	allowPromotionCodes: boolean;
	collectPhone: boolean;
	successPath: string;
	cancelPath: string;
	/** Restaurant */
	restaurantMode: boolean;
	fulfilmentModes: FulfilmentMode[];
	openingHours: string;
	prepTimeMin: number;
	deliveryZones: DeliveryZone[];
	pickupLeadMin: number;
	orderSlotIntervalMin: number;
	maxOrdersPerSlot: number;
	tipPresets: number[];
	serviceChargePct: number;
	allowPayAtTable: boolean;
	allowPayOnCollection: boolean;
	qrOrdering: boolean;
	kdsStations: string[];
	printnodeApiKey: string;
	receiptHeader: string;
	receiptFooter: string;
	reservationsEnabled: boolean;
	turnTimeMin: number;
	maxPartySize: number;
	reservationLeadMin: number;
}

export interface CheckoutRequestItem {
	productId: string;
	quantity: number;
}

export interface DeliveryZone {
	id: string;
	name: string;
	/** Postcode / ZIP prefixes (case-insensitive, spaces ignored); "*" matches everything. */
	postcodes: string[];
	/** Major units in the store currency. */
	fee: number;
	minimum: number;
	etaMin: number;
}
