/** Money movements per order (payments, refunds, failures) — the ledger the admin reconciles against the PSP. */

import { ulid } from "ulidx";

import type { PluginContext, StorageCollection } from "./shim.js";
import type { Order, TransactionRecord } from "./types.js";

export function transactions(ctx: PluginContext): StorageCollection<TransactionRecord> {
	return ctx.storage.transactions as StorageCollection<TransactionRecord>;
}

export async function recordTransaction(ctx: PluginContext, orderId: string, order: Order, tx: Omit<TransactionRecord, "orderId" | "orderNumber" | "currency" | "createdAt">): Promise<string> {
	// One row per provider reference: webhook + success-page confirmation may both report the same payment.
	if (tx.providerRef) {
		const dup = await transactions(ctx).query({ where: { providerRef: tx.providerRef }, limit: 1 });
		const hit = dup.items[0];
		if (hit && hit.data.kind === tx.kind) return hit.id;
	}
	const id = ulid();
	await transactions(ctx).put(id, { orderId, orderNumber: order.number, currency: order.currency, createdAt: new Date().toISOString(), ...tx });
	return id;
}
