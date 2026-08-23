/** Descriptor (build-time) — for sites that prefer config installs over the marketplace. */
export function premiumCommerce() {
	return {
		id: "premium-commerce",
		version: "1.0.2",
		format: "standard" as const,
		entrypoint: "premium-commerce/sandbox",
		options: {},
		capabilities: ["content:read", "network:request", "email:send", "plugins:call"],
		allowedHosts: ["api.stripe.com"],
	};
}
