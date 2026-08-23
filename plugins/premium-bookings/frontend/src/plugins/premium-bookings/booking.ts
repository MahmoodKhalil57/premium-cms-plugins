/**
 * Booking widget ([data-booking], Bookings plugin): service → day → time (and
 * who) → your details (+ intake form when the service has one) → hold the
 * slot → pay through the Commerce checkout, or confirm straight away when free.
 * Also renders a booking's confirmation page (?booking=<id>&token=…).
 */
import { API } from "../../lib/client";
import { api as sessionApi, whoAmI } from "../premium-commerce/account";

const BASE = `${API}/_emdash/api/plugins/premium-bookings`;
const COMMERCE = `${API}/_emdash/api/plugins/premium-commerce`;
const FORMS = `${API}/_emdash/api/plugins/premium-forms`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Service {
	id: string;
	slug: string;
	title: string;
	description: string;
	durationMin: number;
	price: number;
	deposit: number;
	intakeFormId: string | null;
	image: string | null;
	staff: Array<{ id: string; name: string }>;
}
interface Slot {
	startsAt: string;
	endsAt: string;
	staffId: string;
	staffName: string;
}

async function pub<T>(route: string, body: unknown = {}, base = BASE): Promise<T> {
	const r = await fetch(`${base}/${route}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify(body) });
	const j = (await r.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } };
	if (!r.ok || j.success === false) throw new Error(j.error?.message ?? `Request failed (${r.status})`);
	return j.data as T;
}

const money = (n: number, c: string) => new Intl.NumberFormat(undefined, { style: "currency", currency: c.toUpperCase() }).format(n);
const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const timeLabel = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export async function renderBooking(root: HTMLElement): Promise<void> {
	const params = new URLSearchParams(location.search);
	if (params.get("booking")) return renderConfirmation(root, params.get("booking")!, params.get("token") ?? "");
	let data: { currency: string; timezone: string; horizonDays: number; services: Service[] };
	try {
		data = await pub("services", { kind: "appointment" });
	} catch (err) {
		root.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Booking is unavailable")}</p>`;
		return;
	}
	const state = { service: null as Service | null, day: "", slot: null as Slot | null, staffId: "", days: [] as string[], slots: [] as Slot[], intake: null as { submissionId: string } | null };
	const preselect = params.get("service") ?? root.dataset.service;
	const me = await whoAmI();

	const draw = () => {
		const s = state.service;
		root.innerHTML = `
			<div class="bk">
				<ol class="bk__steps">
					<li class="${!s ? "is-active" : "is-done"}">1. Treatment</li>
					<li class="${s && !state.slot ? "is-active" : state.slot ? "is-done" : ""}">2. Date & time</li>
					<li class="${state.slot ? "is-active" : ""}">3. Your details</li>
				</ol>
				<section class="bk__panel" data-step="service" ${s ? "hidden" : ""}>
					<div class="bk__services">${data.services
						.map(
							(x) => `<button type="button" class="bk__service" data-service="${esc(x.id)}">
								${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy">` : ""}
								<span class="bk__service-body"><strong>${esc(x.title)}</strong><span class="bk__meta">${x.durationMin} min · ${x.price > 0 ? money(x.price, data.currency) : "Free"}${x.deposit > 0 ? ` · ${money(x.deposit, data.currency)} deposit` : ""}</span>${x.description ? `<span class="bk__desc">${esc(x.description)}</span>` : ""}</span>
							</button>`,
						)
						.join("")}</div>
				</section>
				<section class="bk__panel" data-step="time" ${s && !state.slot ? "" : "hidden"}>
					<p class="bk__chosen"><strong>${esc(s?.title ?? "")}</strong> · ${s?.durationMin ?? 0} min <button type="button" class="ec-link" data-reset="service">change</button></p>
					${s && s.staff.length > 1 ? `<label class="ec-form-field"><span class="ec-form-label">With</span><select class="ec-form-input" data-staff><option value="">Anyone available</option>${s.staff.map((m) => `<option value="${esc(m.id)}"${state.staffId === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>` : ""}
					<div class="bk__days" data-days>${state.days.length ? state.days.map((d) => `<button type="button" class="bk__day${state.day === d ? " is-active" : ""}" data-day="${d}">${esc(dayLabel(d))}</button>`).join("") : `<p class="ec-form-help">Finding available days…</p>`}</div>
					<div class="bk__slots" data-slots>${state.day ? (state.slots.length ? state.slots.map((sl) => `<button type="button" class="bk__slot" data-slot="${esc(sl.startsAt)}" data-slot-staff="${esc(sl.staffId)}">${esc(timeLabel(sl.startsAt, data.timezone))}<small>${esc(sl.staffName)}</small></button>`).join("") : `<p class="ec-form-help">No times left that day.</p>`) : ""}</div>
					<p class="ec-form-help">Times shown in ${esc(data.timezone.replace("_", " "))}.</p>
				</section>
				<section class="bk__panel" data-step="details" ${state.slot ? "" : "hidden"}>
					<p class="bk__chosen"><strong>${esc(s?.title ?? "")}</strong> · ${state.slot ? esc(dayLabel(state.day)) + " at " + esc(timeLabel(state.slot.startsAt, data.timezone)) + " with " + esc(state.slot.staffName) : ""} <button type="button" class="ec-link" data-reset="slot">change</button></p>
					<form class="ec-form bk__form" data-booking-form>
						<div class="ec-address-form">
							<label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Full name</span><input class="ec-form-input" name="name" required autocomplete="name" value="${esc(me?.name ?? "")}"></label>
							<label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Email</span><input class="ec-form-input" type="email" name="email" required autocomplete="email" value="${esc(me?.email ?? "")}"></label>
							<label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Phone</span><input class="ec-form-input" name="phone" autocomplete="tel"></label>
							<label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Anything we should know?</span><input class="ec-form-input" name="notes" maxlength="500"></label>
						</div>
						<div data-intake></div>
						<div class="ec-checkout__actions"><button type="submit" class="ec-form-submit">${s && s.price > 0 ? (s.deposit > 0 ? `Book & pay ${money(s.deposit, data.currency)} deposit` : `Book & pay ${money(s.price, data.currency)}`) : "Confirm booking"}</button></div>
						<p class="ec-form-status" data-status aria-live="polite"></p>
					</form>
				</section>
			</div>`;
		if (state.slot && s?.intakeFormId) void mountIntake(root.querySelector<HTMLElement>("[data-intake]")!, s.intakeFormId);
	};

	const loadDays = async () => {
		if (!state.service) return;
		state.days = [];
		draw();
		try {
			const r = await pub<{ days: string[] }>("days", { serviceId: state.service.id, days: Math.min(31, data.horizonDays) });
			state.days = r.days;
			if (!state.day || !state.days.includes(state.day)) state.day = state.days[0] ?? "";
		} catch {
			state.days = [];
		}
		await loadSlots();
	};
	const loadSlots = async () => {
		if (!state.service || !state.day) return draw();
		try {
			const r = await pub<{ slots: Slot[] }>("availability", { serviceId: state.service.id, date: state.day, resourceId: state.staffId || undefined });
			state.slots = r.slots;
		} catch {
			state.slots = [];
		}
		draw();
	};

	root.addEventListener("click", (e) => {
		const t = (e.target as HTMLElement).closest<HTMLElement>("[data-service],[data-day],[data-slot],[data-reset]");
		if (!t) return;
		if (t.dataset.service) {
			state.service = data.services.find((x) => x.id === t.dataset.service) ?? null;
			state.slot = null;
			state.staffId = "";
			void loadDays();
		} else if (t.dataset.day) {
			state.day = t.dataset.day;
			void loadSlots();
		} else if (t.dataset.slot) {
			state.slot = state.slots.find((x) => x.startsAt === t.dataset.slot && x.staffId === t.dataset.slotStaff) ?? null;
			draw();
		} else if (t.dataset.reset === "service") {
			state.service = null;
			state.slot = null;
			draw();
		} else if (t.dataset.reset === "slot") {
			state.slot = null;
			draw();
		}
	});
	root.addEventListener("change", (e) => {
		const t = e.target as HTMLSelectElement;
		if (t.matches("[data-staff]")) {
			state.staffId = t.value;
			void loadSlots();
		}
	});
	root.addEventListener("submit", async (e) => {
		const form = (e.target as HTMLElement).closest<HTMLFormElement>("[data-booking-form]");
		if (!form || !state.service || !state.slot) return;
		e.preventDefault();
		const status = form.querySelector<HTMLElement>("[data-status]")!;
		const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
		btn.disabled = true;
		status.textContent = "Holding your slot…";
		try {
			// Intake form first (the forms plugin stores it; we link the submission to the booking).
			let intakeSubmissionId: string | undefined;
			const intake = form.querySelector<HTMLElement>("[data-intake][data-form-id]");
			if (intake) {
				const data = intakeData(intake);
				const r = await fetch(`${FORMS}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ formId: intake.dataset.formId, data }) });
				const j = (await r.json().catch(() => ({}))) as { success?: boolean; data?: { success?: boolean; submissionId?: string; errors?: Array<{ field: string; message: string }> }; error?: { message?: string } };
				const res = j.data ?? {};
				if (!r.ok || res.success === false) throw new Error(res.errors?.[0]?.message ?? j.error?.message ?? "Please check the form");
				intakeSubmissionId = res.submissionId;
			}
			const customer = { name: (form.elements.namedItem("name") as HTMLInputElement).value.trim(), email: (form.elements.namedItem("email") as HTMLInputElement).value.trim(), phone: (form.elements.namedItem("phone") as HTMLInputElement).value.trim() || undefined };
			const held = await pub<{ booking: { id: string; status: string; price: number }; token: string; checkoutItem: { productId: string; quantity: number } | null }>("hold", { serviceId: state.service.id, resourceId: state.slot.staffId, startsAt: state.slot.startsAt, customer, notes: (form.elements.namedItem("notes") as HTMLInputElement).value.trim() || undefined, intakeSubmissionId });
			if (!held.checkoutItem) {
				location.assign(`${location.pathname}?booking=${held.booking.id}&token=${held.token}`);
				return;
			}
			status.textContent = "Slot held — taking you to payment…";
			const body = { items: [held.checkoutItem], method: "online", email: customer.email, name: customer.name, phone: customer.phone, successUrl: `${location.origin}${location.pathname}?booking=${held.booking.id}&token=${held.token}`, cancelUrl: `${location.origin}${location.pathname}` };
			const result = me ? await sessionApi<{ url: string; paid?: boolean }>("checkout/account", body) : await pub<{ url: string }>("checkout", body, COMMERCE);
			location.assign(result.url);
		} catch (err) {
			status.textContent = err instanceof Error ? err.message : "Could not book";
			status.classList.add("ec-form-status--error");
			btn.disabled = false;
		}
	});

	if (preselect) {
		state.service = data.services.find((x) => x.id === preselect || x.slug === preselect) ?? null;
		if (state.service) await loadDays();
		else draw();
	} else draw();
}

