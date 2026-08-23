/**
 * Staff app ([data-staff-app]): PIN sign-in, then POS (ring up orders, cash /
 * card, open tabs, delivery dispatch), cash drawer, kitchen display per
 * station, and the printer agent that prints queued jobs through the browser
 * (run it in a kiosk-mode browser on the till PC with --kiosk-printing).
 */
import { API } from "../../lib/client";
import { money } from "./menu";

const BASE = `${API}/_emdash/api/plugins/premium-restaurant`;
const TOKEN_KEY = "pcx-staff-token";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Session { staff: { id: string; name: string; roles: string[] }; stations: string[]; currency: string; storeName: string; timezone: string; shift: { id: string; shift: Shift } | null; modes?: string[]; tipPresets?: number[]; serviceChargePct?: number }
interface Shift { staffId: string; staffName: string; status: string; float: number; cashSales: number; cardSales: number; movements: Array<{ at: string; kind: string; amount: number; note?: string }>; orderCount: number; expectedCash: number; countedCash?: number | null; difference?: number | null; openedAt: string; closedAt?: string | null }
interface MenuItem { id: string; slug: string; title: string; unitAmount: number; options: Array<{ name: string; label: string; type: string; required?: boolean; options?: Array<{ value: string; label: string; priceDelta?: number }> }>; station: string | null }
interface PosMenu { currency: string; categories: Array<{ name: string; items: MenuItem[] }>; tables: Array<{ id: string; name: string; code: string; seats: number }>; drivers: Array<{ id: string; name: string }> }
interface OpenOrder { id: string; number: number; status: string; total: number; currency: string; customerName: string | null; phone: string | null; note: string | null; createdAt: string; items: Array<{ title: string; quantity: number; unitAmount: number; options: string | null }>; fulfilment: { mode: string; when: string; table: string | null; kitchen: string; paidVia: string | null; driverName: string | null; tip: number } | null; address: { line1?: string; line2?: string; city?: string; postalCode?: string } | null }
interface Ticket { id: string; orderNumber: number; station: string; items: Array<{ title: string; quantity: number; options?: string; notes?: string }>; status: string; mode: string; table: string | null; customer: string | null; dueAt: string | null; note?: string; createdAt: string; ageSec: number }
interface PrintJob { id: string; printerId: string; kind: string; title: string; text: string; status: string }
interface Printer { id: string; name: string; target: string; stations: string[]; kinds: string[]; width: number; active: boolean }

let token = "";
let session: Session | null = null;
let root: HTMLElement;
let cur = "usd";
const fmt = (n: number) => money(n, cur);

async function api<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
	const res = await fetch(`${BASE}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Staff-Token": token } : {}) }, body: JSON.stringify({ ...body, ...(token ? { staffToken: token } : {}) }) });
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } };
	if (!res.ok || json.success === false) {
		const msg = json.error?.message || `Request failed (${res.status})`;
		if (/sign-in required|session expired/i.test(msg)) {
			signOut();
		}
		throw new Error(msg);
	}
	return json.data as T;
}

function signOut(): void {
	token = "";
	session = null;
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {}
	renderLogin();
}

/* ---- login ------------------------------------------------------------------- */

function renderLogin(message = ""): void {
	root.innerHTML = `<div class="st-login"><h1>Staff</h1><p class="ec-form-help">Enter your PIN</p><div class="st-pin" data-pin-display>••••</div><div class="st-keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, "⌫", 0, "OK"].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join("")}</div><p class="ec-form-status ${message ? "ec-form-status--error" : ""}" data-msg>${esc(message)}</p></div>`;
	let pin = "";
	const disp = root.querySelector<HTMLElement>("[data-pin-display]")!;
	const draw = () => (disp.textContent = pin ? "•".repeat(pin.length) : "····");
	const go = async () => {
		if (pin.length < 4) return;
		try {
			const r = await api<Session & { token: string }>("staff/login", { pin });
			token = r.token;
			localStorage.setItem(TOKEN_KEY, token);
			session = r;
			cur = r.currency;
			await renderApp("pos");
		} catch (err) {
			pin = "";
			draw();
			root.querySelector("[data-msg]")!.textContent = err instanceof Error ? err.message : "Wrong PIN";
		}
	};
	root.querySelectorAll<HTMLButtonElement>("[data-key]").forEach((b) =>
		b.addEventListener("click", () => {
			const k = b.dataset.key!;
			if (k === "⌫") pin = pin.slice(0, -1);
			else if (k === "OK") void go();
			else if (pin.length < 8) pin += k;
			draw();
			if (pin.length === 4 && k !== "OK") setTimeout(() => pin.length === 4 && go(), 250);
		}),
	);
	document.onkeydown = (e) => {
		if (!root.querySelector(".st-login")) return;
		if (/^\d$/.test(e.key) && pin.length < 8) pin += e.key;
		else if (e.key === "Backspace") pin = pin.slice(0, -1);
		else if (e.key === "Enter") void go();
		draw();
	};
}

