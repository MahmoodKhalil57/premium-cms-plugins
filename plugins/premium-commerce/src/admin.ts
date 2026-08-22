/**
 * Block Kit admin (works on any EmDash admin; the PremiumCMS admin adds
 * richer React screens on top of the same routes).
 *
 * Pages: "/" orders, "/inventory", "/discounts"; widget "sales".
 */

import { lineSummary } from "./pricing.js";
import { discountDeleteHandler, discountSaveHandler, discountsListHandler, inventoryAdjustHandler, inventoryListHandler, orderRefundHandler, ordersListHandler, orderUpdateHandler, statsHandler } from "./handlers/admin-api.js";
import type { DiscountRecord } from "./discounts.js";
import { formatMoney } from "./money.js";
import type { PluginContext, RouteContext } from "./shim.js";
import type { Order, OrderStatus } from "./types.js";

type Block = Record<string, unknown>;
type Toast = { message: string; type: "success" | "error" | "info" };
interface Interaction {
	type: "page_load" | "form_submit" | "block_action";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
	value?: unknown;
}

const ROUTE_BASE = "/_emdash/api/plugins/premium-commerce";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const asCtx = <T>(ctx: PluginContext, input: T): RouteContext<T> => ({ ...ctx, input, request: (ctx as RouteContext).request }) as RouteContext<T>;

const STATUS_OPTIONS: Array<{ label: string; value: OrderStatus | "" }> = [
	{ label: "All statuses", value: "" },
	{ label: "Paid — to fulfil", value: "paid" },
	{ label: "Awaiting payment (pay-later)", value: "awaiting_payment" },
	{ label: "Fulfilled", value: "fulfilled" },
	{ label: "Pending checkout", value: "pending" },
	{ label: "Cancelled", value: "cancelled" },
	{ label: "Refunded", value: "refunded" },
	{ label: "Failed", value: "failed" },
];

function ordersTable(items: Array<{ id: string } & Order>): Block {
	return {
		type: "table",
		block_id: "orders",
		columns: [
			{ key: "number", label: "#", format: "code" },
			{ key: "createdAt", label: "Placed", format: "relative_time" },
			{ key: "customer", label: "Customer" },
			{ key: "items", label: "Items" },
			{ key: "total", label: "Total" },
			{ key: "payment", label: "Payment" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "id", label: "Order id", format: "code" },
		],
		rows: items.map((o) => ({
			number: String(o.number),
			createdAt: o.createdAt,
			customer: o.customerName ? `${o.customerName} <${o.email}>` : o.email || "—",
			items: o.items.map((i) => `${i.quantity}× ${i.title}${lineSummary(i)}${i.customization ? " ★design" : ""}`).join(", "),
			total: formatMoney(o.total, o.currency),
			payment: o.paymentMethod === "stripe" ? "Stripe" : o.paymentMethod === "polar" ? "Polar" : "Pay later",
			status: o.status,
			id: o.id,
		})),
	};
}

function manageForm(items: Array<{ id: string } & Order>, status: string): Block[] {
	const blocks: Block[] = [
		{
			type: "form",
			block_id: "filter",
			fields: [{ type: "select", action_id: "status", label: "Show", initial_value: status, options: STATUS_OPTIONS }],
			submit: { label: "Filter", action_id: "filter_orders" },
		},
	];
	if (items.length > 0) {
		blocks.push({
			type: "form",
			block_id: "manage",
			fields: [
				{ type: "select", action_id: "orderId", label: "Order", options: items.map((o) => ({ label: `#${o.number} — ${o.email || "no email"} — ${formatMoney(o.total, o.currency)} (${o.status})`, value: o.id })) },
				{
					type: "select",
					action_id: "action",
					label: "Action",
					initial_value: "fulfil",
					options: [
						{ label: "Mark fulfilled (emails the customer)", value: "fulfil" },
						{ label: "Mark paid (pay-later orders)", value: "paid" },
						{ label: "Save tracking / note only", value: "note" },
						{ label: "Cancel (restocks)", value: "cancel" },
						{ label: "Refund in full (online payment)", value: "refund" },
					],
				},
				{ type: "text_input", action_id: "tracking", label: "Tracking number / link (optional)" },
				{ type: "text_input", action_id: "note", label: "Note (optional)" },
			],
			submit: { label: "Apply", action_id: "manage_order" },
		});
	}
	return blocks;
}