async function mountIntake(host: HTMLElement, formId: string): Promise<void> {
	try {
		const r = await fetch(`${FORMS}/definition?id=${encodeURIComponent(formId)}`);
		const j = (await r.json()) as { data?: unknown };
		const mod = await import("../premium-forms/forms");
		const def = (j.data ?? j) as Parameters<typeof mod.renderForm>[0];
		// The widget is itself a <form>; a nested <form> tag is dropped by the
		// parser, so the intake fields simply join the booking form and are
		// picked out again by [data-intake] at submit time.
		host.innerHTML = `<h3 class="bk__intake-title">Before your visit</h3>${mod.renderForm(def, formId)}`;
		host.dataset.formId = formId;
		host.querySelectorAll(".ec-form-nav, .ec-form-submit, button[type=submit], [data-form-status]").forEach((el) => el.remove());
		mod.initSignaturePads(host);
	} catch {
		host.innerHTML = "";
		delete host.dataset.formId;
	}
}

/** Values of the intake fields (inside [data-intake]) in the forms plugin's submit shape. */
function intakeData(host: HTMLElement): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]").forEach((el) => {
		if (el.disabled || !el.name || el.name === "formId") return;
		if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
			if (!el.checked) return;
			const cur = data[el.name];
			data[el.name] = cur === undefined ? el.value : ([] as string[]).concat(cur as string[], el.value);
			return;
		}
		if (el instanceof HTMLInputElement && el.type === "file") return;
		data[el.name] = el.value;
	});
	return data;
}