/* ---- shell ------------------------------------------------------------------- */

type View = "pos" | "orders" | "kds" | "drawer" | "printer";
let view: View = "pos";
let timer: ReturnType<typeof setInterval> | undefined;

async function renderApp(v: View): Promise<void> {
	view = v;
	clearInterval(timer);
	const s = session!;
	const can = (role: string) => s.staff.roles.includes(role) || s.staff.roles.includes("manager");
	const tabs: Array<[View, string, boolean]> = [["pos", "POS", can("server")], ["orders", "Orders", can("server") || can("driver")], ["kds", "Kitchen", can("kitchen") || can("server")], ["drawer", "Drawer", can("server")], ["printer", "Printer", true]];
	root.innerHTML = `<header class="st-bar"><strong>${esc(s.storeName || "Staff")}</strong><nav class="st-tabs">${tabs.filter((t) => t[2]).map(([id, label]) => `<button type="button" class="${id === v ? "is-active" : ""}" data-view="${id}">${label}</button>`).join("")}</nav><span class="st-who">${esc(s.staff.name)} <button type="button" class="rs-link" data-signout>Sign out</button></span></header><main class="st-main" data-main></main>`;
	root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => void renderApp(b.dataset.view as View)));
	root.querySelector("[data-signout]")!.addEventListener("click", () => {
		void api("staff/logout").catch(() => undefined);
		signOut();
	});
	const main = root.querySelector<HTMLElement>("[data-main]")!;
	if (v === "pos") await renderPos(main);
	else if (v === "orders") await renderOrders(main);
	else if (v === "kds") await renderKds(main);
	else if (v === "drawer") await renderDrawer(main);
	else await renderPrinter(main);
}

/* ---- POS ---------------------------------------------------------------------- */

interface PosLine { productId: string; title: string; unitAmount: number; quantity: number; options?: Record<string, unknown>; optionsText?: string; notes?: string }
let posMenu: PosMenu | null = null;
let lines: PosLine[] = [];
let posMode = "dine_in";
let posTable = "";

