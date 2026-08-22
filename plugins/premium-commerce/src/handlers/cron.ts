import { cancelOrder, orders } from "../orders.js";
import type { PluginContext } from "../shim.js";

/** Release stock held by checkouts that never completed. */
export async function expirePendingOrders(ctx: PluginContext): Promise<number> {
	const now = new Date().toISOString();
	const res = await orders(ctx).query({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, limit: 100 });
	let n = 0;
	for (const { id, data } of res.items) {
		if (data.expiresAt && data.expiresAt < now) {
			await cancelOrder(ctx, id, data, "checkout expired");
			n++;
		}
	}
	return n;
}