async function ordersPage(ctx: PluginContext, status = "", toast?: Toast): Promise<{ blocks: Block[]; toast?: Toast }> {
	const stats = await statsHandler(asCtx(ctx, {}));
	const list = await ordersListHandler(asCtx(ctx, { status: status || undefined, limit: 50 }));
	const blocks: Block[] = [
		{ type: "header", text: "Orders" },
		{
			type: "stats",
			items: [
				{ label: "Revenue (30d)", value: stats.revenue30dFormatted },
				{ label: "Paid orders (30d)", value: stats.paid30d },
				{ label: "To fulfil", value: stats.toFulfil },
				{ label: "Awaiting payment", value: stats.awaitingPayment },
			],
		},
		...manageForm(list.items, status),
		list.items.length > 0 ? ordersTable(list.items) : { type: "context", text: "No orders yet. Once the storefront is live, checkouts appear here." },
		{ type: "divider" },
		{ type: "context", text: `Export: ${ROUTE_BASE}/orders/export?format=csv (or json) while signed in. Webhook URLs (configure the provider in Settings): <your site>/commerce-webhook/stripe or /commerce-webhook/polar. ★design lines carry a print design: GET ${ROUTE_BASE}/orders/design?id=<order>&line=<n> returns the production SVG; orders/get has the full design JSON and preview.` },
	];
	return toast ? { blocks, toast } : { blocks };
}

async function inventoryPage(ctx: PluginContext, toast?: Toast): Promise<{ blocks: Block[]; toast?: Toast }> {
	const inv = await inventoryListHandler(asCtx(ctx, {}));
	const blocks: Block[] = [
		{ type: "header", text: "Inventory" },
		{ type: "context", text: "Stock is set on each product (Products collection). Reserved = open checkouts; sold = completed orders. Available = stock − sold − reserved." },
		inv.items.length > 0
			? {
					type: "table",
					block_id: "inventory",
					columns: [
						{ key: "title", label: "Product" },
						{ key: "sku", label: "SKU", format: "code" },
						{ key: "price", label: "Price" },
						{ key: "stock", label: "Stock" },
						{ key: "reserved", label: "Reserved", format: "number" },
						{ key: "sold", label: "Sold", format: "number" },
						{ key: "available", label: "Available" },
						{ key: "productId", label: "Product id", format: "code" },
					],
					rows: inv.items.map((p) => ({
						title: p.title,
						sku: p.sku ?? "",
						price: formatMoney(p.unitAmount, inv.currency),
						stock: p.stock === null ? "∞" : String(p.stock),
						reserved: p.reserved,
						sold: p.sold,
						available: p.available === null ? "∞" : String(p.available),
						productId: p.productId,
					})),
				}
			: { type: "context", text: "No published products with a price yet. Add entries to the Products collection." },
	];
	if (inv.items.length > 0) {
		blocks.push({
			type: "form",
			block_id: "adjust",
			fields: [
				{ type: "select", action_id: "productId", label: "Product", options: inv.items.map((p) => ({ label: `${p.title}${p.sku ? ` (${p.sku})` : ""}`, value: p.productId })) },
				{ type: "number_input", action_id: "sold", label: "Set sold count", min: 0 },
				{ type: "number_input", action_id: "reserved", label: "Set reserved count (0 clears stuck reservations)", min: 0 },
			],
			submit: { label: "Adjust", action_id: "adjust_inventory" },
		});
	}
	return toast ? { blocks, toast } : { blocks };
}

async function widget(ctx: PluginContext) {
	const stats = await statsHandler(asCtx(ctx, {}));
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Revenue (30d)", value: stats.revenue30dFormatted },
					{ label: "To fulfil", value: stats.toFulfil },
				],
			},
			{
				type: "table",
				columns: [
					{ key: "number", label: "#", format: "code" },
					{ key: "total", label: "Total" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "createdAt", label: "Placed", format: "relative_time" },
				],
				rows: stats.recent.map((o) => ({ number: String(o.number), total: formatMoney(o.total, o.currency), status: o.status, createdAt: o.createdAt })),
			},
		],
	};
}

const YES_NO = [{ label: "Yes", value: "true" }, { label: "No", value: "false" }];
const DISCOUNT_TYPES = [
	{ label: "Percentage off each eligible product", value: "percent" },
	{ label: "Fixed amount off each eligible product", value: "fixed_product" },
	{ label: "Fixed amount off the cart (code only)", value: "fixed_cart" },
];

