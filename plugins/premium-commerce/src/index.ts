/** Descriptor (build-time) — for sites that prefer config installs over the marketplace. */
export function premiumCommerce() {
	return {
		id: "premium-commerce",
		version: "0.8.1",
		format: "standard" as const,
		entrypoint: "premium-commerce/sandbox",
		options: {},
		capabilities: ["content:read", "network:request", "email:send"],
		allowedHosts: ["api.stripe.com"],
	};
}
