/**
 * The restaurant's step in the Commerce checkout: delivery / pickup / dine-in,
 * table code or postcode, order time, tip. Registered as a checkout extension;
 * the backend's `commerce/checkout` validates what `readFulfilment` sends.
 */
import { registerCheckoutExtension } from "../premium-commerce/checkout-extensions";
import { formatCartMoney as money } from "../premium-commerce/shop";
import { api as restaurantApi, currentTable, restaurantConfig, type RestaurantConfig } from "./menu";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

registerCheckoutExtension({
	id: "premium-restaurant",
	async activate() {
		const cfg = await restaurantConfig();
		if (!cfg?.enabled) return null;
		const table = currentTable();
		return {
			id: "premium-restaurant",
			allowPayLater: cfg.payAtTable || cfg.payOnCollection,
			shippingLabel: "Delivery address",
			payLaterLabel: "Order now, pay at the counter",
			html: () => fulfilmentHtml(cfg, table),
			wire: (form, { manual }) => wireFulfilment(form, cfg, table, manual),
			read: (form) => readFulfilment(form),
			extra: (form) => ({
				name: (form.elements.namedItem("rs.name") as HTMLInputElement | null)?.value.trim() || undefined,
				phone: (form.elements.namedItem("rs.phone") as HTMLInputElement | null)?.value.trim() || undefined,
				note: (form.elements.namedItem("rs.note") as HTMLInputElement | null)?.value.trim() || undefined,
			}),
		};
	},
	orderNote(order) {
		const meta = order.extensions?.["premium-restaurant"] as { mode?: string } | undefined;
		if (!meta?.mode) return null;
		return `<p>${meta.mode === "dine_in" ? "Sent to the kitchen — pay at the table or the counter when you're done." : meta.mode === "pickup" ? "Pay when you collect." : "Pay the driver on delivery."}</p>`;
	},
});

/* ---- restaurant fulfilment step ------------------------------------------ */

function fulfilmentHtml(rs: RestaurantConfig, table: { code: string; name: string } | null): string {
	const modes = rs.modes.filter((m) => m === "delivery" || m === "pickup" || m === "dine_in");
	const initial = table ? "dine_in" : modes.includes("delivery") ? "delivery" : (modes[0] ?? "pickup");
	const label = (m: string) => (m === "dine_in" ? "Dine-in" : m === "pickup" ? "Pickup" : "Delivery");
	return `<fieldset class="ec-form-field" data-fulfilment>
		<legend class="ec-form-label">How would you like your order?</legend>
		<div class="rs-modes">${modes.map((m) => `<label><input type="radio" name="rs.mode" value="${m}"${m === initial ? " checked" : ""}><span>${label(m)}</span></label>`).join("")}</div>
		<div data-rs-dinein hidden><label class="ec-form-field"><span class="ec-form-label">Table</span><input class="ec-form-input" name="rs.table" value="${esc(table?.code ?? "")}" placeholder="Table code from the QR card (e.g. T4)"></label>${table ? `<p class="ec-form-help">Ordering for ${esc(table.name)}.</p>` : ""}</div>
		<div data-rs-delivery hidden><label class="ec-form-field"><span class="ec-form-label">Delivery postcode</span><input class="ec-form-input" name="rs.postcode" placeholder="Check we deliver to you"></label><p class="ec-form-help" data-rs-zone></p></div>
		<div data-rs-when><span class="ec-form-label">When</span><div class="rs-times" data-rs-slots><label class="rs-time is-selected"><input type="radio" name="rs.at" value="asap" checked hidden>ASAP</label></div><label class="ec-form-field"><span class="ec-form-label">Or schedule for a day</span><input class="ec-form-input" type="date" name="rs.date" min="${new Date().toISOString().slice(0, 10)}"></label></div>
		${rs.tipPresets.length ? `<div class="ec-form-field"><span class="ec-form-label">Tip for the team</span><div class="rs-tips">${rs.tipPresets.map((t, i) => `<label><input type="radio" name="rs.tip" value="${t}"${i === 0 ? " checked" : ""}>${t === 0 ? "No tip" : `${t}%`}</label>`).join("")}</div></div>` : ""}
		<div class="ec-form-row"><label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Name</span><input class="ec-form-input" name="rs.name" required></label><label class="ec-form-field ec-form-field--half"><span class="ec-form-label">Phone</span><input class="ec-form-input" name="rs.phone" type="tel" required></label></div>
		<label class="ec-form-field"><span class="ec-form-label">Notes for the kitchen / driver</span><input class="ec-form-input" name="rs.note" placeholder="Allergies, door code…"></label>
	</fieldset>`;
}