async function renderPos(main: HTMLElement): Promise<void> {
	posMenu = posMenu ?? (await api<PosMenu>("pos/menu"));
	const m = posMenu;
	const cats = m.categories.filter((c) => c.items.length);
	const modes = session!.modes ?? ["dine_in", "pickup", "delivery"];
	main.innerHTML = `<div class="st-pos"><section class="st-menu"><nav class="st-cats">${cats.map((c, i) => `<button type="button" class="${i === 0 ? "is-active" : ""}" data-cat="${i}">${esc(c.name)}</button>`).join("")}</nav><div class="st-items" data-items></div></section>
		<aside class="st-ticket"><div class="st-ticket__head"><select class="ec-form-input" data-mode>${["dine_in", "pickup", "delivery"].filter((x) => modes.includes(x) || x === "dine_in").map((x) => `<option value="${x}"${x === posMode ? " selected" : ""}>${x === "dine_in" ? "Dine-in" : x === "pickup" ? "Takeaway" : "Delivery"}</option>`).join("")}</select><select class="ec-form-input" data-table ${posMode === "dine_in" ? "" : "hidden"}><option value="">Table…</option>${m.tables.map((t) => `<option value="${t.id}"${t.id === posTable ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
		<div class="st-lines" data-lines></div>
		<div class="st-ticket__foot"><input class="ec-form-input" data-customer placeholder="Guest name / phone (optional)"><div class="st-totals" data-totals></div><div class="st-pay"><button type="button" class="st-btn st-btn--cash" data-pay="cash">Cash</button><button type="button" class="st-btn st-btn--card" data-pay="card_terminal">Card</button><button type="button" class="st-btn" data-pay="later">Send to kitchen · pay later</button><button type="button" class="rs-link" data-clear>Clear</button></div><p class="ec-form-status" data-status></p></div></aside></div>`;
	const itemsEl = main.querySelector<HTMLElement>("[data-items]")!;
	const showCat = (i: number) => {
		itemsEl.innerHTML = cats[i]!.items.map((it) => `<button type="button" class="st-item" data-item="${esc(it.id)}"><span>${esc(it.title)}</span><small>${fmt(it.unitAmount)}</small></button>`).join("");
		itemsEl.querySelectorAll<HTMLButtonElement>("[data-item]").forEach((b) => b.addEventListener("click", () => void pick(cats[i]!.items.find((x) => x.id === b.dataset.item)!)));
	};
	main.querySelectorAll<HTMLButtonElement>("[data-cat]").forEach((b) =>
		b.addEventListener("click", () => {
			main.querySelectorAll("[data-cat]").forEach((x) => x.classList.remove("is-active"));
			b.classList.add("is-active");
			showCat(Number(b.dataset.cat));
		}),
	);
	showCat(0);
	const modeSel = main.querySelector<HTMLSelectElement>("[data-mode]")!;
	const tableSel = main.querySelector<HTMLSelectElement>("[data-table]")!;
	modeSel.addEventListener("change", () => {
		posMode = modeSel.value;
		tableSel.hidden = posMode !== "dine_in";
	});
	tableSel.addEventListener("change", () => (posTable = tableSel.value));
	const drawLines = () => {
		const el = main.querySelector<HTMLElement>("[data-lines]")!;
		el.innerHTML = lines.length ? lines.map((l, i) => `<div class="st-line"><span class="st-line__qty"><button type="button" data-dec="${i}">−</button>${l.quantity}<button type="button" data-inc="${i}">+</button></span><span class="st-line__title">${esc(l.title)}${l.optionsText ? `<small>${esc(l.optionsText)}</small>` : ""}${l.notes ? `<small>! ${esc(l.notes)}</small>` : ""}</span><span class="st-line__amt">${fmt(l.unitAmount * l.quantity)}</span></div>`).join("") : `<p class="ec-form-help">Tap items to add them.</p>`;
		el.querySelectorAll<HTMLButtonElement>("[data-inc]").forEach((b) => b.addEventListener("click", () => { lines[Number(b.dataset.inc)]!.quantity++; drawLines(); }));
		el.querySelectorAll<HTMLButtonElement>("[data-dec]").forEach((b) => b.addEventListener("click", () => { const l = lines[Number(b.dataset.dec)]!; l.quantity--; if (l.quantity <= 0) lines.splice(Number(b.dataset.dec), 1); drawLines(); }));
		const sub = lines.reduce((n, l) => n + l.unitAmount * l.quantity, 0);
		const svc = posMode === "dine_in" && session!.serviceChargePct ? Math.round(sub * session!.serviceChargePct / 100) : 0;
		main.querySelector<HTMLElement>("[data-totals]")!.innerHTML = `<div><span>Subtotal</span><span>${fmt(sub)}</span></div>${svc ? `<div><span>Service ${session!.serviceChargePct}%</span><span>${fmt(svc)}</span></div>` : ""}<div class="st-totals__total"><span>Total</span><span>${fmt(sub + svc)}</span></div>`;
		main.querySelector<HTMLElement>("[data-status]")!.dataset.total = String(sub + svc);
	};
	drawLines();
	const pick = async (it: MenuItem) => {
		if (!it.options.length) {
			const ex = lines.find((l) => l.productId === it.id && !l.options && !l.notes);
			if (ex) ex.quantity++;
			else lines.push({ productId: it.id, title: it.title, unitAmount: it.unitAmount, quantity: 1 });
			drawLines();
			return;
		}
		const chosen: Record<string, unknown> = {};
		const display: string[] = [];
		let delta = 0;
		for (const f of it.options) {
			if (!f.options?.length) continue;
			const choice = prompt(`${it.title} — ${f.label}:\n${f.options.map((o, i) => `${i + 1}. ${o.label}${o.priceDelta ? ` (+${fmt(Math.round(o.priceDelta * (cur === "jpy" ? 1 : 100)))})` : ""}`).join("\n")}`, "1");
			if (choice === null) return;
			const o = f.options[Math.max(0, Number(choice) - 1)] ?? f.options[0]!;
			chosen[f.name] = o.value;
			display.push(o.label);
			delta += Math.round((o.priceDelta ?? 0) * (cur === "jpy" ? 1 : 100));
		}
		const notes = prompt("Notes for the kitchen (optional)") || undefined;
		lines.push({ productId: it.id, title: it.title, unitAmount: it.unitAmount + delta, quantity: 1, options: chosen, optionsText: display.join(", "), notes });
		drawLines();
	};
	main.querySelector("[data-clear]")!.addEventListener("click", () => { lines = []; drawLines(); });
	main.querySelectorAll<HTMLButtonElement>("[data-pay]").forEach((b) =>
		b.addEventListener("click", async () => {
			const status = main.querySelector<HTMLElement>("[data-status]")!;
			if (!lines.length) { status.textContent = "Nothing on the ticket yet."; return; }
			if (posMode === "dine_in" && !posTable) { status.textContent = "Pick a table."; return; }
			const type = b.dataset.pay as "cash" | "card_terminal" | "later";
			const total = Number(status.dataset.total ?? 0);
			let tendered: number | undefined;
			let note: string | undefined;
			if (type === "cash") {
				const t = prompt(`Total ${fmt(total)}. Cash tendered:`, String(cur === "jpy" ? total : (total / 100).toFixed(2)));
				if (t === null) return;
				tendered = Math.round(Number(t) * (cur === "jpy" ? 1 : 100));
				if (!Number.isFinite(tendered) || tendered < total) { status.textContent = "Not enough cash."; return; }
			}
			if (type === "card_terminal") note = prompt("Card terminal reference (optional)") || undefined;
			status.textContent = "Sending…";
			try {
				const r = await api<{ number: number; change: number; status: string }>("pos/order", { items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, options: l.options, notes: l.notes })), mode: posMode, tableId: posMode === "dine_in" ? posTable : undefined, customerName: main.querySelector<HTMLInputElement>("[data-customer]")!.value || undefined, payment: { type, tendered, note } });
				status.textContent = `Order #${r.number} ${type === "later" ? "sent to the kitchen" : "paid"}${r.change > 0 ? ` · change ${fmt(r.change)}` : ""}`;
				status.classList.remove("ec-form-status--error");
				lines = [];
				drawLines();
			} catch (err) {
				status.textContent = err instanceof Error ? err.message : "Failed";
				status.classList.add("ec-form-status--error");
			}
		}),
	);
}

