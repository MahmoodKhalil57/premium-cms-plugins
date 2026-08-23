/**
 * Checkout extensions — how another plugin frontend takes part in the Commerce
 * checkout without Commerce knowing it (the restaurant's delivery / pickup /
 * dine-in step, for instance). Register at module load; `activate()` runs
 * when the checkout form renders and returns null when the plugin has nothing
 * to add on this site. Whatever `read(form)` returns is sent to the server as
 * `extensions[<id>]`, where the plugin's backend validates it (see the
 * Commerce plugin README, "checkout extensions").
 */

export interface ActiveCheckoutExtension {
	id: string;
	/** Markup inserted at the top of the checkout form. */
	html(): string;
	/** Wire the inserted markup (called once after render). */
	wire?(form: HTMLFormElement, opts: { manual: boolean }): void;
	/** The plugin's part of the checkout body (`extensions[id]`). */
	read(form: HTMLFormElement): unknown;
	/** Extra top-level checkout fields the step collects (name, phone, note …). */
	extra?(form: HTMLFormElement): Record<string, unknown>;
	/** The plugin vouches for pay-later orders on this site (pay at the table / on collection). */
	allowPayLater?: boolean;
	shippingLabel?: string;
	payLaterLabel?: string;
}

export interface CheckoutExtension {
	id: string;
	activate(): Promise<ActiveCheckoutExtension | null>;
	/** Receipt-page note for a pay-later order (`order.extensions[id]` is the plugin's public meta). */
	orderNote?(order: { status: string; extensions?: Record<string, unknown> }): string | null;
}

const registry: CheckoutExtension[] = [];

export function registerCheckoutExtension(ext: CheckoutExtension): void {
	if (!registry.some((e) => e.id === ext.id)) registry.push(ext);
}

export async function activeCheckoutExtensions(): Promise<ActiveCheckoutExtension[]> {
	const out: ActiveCheckoutExtension[] = [];
	for (const ext of registry) {
		try {
			const a = await ext.activate();
			if (a) out.push(a);
		} catch {
			/* an extension that fails to activate stays out of the checkout */
		}
	}
	return out;
}

export function checkoutExtensionBody(exts: ActiveCheckoutExtension[], form: HTMLFormElement): Record<string, unknown> {
	if (!exts.length) return {};
	const extensions: Record<string, unknown> = {};
	let extra: Record<string, unknown> = {};
	for (const e of exts) {
		extensions[e.id] = e.read(form);
		extra = { ...extra, ...(e.extra?.(form) ?? {}) };
	}
	return { ...extra, extensions };
}

export function orderNoteFromExtensions(order: { status: string; extensions?: Record<string, unknown> }): string | null {
	for (const ext of registry) {
		const note = ext.orderNote?.(order);
		if (note) return note;
	}
	return null;
}