function wireFulfilment(form: HTMLFormElement, rs: RestaurantConfig, table: { code: string; name: string } | null, manual: boolean): void {
	const mode = () => (form.elements.namedItem("rs.mode") as RadioNodeList).value;
	const show = (sel: string, on: boolean) => {
		const el = form.querySelector<HTMLElement>(sel);
		if (el) el.hidden = !on;
	};
	const update = () => {
		const m = mode();
		show("[data-rs-dinein]", m === "dine_in");
		show("[data-rs-delivery]", m === "delivery");
		show("[data-shipping-block]", m === "delivery");
		show("[data-rs-when]", m !== "dine_in");
		// Hidden blocks must not take part in validation or submission.
		const blocks = form.querySelectorAll<HTMLElement>("[data-shipping-block], [data-billing], [data-rs-dinein], [data-rs-delivery], [data-rs-when]");
		blocks.forEach((b) => b.querySelectorAll<HTMLInputElement>("input, select, textarea").forEach((i) => (i.disabled = Boolean(b.hidden || b.closest("[hidden]")))));
		const manualBtn = form.querySelector<HTMLButtonElement>('[data-checkout-method="manual"]');
		if (manualBtn) {
			const allowed = m === "dine_in" ? rs.payAtTable : rs.payOnCollection;
			manualBtn.hidden = !(allowed || manual && !rs.enabled);
			manualBtn.textContent = m === "dine_in" ? "Order now, pay at the table" : m === "delivery" ? "Pay the driver on delivery" : "Pay when collecting";
		}
		if (m !== "dine_in") void loadSlots();
	};
	const slotsEl = form.querySelector<HTMLElement>("[data-rs-slots]")!;
	const loadSlots = async () => {
		const date = (form.elements.namedItem("rs.date") as HTMLInputElement).value || new Date().toISOString().slice(0, 10);
		try {
			const r = await restaurantApi<{ asap: { at: string; label: string } | null; slots: Array<{ at: string; label: string; full?: boolean }> }>("slots", { mode: mode(), date });
			const opts = [...(r.asap ? [{ at: "asap", label: r.asap.label }] : []), ...r.slots.filter((s) => !s.full).slice(0, 40)];
			slotsEl.innerHTML = opts.length ? opts.map((s, i) => `<label class="rs-time${i === 0 ? " is-selected" : ""}"><input type="radio" name="rs.at" value="${s.at}"${i === 0 ? " checked" : ""} hidden>${esc(s.label)}</label>`).join("") : `<p class="ec-form-help">No times available that day.</p>`;
			slotsEl.querySelectorAll("input").forEach((i) => i.addEventListener("change", () => { slotsEl.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected")); i.parentElement!.classList.add("is-selected"); }));
		} catch {
			slotsEl.innerHTML = `<p class="ec-form-help">Could not load times.</p>`;
		}
	};
	form.addEventListener("change", (e) => {
		const n = (e.target as HTMLInputElement).name;
		if (n === "rs.mode" || n === "sameBilling") setTimeout(update, 0);
		if (n === "rs.date") void loadSlots();
	});
	const pc = form.elements.namedItem("rs.postcode") as HTMLInputElement | null;
	pc?.addEventListener("change", async () => {
		const out = form.querySelector<HTMLElement>("[data-rs-zone]")!;
		if (!pc.value.trim()) return;
		try {
			const r = await restaurantApi<{ zone: { name: string; fee: number; minimum: number; etaMin: number } | null; message?: string }>("zone", { postcode: pc.value });
			out.textContent = r.zone ? `${r.zone.name}: delivery ${money(Math.round(r.zone.fee * 100))}${r.zone.minimum ? ` · min. order ${money(Math.round(r.zone.minimum * 100))}` : ""}${r.zone.etaMin ? ` · about ${r.zone.etaMin} min` : ""}` : (r.message ?? "We do not deliver there.");
			const postal = form.querySelector<HTMLInputElement>('[name="shipping.postalCode"]');
			if (postal && !postal.value) postal.value = pc.value;
		} catch {
			out.textContent = "";
		}
	});
	update();
}

function readFulfilment(form: HTMLFormElement): Record<string, unknown> {
	const mode = (form.elements.namedItem("rs.mode") as RadioNodeList).value;
	const at = (form.elements.namedItem("rs.at") as RadioNodeList | null)?.value;
	const tip = (form.elements.namedItem("rs.tip") as RadioNodeList | null)?.value;
	return {
		mode,
		at: mode === "dine_in" || !at || at === "asap" ? undefined : at,
		tableCode: mode === "dine_in" ? (form.elements.namedItem("rs.table") as HTMLInputElement).value.trim() : undefined,
		postcode: mode === "delivery" ? (form.elements.namedItem("rs.postcode") as HTMLInputElement).value.trim() || undefined : undefined,
		tipPercent: tip ? Number(tip) : undefined,
	};
}