/* ---- open orders / dispatch ----------------------------------------------------- */

async function renderOrders(main: HTMLElement): Promise<void> {
	const draw = async () => {
		const { orders } = await api<{ orders: OpenOrder[] }>("pos/orders");
		const drivers: Array<{ id: string; name: string }> = posMenu?.drivers ?? (await api<PosMenu>("pos/menu").then((m) => (posMenu = m).drivers)) ?? [];
		main.innerHTML = `<div class="st-orders">${orders.length ? orders.map((o) => `<article class="st-order st-order--${esc(o.fulfilment?.kitchen ?? "new")}"><header><strong>#${o.number}</strong> <span class="st-chip">${esc(o.fulfilment?.mode.replace("_", "-") ?? "")}${o.fulfilment?.table ? ` · ${esc(o.fulfilment.table)}` : ""}</span> <span class="st-chip st-chip--${esc(o.fulfilment?.kitchen ?? "")}">${esc(o.fulfilment?.kitchen.replace(/_/g, " ") ?? "")}</span>${o.status === "awaiting_payment" ? `<span class="st-chip st-chip--unpaid">unpaid</span>` : ""}</header><p class="st-order__meta">${esc(o.customerName ?? "")}${o.phone ? ` · ${esc(o.phone)}` : ""} · ${esc(o.fulfilment?.when ?? "")}${o.address ? `<br>${esc([o.address.line1, o.address.line2, o.address.city, o.address.postalCode].filter(Boolean).join(", "))}` : ""}</p><ul>${o.items.map((it) => `<li>${it.quantity} × ${esc(it.title)}${it.options ? ` <small>${esc(it.options)}</small>` : ""}</li>`).join("")}</ul>${o.note ? `<p class="st-order__note">${esc(o.note)}</p>` : ""}<footer><strong>${money(o.total, o.currency)}</strong><span class="st-order__actions">${o.status === "awaiting_payment" ? `<button type="button" class="st-btn st-btn--cash" data-pay="cash" data-id="${o.id}" data-total="${o.total}">Cash</button><button type="button" class="st-btn st-btn--card" data-pay="card_terminal" data-id="${o.id}">Card</button>` : ""}${o.fulfilment?.mode === "delivery" && o.fulfilment.kitchen === "ready" ? `<select class="ec-form-input" data-driver="${o.id}"><option value="">Dispatch with…</option>${drivers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}<option value="me">me</option></select>` : ""}${o.fulfilment?.kitchen === "out_for_delivery" ? `<button type="button" class="st-btn" data-delivered="${o.id}">Delivered</button>` : ""}${(o.fulfilment?.mode === "pickup" && o.fulfilment.kitchen === "ready") || (o.fulfilment?.mode === "dine_in" && o.fulfilment.kitchen === "served" && o.status !== "awaiting_payment") ? `<button type="button" class="st-btn" data-delivered="${o.id}">Done</button>` : ""}${session!.staff.roles.includes("manager") ? `<button type="button" class="rs-link" data-void="${o.id}">Void</button>` : ""}</span></footer></article>`).join("") : `<p class="ec-form-help">No open orders.</p>`}</div>`;
		main.querySelectorAll<HTMLButtonElement>("[data-pay]").forEach((b) =>
			b.addEventListener("click", async () => {
				const type = b.dataset.pay as "cash" | "card_terminal";
				let tendered: number | undefined;
				if (type === "cash") {
					const total = Number(b.dataset.total);
					const t = prompt(`Total ${fmt(total)}. Cash tendered:`, String(cur === "jpy" ? total : (total / 100).toFixed(2)));
					if (t === null) return;
					tendered = Math.round(Number(t) * (cur === "jpy" ? 1 : 100));
				}
				try {
					const r = await api<{ change: number }>("pos/pay", { orderId: b.dataset.id, type, tendered });
					if (r.change > 0) alert(`Change: ${fmt(r.change)}`);
					await draw();
				} catch (err) {
					alert(err instanceof Error ? err.message : "Failed");
				}
			}),
		);
		main.querySelectorAll<HTMLSelectElement>("[data-driver]").forEach((s) => s.addEventListener("change", async () => { if (!s.value) return; await api("pos/dispatch", { orderId: s.dataset.driver, driverId: s.value === "me" ? undefined : s.value }); await draw(); }));
		main.querySelectorAll<HTMLButtonElement>("[data-delivered]").forEach((b) => b.addEventListener("click", async () => { await api("pos/dispatch", { orderId: b.dataset.delivered, delivered: true }); await draw(); }));
		main.querySelectorAll<HTMLButtonElement>("[data-void]").forEach((b) => b.addEventListener("click", async () => { const reason = prompt("Void this order? Reason:"); if (reason === null) return; await api("pos/void", { orderId: b.dataset.void, reason }); await draw(); }));
	};
	await draw();
	timer = setInterval(() => void draw().catch(() => undefined), 8000);
}

