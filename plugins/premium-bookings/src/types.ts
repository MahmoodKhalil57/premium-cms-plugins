/**
 * premium-bookings data model.
 *
 * A *service* is what gets booked (a treatment, a consultation, a table for
 * dinner, a court hour). A *resource* is who or what performs it: staff are
 * CMS users (kind "staff"), everything else is an asset (kind "asset" — a
 * table, a room, a chair). Resources have weekly hours and time off; the slot
 * engine intersects them with existing bookings. A *booking* holds a slot on
 * one resource; paid services go through the Commerce plugin as a provider
 * line (`premium-bookings:<bookingId>`), and the order's events confirm or
 * release the hold. Prices are major units of the configured currency.
 */

export interface WeeklyRule {
	/** 0 = Sunday … 6 = Saturday */
	dow: number;
	/** "09:00" */
	start: string;
	/** "17:00" */
	end: string;
}
export interface TimeOff {
	start: string;
	end: string;
	reason?: string;
}

export type ResourceKind = "staff" | "asset";

export interface ResourceRecord {
	kind: ResourceKind;
	name: string;
	/** Staff: the CMS user this person is. */
	userId?: string | null;
	email?: string;
	title?: string;
	bio?: string;
	image?: string;
	/** Assets: how many people fit (a table's seats); staff: 1. */
	capacity: number;
	availability: WeeklyRule[];
	timeOff: TimeOff[];
	tags: string[];
	/** Another plugin mirrors this record (`<pluginId>:<kind>:<id>`); it owns name/capacity/hours. */
	externalId?: string | null;
	managedBy?: string | null;
	active: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export type ServiceKind = "appointment" | "reservation";

export interface ServiceRecord {
	title: string;
	slug: string;
	/** Appointment: one customer, one resource. Reservation: a party on an asset with enough capacity. */
	kind: ServiceKind;
	description?: string;
	/** Minutes (a reservation's turn time). */
	durationMin: number;
	/** Minutes kept free after the booking. */
	bufferMin: number;
	/** Major units; 0 = free / pay in person. */
	price: number;
	depositType: "none" | "fixed" | "percent";
	depositAmount: number;
	/** Resources that can take it (ids); empty = every active resource of `resourceKind`. */
	resourceIds: string[];
	resourceKind: ResourceKind;
	/** Forms-plugin form id to fill in while booking (intake). */
	intakeFormId?: string | null;
	/** Bookings per slot per resource (group sessions). */
	capacity: number;
	/** Reservations: party size bounds. */
	minPartySize: number;
	maxPartySize: number;
	/** Overrides of the plugin-wide slot interval / lead time, when set. */
	slotIntervalMin?: number | null;
	leadTimeMin?: number | null;
	image?: string;
	active: boolean;
	sortOrder: number;
	/** Another plugin keeps this service in sync (e.g. the restaurant's "Table reservation"). */
	managedBy?: string | null;
	createdAt: string;
	updatedAt: string;
}

export type BookingStatus = "held" | "pending_payment" | "confirmed" | "seated" | "completed" | "cancelled" | "no_show";

export interface BookingRecord {
	serviceId: string;
	serviceTitle: string;
	serviceKind: ServiceKind;
	resourceId: string;
	resourceName: string;
	startsAt: string;
	endsAt: string;
	status: BookingStatus;
	customer: { name: string; email: string; phone?: string; userId?: string | null };
	partySize?: number;
	/** Major units at the time of booking. */
	price: number;
	deposit: number;
	orderId?: string | null;
	orderNumber?: number | null;
	intakeSubmissionId?: string | null;
	notes?: string;
	/** online | admin | <plugin id> */
	source: string;
	/** Customer's token for the confirmation page. */
	accessToken: string;
	/** Held slots expire unless paid/confirmed. */
	holdExpiresAt?: string | null;
	flags?: Record<string, string>;
	events: Array<{ at: string; type: string; note?: string }>;
	createdAt: string;
	updatedAt: string;
}

export interface BookingSettings {
	timezone: string;
	slotIntervalMin: number;
	leadTimeHours: number;
	horizonDays: number;
	holdMinutes: number;
	cancelHours: number;
	notifyEmail: string;
	businessName: string;
	currency: string;
	managePath: string;
}

export interface Slot {
	startsAt: string;
	endsAt: string;
	resourceId: string;
	resourceName: string;
}

export type TriggerType = "booking_confirmed" | "booking_reminder" | "booking_completed" | "booking_recall" | "booking_no_show";

export interface AutomationRecord {
	title: string;
	trigger: TriggerType;
	/** booking_reminder: hours before start; booking_recall: days after completion. */
	offset: number;
	/** Only these services (ids); empty = all. */
	serviceIds: string[];
	action: "email";
	subject: string;
	body: string;
	/** Also notify the business (settings.notifyEmail). */
	notifyBusiness: boolean;
	active: boolean;
	runCount: number;
	lastRunAt?: string | null;
	createdAt: string;
	updatedAt: string;
}

/* ---- interop (what Commerce sends / expects) ------------------------------- */

export interface CommerceOrderLine {
	productId: string;
	title: string;
	quantity: number;
	unitAmount: number;
	provider?: string;
	ref?: string;
}
export interface CommerceOrderEvent {
	id: string;
	order: { number: number; status: string; items: CommerceOrderLine[]; email: string; customerName?: string; paymentMethod: string; currency: string; total: number };
}