async function discountsPage(ctx: PluginContext, toast?: Toast, editId = ""): Promise<{ blocks: Block[]; toast?: Toast }> {
	const list = await discountsListHandler(asCtx(ctx, { limit: 100 }));
	const editing = editId ? list.items.find((d) => d.id === editId) : undefined;
	const amountLabel = (d: DiscountRecord) => (d.type === "percent" ? `${d.amount}%` : `${d.amount} ${d.type === "fixed_cart" ? "off cart" : "off each"}`);
	const blocks: Block[] = [
		{ type: "header", text: "Discounts" },
		{ type: "context", text: "Automatic discounts (no code) show as sale prices on the products they cover and apply by themselves at checkout. Coupon codes are entered in the bag. Limit either to products (ids or slugs, comma-separated), a minimum spend, dates and usage counts." },
		list.items.length > 0
			? {
					type: "table",
					block_id: "discounts",
					columns: [
						{ key: "title", label: "Title" },
						{ key: "code", label: "Code", format: "code" },
						{ key: "amount", label: "Discount" },
						{ key: "scope", label: "Products" },
						{ key: "rules", label: "Rules" },
						{ key: "uses", label: "Uses" },
						{ key: "status", label: "Status", format: "badge" },
						{ key: "id", label: "Id", format: "code" },
					],
					rows: list.items.map((d) => ({
						title: d.title,
						code: d.code ?? "automatic",
						amount: amountLabel(d),
						scope: d.products.length ? d.products.join(", ") : "all products" + (d.excludeProducts.length ? ` (except ${d.excludeProducts.join(", ")})` : ""),
						rules: [d.minSubtotal ? `min ${d.minSubtotal}` : "", d.startsAt ? `from ${d.startsAt.slice(0, 10)}` : "", d.endsAt ? `until ${d.endsAt.slice(0, 10)}` : "", d.freeShipping ? "free shipping" : ""].filter(Boolean).join(" · ") || "—",
						uses: `${d.usedCount}${d.maxUses ? ` / ${d.maxUses}` : ""}${d.usesPerCustomer ? ` (${d.usesPerCustomer}/customer)` : ""}`,
						status: d.active ? (d.endsAt && Date.parse(d.endsAt) < Date.now() ? "expired" : "active") : "inactive",
						id: d.id,
					})),
				}
			: { type: "context", text: "No discounts yet." },
		{ type: "divider" },
		{
			type: "form",
			block_id: "discount_form",
			title: editing ? `Edit “${editing.title}”` : "New discount",
			fields: [
				{ type: "text_input", action_id: "title", label: "Title (shown to shoppers)", initial_value: editing?.title ?? "" },
				{ type: "text_input", action_id: "code", label: "Code (leave empty for an automatic discount)", initial_value: editing?.code ?? "" },
				{ type: "select", action_id: "type", label: "Type", initial_value: editing?.type ?? "percent", options: DISCOUNT_TYPES },
				{ type: "number_input", action_id: "amount", label: "Amount (percent, or currency units)", min: 0, initial_value: editing?.amount ?? 10 },
				{ type: "text_input", action_id: "products", label: "Only these products (ids or slugs, comma-separated; empty = all)", initial_value: editing?.products.join(", ") ?? "" },
				{ type: "text_input", action_id: "excludeProducts", label: "Except these products", initial_value: editing?.excludeProducts.join(", ") ?? "" },
				{ type: "number_input", action_id: "minSubtotal", label: "Minimum spend on eligible items (empty = none)", min: 0, initial_value: editing?.minSubtotal ?? "" },
				{ type: "number_input", action_id: "maxUses", label: "Maximum uses in total (empty = unlimited)", min: 0, initial_value: editing?.maxUses ?? "" },
				{ type: "number_input", action_id: "usesPerCustomer", label: "Uses per customer (empty = unlimited)", min: 0, initial_value: editing?.usesPerCustomer ?? "" },
				{ type: "text_input", action_id: "startsAt", label: "Starts (YYYY-MM-DD, optional)", initial_value: editing?.startsAt?.slice(0, 10) ?? "" },
				{ type: "text_input", action_id: "endsAt", label: "Ends (YYYY-MM-DD, optional)", initial_value: editing?.endsAt?.slice(0, 10) ?? "" },
				{ type: "select", action_id: "freeShipping", label: "Free shipping", initial_value: editing?.freeShipping ? "true" : "false", options: YES_NO },
				{ type: "select", action_id: "active", label: "Active", initial_value: editing === undefined || editing.active ? "true" : "false", options: YES_NO },
				{ type: "text_input", action_id: "id", label: "Editing id (leave empty to create)", initial_value: editing?.id ?? "" },
			],
			submit: { label: editing ? "Save changes" : "Create discount", action_id: "save_discount" },
		},
	];
	if (list.items.length > 0) {
		blocks.push({
			type: "form",
			block_id: "discount_manage",
			title: "Edit or delete",
			fields: [
				{ type: "select", action_id: "discountId", label: "Discount", options: list.items.map((d) => ({ label: `${d.title}${d.code ? ` (${d.code})` : " (automatic)"}`, value: d.id })) },
				{ type: "select", action_id: "action", label: "Action", options: [{ label: "Load into the form", value: "edit" }, { label: "Deactivate", value: "deactivate" }, { label: "Activate", value: "activate" }, { label: "Delete", value: "delete" }] },
			],
			submit: { label: "Go", action_id: "manage_discount" },
		});
	}
	return toast ? { blocks, toast } : { blocks };
}