/* ---- kitchen display ----------------------------------------------------------- */

let kdsStation = "";
async function renderKds(main: HTMLElement): Promise<void> {
	const stations = session!.stations;
	const draw = async () => {
		const { tickets } = await api<{ tickets: Ticket[] }>("kds/tickets", { station: kdsStation || undefined });
		const age = (t: Ticket) => `${Math.floor(t.ageSec / 60)}:${String(t.ageSec % 60).padStart(2, "0")}`;
		main.innerHTML = `<div class="st-kds"><nav class="st-cats"><button type="button" class="${kdsStation ? "" : "is-active"}" data-st="">All</button>${stations.map((s) => `<button type="button" class="${s === kdsStation ? "is-active" : ""}" data-st="${esc(s)}">${esc(s)}</button>`).join("")}</nav><div class="st-tickets">${tickets.length ? tickets.map((t) => `<article class="st-tk st-tk--${t.status}${t.ageSec > 900 ? " st-tk--late" : t.ageSec > 600 ? " st-tk--slow" : ""}"><header><strong>#${t.orderNumber}</strong><span>${esc(t.mode.replace("_", "-"))}${t.table ? ` · ${esc(t.table)}` : ""}</span><span class="st-tk__age">${age(t)}</span></header><ul>${t.items.map((it) => `<li><b>${it.quantity}</b> ${esc(it.title)}${it.options ? `<small>${esc(it.options)}</small>` : ""}${it.notes ? `<small>! ${esc(it.notes)}</small>` : ""}</li>`).join("")}</ul>${t.note ? `<p class="st-order__note">${esc(t.note)}</p>` : ""}<footer>${t.status === "new" ? `<button type="button" class="st-btn" data-bump="${t.id}" data-to="preparing">Start</button>` : ""}${t.status === "preparing" ? `<button type="button" class="st-btn st-btn--ready" data-bump="${t.id}" data-to="ready">Ready</button>` : ""}${t.status === "ready" ? `<button type="button" class="st-btn" data-bump="${t.id}" data-to="served">Bump</button>` : ""}<small>${esc(t.station)}</small></footer></article>`).join("") : `<p class="ec-form-help">All clear — nothing in the kitchen.</p>`}</div></div>`;
		main.querySelectorAll<HTMLButtonElement>("[data-st]").forEach((b) => b.addEventListener("click", () => { kdsStation = b.dataset.st!; void draw(); }));
		main.querySelectorAll<HTMLButtonElement>("[data-bump]").forEach((b) => b.addEventListener("click", async () => { await api("kds/bump", { id: b.dataset.bump, status: b.dataset.to }); await draw(); }));
	};
	await draw();
	timer = setInterval(() => void draw().catch(() => undefined), 5000);
}

