const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function minorUnits(price: number, currency: string): number {
	const factor = ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100;
	return Math.round(Number(price) * factor);
}

export function formatMoney(amount: number, currency: string): string {
	const cur = currency.toUpperCase();
	const factor = ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100;
	try {
		return new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(amount / factor);
	} catch {
		return `${(amount / factor).toFixed(factor === 1 ? 0 : 2)} ${cur}`;
	}
}
