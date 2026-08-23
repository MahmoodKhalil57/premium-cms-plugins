/**
 * premium-restaurant data model.
 *
 * The menu is the CMS `products` collection and every order is a Commerce
 * order — this plugin only adds what a restaurant needs around them:
 * how the food reaches the guest (a *fulfilment* per order), kitchen tickets
 * per station, print jobs, tables with QR codes, staff PIN sessions and cash
 * drawer shifts. Table reservations are bookings on the Bookings plugin,
 * where every table is mirrored as a resource.
 */

export type FulfilmentMode = "delivery" | "pickup" | "dine_in" | "pos";
export type KitchenStatus = "new" | "preparing" | "ready" | "served" | "out_for_delivery" | "delivered" | "completed" | "cancelled";

/** One per Commerce order with restaurant fulfilment; keyed by the order id. */
export interface FulfilmentRecord {
	orderId: string;
	orderNumber: number;
	mode: FulfilmentMode;
	/** Requested time (ISO) or null for ASAP. */
	at: string | null;
	tableId?: string | null;
	tableName?: string | null;
	zoneId?: string | null;
	zoneName?: string | null;
	deliveryFee: number;
	serviceCharge: number;
	tip: number;
	/** Guest pays later at the table / counter / door. */
	payLater: boolean;
	kitchen: KitchenStatus;
	/** Mirror of the order's payment state for the floor. */
	orderStatus: string;
	paidVia?: "cash" | "card_terminal" | "online" | "unpaid";
	customerName?: string | null;
	phone?: string | null;
	note?: string | null;
	driverId?: string | null;
	driverName?: string | null;
	staffId?: string | null;
	staffName?: string | null;
	shiftId?: string | null;
	ticketsCreated: boolean;
	receiptPrinted: boolean;
	readyAt?: string | null;
	completedAt?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface TableRecord {
	name: string;
	/** Short code printed under the QR (e.g. T12). */
	code: string;
	seats: number;
	zone?: string;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}
export interface TicketItem { title: string; quantity: number; notes?: string; options?: string }
export interface TicketRecord {
	orderId: string;
	orderNumber: number;
	station: string;
	items: TicketItem[];
	status: "new" | "preparing" | "ready" | "served" | "cancelled";
	mode: FulfilmentMode;
	table?: string | null;
	customer?: string | null;
	dueAt?: string | null;
	note?: string;
	createdAt: string;
	startedAt?: string | null;
	readyAt?: string | null;
	bumpedAt?: string | null;
}
export interface PrinterRecord {
	name: string;
	/** `agent` = the staff app's printer page prints through the browser; `printnode` = cloud printing. */
	target: "agent" | "printnode";
	printnodePrinterId?: number | null;
	/** Which stations' tickets land here (empty = all). */
	stations: string[];
	kinds: Array<"kitchen" | "receipt">;
	/** Characters per line for the plain-text layout. */
	width: number;
	active: boolean;
	createdAt: string;
	updatedAt: string;
}
export interface PrintJobRecord {
	printerId: string;
	kind: "kitchen" | "receipt";
	orderId: string | null;
	orderNumber: number | null;
	title: string;
	/** Plain text (monospace, `width` columns) — what thermal printers and the browser agent print. */
	text: string;
	status: "queued" | "sent" | "printed" | "failed";
	attempts: number;
	error?: string | null;
	providerRef?: string | null;
	createdAt: string;
	printedAt?: string | null;
}
export interface ShiftMovement { at: string; kind: "pay_in" | "pay_out" | "sale" | "refund"; amount: number; note?: string; orderId?: string }
export interface ShiftRecord {
	staffId: string;
	staffName: string;
	status: "open" | "closed";
	float: number;
	cashSales: number;
	cardSales: number;
	movements: ShiftMovement[];
	orderCount: number;
	expectedCash: number;
	countedCash?: number | null;
	difference?: number | null;
	openedAt: string;
	closedAt?: string | null;
	note?: string;
}
/** A PIN holder for the staff app: a CMS user (userId) or a name-only team member. */
export interface StaffRecord {
	userId?: string | null;
	name: string;
	email?: string;
	title?: string;
	roles: string[];
	pinHash?: string | null;
	active: boolean;
	createdAt: string;
	updatedAt: string;
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

export interface RestaurantSettings {
	timezone: string;
	storeName: string;
	fulfilmentModes: Array<"delivery" | "pickup" | "dine_in">;
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
	notifyEmail: string;
	trackPath: string;
	orderPath: string;
}

/* ---- what Commerce sends us ------------------------------------------------- */

export interface CommerceItem {
	productId: string;
	slug: string;
	title: string;
	sku?: string;
	unitAmount: number;
	quantity: number;
	options?: Record<string, unknown> | null;
	optionsDisplay?: Array<{ name: string; label: string; value: string }> | null;
	provider?: string | null;
}
export interface CommerceOrder {
	number: number;
	status: string;
	paymentMethod: string;
	currency: string;
	items: CommerceItem[];
	subtotal: number;
	discount: number;
	tax: number;
	adjustments?: Array<{ label: string; amount: number; provider?: string; key?: string }>;
	total: number;
	email: string;
	customerName?: string;
	phone?: string;
	note?: string;
	shippingAddress?: { line1?: string; line2?: string; city?: string; postalCode?: string } | null;
	channel?: string;
	extensions?: Record<string, unknown>;
	offline?: { method: string; tendered?: number; change?: number; note?: string; by?: string } | null;
	accessToken: string;
	createdAt: string;
	paidAt?: string;
	events: Array<{ at: string; type: string; note?: string }>;
}
export interface CommerceProduct {
	id: string;
	slug: string;
	title: string;
	unitAmount: number;
	options?: unknown[];
	summary?: string;
	description?: string;
	image?: unknown;
	category?: string;
	station?: string;
	tags?: string[];
	available?: boolean;
	popular?: boolean;
	availableUnits?: number | null;
}

/** What the storefront puts in `extensions["premium-restaurant"]` at checkout. */
export interface CheckoutData {
	mode: "delivery" | "pickup" | "dine_in";
	at?: string;
	tableCode?: string;
	postcode?: string;
	tipPercent?: number;
	tipAmount?: number;
}

/** Public-safe state kept at `order.extensions["premium-restaurant"]`. */
export interface OrderMeta {
	mode: FulfilmentMode;
	at: string | null;
	tableId: string | null;
	table: string | null;
	zoneId: string | null;
	zone: string | null;
	payLater: boolean;
	staffId?: string | null;
	staffName?: string | null;
	shiftId?: string | null;
}