/* ---- cash drawer ---------------------------------------------------------------- */

async function renderDrawer(main: HTMLElement): Promise<void> {
	const draw = async () => {
		const { shift } = await api<{ shift: { id: string; shift: Shift } | null }>("pos/shift");
		const s = shift?.shift;
		main.innerHTML = s
			? `<div class="st-drawer"><h2>Drawer open · ${esc(s.staffName)}</h2><p class="ec-form-help">since ${new Date(s.openedAt).toLocaleTimeString()}</p><dl class="st-kv"><dt>Float</dt><dd>${fmt(s.float)}</dd><dt>Cash sales</dt><dd>${fmt(s.cashSales)}</dd><dt>Card sales</dt><dd>${fmt(s.cardSales)}</dd><dt>Orders</dt><dd>${s.orderCount}</dd><dt>Expected cash</dt><dd><strong>${fmt(s.expectedCash)}</strong></dd></dl><div class="st-pay"><button type="button" class="st-btn" data-move="pay_in">Pay in</button><button type="button" class="st-btn" data-move="pay_out">Pay out</button>${session!.staff.roles.includes("manager") ? `<button type="button" class="st-btn st-btn--card" data-close>Close drawer (Z report)</button>` : ""}</div><ul class="st-moves">${s.movements.slice(-15).reverse().map((m) => `<li>${new Date(m.at).toLocaleTimeString()} · ${esc(m.kind.replace("_", " "))} · ${fmt(m.amount)}${m.note ? ` · ${esc(m.note)}` : ""}</li>`).join("")}</ul></div>`
			: `<div class="st-drawer"><h2>Drawer closed</h2><div class="st-pay"><button type="button" class="st-btn st-btn--cash" data-open>Open drawer</button></div></div>`;
		main.querySelector("[data-open]")?.addEventListener("click", async () => { const f = prompt("Opening float:", "100"); if (f === null) return; await api("pos/shift/open", { float: Math.round(Number(f) * (cur === "jpy" ? 1 : 100)) }); await draw(); });
		main.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((b) => b.addEventListener("click", async () => { const a = prompt(`${b.dataset.move === "pay_in" ? "Pay in" : "Pay out"} amount:`); if (a === null) return; const note = prompt("Note:") || undefined; await api("pos/shift/movement", { kind: b.dataset.move, amount: Math.round(Number(a) * (cur === "jpy" ? 1 : 100)), note }); await draw(); }));
		main.querySelector("[data-close]")?.addEventListener("click", async () => { const c = prompt("Counted cash in drawer:"); if (c === null) return; const r = await api<{ shift: { shift: Shift } }>("pos/shift/close", { counted: Math.round(Number(c) * (cur === "jpy" ? 1 : 100)) }); alert(`Z report\nExpected ${fmt(r.shift.shift.expectedCash)}\nCounted ${fmt(r.shift.shift.countedCash ?? 0)}\nDifference ${fmt(r.shift.shift.difference ?? 0)}`); await draw(); });
	};
	await draw();
}