async function renderConfirmation(root: HTMLElement, id: string, token: string): Promise<void> {
	try {
		const { booking } = await pub<{ booking: { service: string; staff: string; when: string; status: string; price: number; deposit: number; customer: { name: string; email: string } } }>("lookup", { id, token });
		const pendingPay = booking.status === "held" || booking.status === "pending_payment";
		root.innerHTML = `<div class="bk bk--confirm">
			<h2>${booking.status === "confirmed" ? "You're booked" : pendingPay ? "Finishing your booking…" : booking.status === "cancelled" ? "This booking was cancelled" : "Booking"}</h2>
			<p><strong>${esc(booking.service)}</strong><br>${esc(booking.when)} with ${esc(booking.staff)}</p>
			<p class="ec-form-help">${pendingPay ? "If you just paid, this page updates within a minute. Otherwise your slot is held for a short time — complete payment to confirm." : `A confirmation has been sent to ${esc(booking.customer.email)}.`}</p>
			${booking.status === "confirmed" ? `<p><button type="button" class="ec-link" data-cancel-booking>Cancel this appointment</button></p>` : ""}
			<p><a href="/">← Back to the site</a></p>
		</div>`;
		if (pendingPay) window.setTimeout(() => renderConfirmation(root, id, token), 8000);
		root.querySelector("[data-cancel-booking]")?.addEventListener("click", async () => {
			if (!confirm("Cancel this appointment?")) return;
			try {
				await pub("cancel", { id, token });
				void renderConfirmation(root, id, token);
			} catch (err) {
				alert(err instanceof Error ? err.message : "Could not cancel");
			}
		});
	} catch (err) {
		root.innerHTML = `<p class="ec-form-status--error">${esc(err instanceof Error ? err.message : "Booking not found")}</p>`;
	}
}

export function initBooking(): void {
	document.querySelectorAll<HTMLElement>("[data-booking]").forEach((el) => void renderBooking(el));
}
