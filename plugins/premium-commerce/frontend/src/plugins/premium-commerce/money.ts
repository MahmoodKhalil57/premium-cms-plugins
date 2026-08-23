const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

/** Format a price stored in the CMS (major units) for the store currency. */
export function formatPrice(price: number | string | null | undefined, currency: string): string {
	const n = Number(price);
	if (!Number.isFinite(n)) return "";
	try {
		return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).format(n);
	} catch {
		return `${n.toFixed(ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2)} ${currency.toUpperCase()}`;
	}
}

/** Store currency for build-time formatting (set STORE_CURRENCY in the workflow or edit here). */
export const STORE_CURRENCY = (import.meta.env.STORE_CURRENCY as string | undefined) || "usd";