export async function adminHandler(ctx: RouteContext<Interaction>) {
	const i = ctx.input ?? ({} as Interaction);
	const page = i.page ?? "";
	try {
		if (i.type === "page_load") {
			if (page.startsWith("widget:")) return widget(ctx);
			if (page.startsWith("/inventory")) return inventoryPage(ctx);
			if (page.startsWith("/discounts")) return discountsPage(ctx);
			return ordersPage(ctx);
		}
		const v = i.values ?? {};
		if (i.type === "form_submit" && i.action_id === "filter_orders") return ordersPage(ctx, str(v.status));
		if (i.type === "form_submit" && i.action_id === "manage_order") {
			const id = str(v.orderId);
			const action = str(v.action);
			const tracking = str(v.tracking) || undefined;
			const note = str(v.note) || undefined;
			let message = "Done";
			if (action === "fulfil") {
				await orderUpdateHandler(asCtx(ctx, { id, status: "fulfilled" as const, tracking, note }));
				message = "Order marked fulfilled";
			} else if (action === "paid") {
				await orderUpdateHandler(asCtx(ctx, { id, status: "paid" as const, tracking, note }));
				message = "Order marked paid";
			} else if (action === "cancel") {
				await orderUpdateHandler(asCtx(ctx, { id, status: "cancelled" as const, note }));
				message = "Order cancelled and stock released";
			} else if (action === "refund") {
				const r = await orderRefundHandler(asCtx(ctx, { id }));
				message = `Refund ${r.refund.status}: ${formatMoney(r.refund.amount, r.order.currency)}`;
			} else {
				await orderUpdateHandler(asCtx(ctx, { id, tracking, note }));
				message = "Saved";
			}
			return ordersPage(ctx, "", { message, type: "success" });
		}
		if (i.type === "form_submit" && i.action_id === "adjust_inventory") {
			const sold = v.sold === "" || v.sold === undefined || v.sold === null ? undefined : Number(v.sold);
			const reserved = v.reserved === "" || v.reserved === undefined || v.reserved === null ? undefined : Number(v.reserved);
			await inventoryAdjustHandler(asCtx(ctx, { productId: str(v.productId), sold, reserved }));
			return inventoryPage(ctx, { message: "Inventory adjusted", type: "success" });
		}
		if (i.type === "form_submit" && i.action_id === "save_discount") {
			const id = str(v.id) || undefined;
			const clean = (x: unknown) => (x === "" || x === undefined || x === null ? undefined : x);
			const saved = await discountSaveHandler(asCtx(ctx, { id, discount: { title: v.title, code: v.code ?? "", type: v.type, amount: v.amount, products: v.products ?? "", excludeProducts: v.excludeProducts ?? "", minSubtotal: clean(v.minSubtotal) ?? null, maxUses: clean(v.maxUses) ?? null, usesPerCustomer: clean(v.usesPerCustomer) ?? null, startsAt: clean(v.startsAt) ?? null, endsAt: clean(v.endsAt) ?? null, freeShipping: v.freeShipping, active: v.active } }));
			return discountsPage(ctx, { message: `${id ? "Saved" : "Created"} “${saved.title}”${saved.code ? ` — code ${saved.code}` : " — automatic, live on matching products"}`, type: "success" });
		}
		if (i.type === "form_submit" && i.action_id === "manage_discount") {
			const id = str(v.discountId);
			const action = str(v.action);
			if (action === "edit") return discountsPage(ctx, undefined, id);
			if (action === "delete") {
				await discountDeleteHandler(asCtx(ctx, { id }));
				return discountsPage(ctx, { message: "Discount deleted", type: "success" });
			}
			await discountSaveHandler(asCtx(ctx, { id, discount: { active: action === "activate" } }));
			return discountsPage(ctx, { message: action === "activate" ? "Discount activated" : "Discount deactivated", type: "success" });
		}
		return page.startsWith("/inventory") ? inventoryPage(ctx) : page.startsWith("/discounts") ? discountsPage(ctx) : ordersPage(ctx);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const base = page.startsWith("/inventory") ? await inventoryPage(ctx) : page.startsWith("/discounts") ? await discountsPage(ctx) : await ordersPage(ctx);
		return { blocks: [{ type: "banner", variant: "error", title: "Could not complete that", description: message }, ...base.blocks], toast: { message, type: "error" } };
	}
}