/* ---- printer agent ----------------------------------------------------------------- */

let agentOn = false;
let printerFilter = "";
const printed = new Set<string>();

function printText(job: PrintJob): Promise<boolean> {
	return new Promise((resolve) => {
		const frame = document.createElement("iframe");
		frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
		document.body.appendChild(frame);
		const doc = frame.contentDocument!;
		doc.open();
		doc.write(`<!doctype html><html><head><title>${esc(job.title)}</title><style>@page{margin:4mm}body{margin:0;font:12px/1.25 "Courier New",monospace;white-space:pre;width:72mm}</style></head><body>${esc(job.text)}</body></html>`);
		doc.close();
		setTimeout(() => {
			try {
				frame.contentWindow!.focus();
				frame.contentWindow!.print();
				resolve(true);
			} catch {
				resolve(false);
			}
			setTimeout(() => frame.remove(), 2000);
		}, 150);
	});
}

async function renderPrinter(main: HTMLElement): Promise<void> {
	const draw = async () => {
		const { jobs, printers } = await api<{ jobs: PrintJob[]; printers: Printer[] }>("print/jobs", { printerId: printerFilter || undefined });
		const agents = printers.filter((p) => p.target === "agent" && p.active);
		main.innerHTML = `<div class="st-printer"><h2>Printer agent</h2><p class="ec-form-help">Leave this tab open on the till PC. Queued tickets and receipts for browser printers are printed here automatically — use a kiosk browser with silent printing (Chrome: <code>--kiosk-printing</code>) so no dialog appears.</p><div class="st-pay"><select class="ec-form-input" data-printer><option value="">All browser printers</option>${agents.map((p) => `<option value="${p.id}"${p.id === printerFilter ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select><button type="button" class="st-btn ${agentOn ? "st-btn--cash" : ""}" data-toggle>${agentOn ? "Agent running — stop" : "Start printing"}</button></div><p class="ec-form-help">${jobs.length} job(s) queued${agents.length ? "" : " · no browser printers configured (Admin → Plugins → Restaurant → Printers)"}.</p><ul class="st-jobs">${jobs.slice(0, 20).map((j) => `<li><span class="st-chip">${esc(j.kind)}</span> ${esc(j.title)} <button type="button" class="rs-link" data-print-now="${j.id}">print now</button></li>`).join("")}</ul></div>`;
		main.querySelector<HTMLSelectElement>("[data-printer]")!.addEventListener("change", (e) => { printerFilter = (e.target as HTMLSelectElement).value; void draw(); });
		main.querySelector("[data-toggle]")!.addEventListener("click", () => { agentOn = !agentOn; void draw(); });
		main.querySelectorAll<HTMLButtonElement>("[data-print-now]").forEach((b) => b.addEventListener("click", async () => { const j = jobs.find((x) => x.id === b.dataset.printNow)!; const ok = await printText(j); await api("print/ack", { id: j.id, status: ok ? "printed" : "failed" }); await draw(); }));
		if (agentOn) {
			for (const j of jobs) {
				if (printed.has(j.id)) continue;
				const p = printers.find((x) => x.id === j.printerId);
				if (!p || p.target !== "agent") continue;
				printed.add(j.id);
				const ok = await printText(j);
				await api("print/ack", { id: j.id, status: ok ? "printed" : "failed", error: ok ? undefined : "browser print failed" }).catch(() => undefined);
			}
		}
	};
	await draw();
	timer = setInterval(() => void draw().catch(() => undefined), 6000);
}

/* ---- boot --------------------------------------------------------------------------- */

export function initStaffApp(): void {
	const el = document.querySelector<HTMLElement>("[data-staff-app]");
	if (!el) return;
	root = el;
	try {
		token = localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {}
	if (!token) {
		renderLogin();
		return;
	}
	api<Session>("staff/me")
		.then((s) => {
			session = s;
			cur = s.currency;
			return renderApp("pos");
		})
		.catch(() => renderLogin());
}
