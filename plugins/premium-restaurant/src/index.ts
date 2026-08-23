/** Descriptor (build-time) — for sites that prefer config installs over the marketplace. */
export function premiumRestaurant() {
	return {
		id: "premium-restaurant",
		version: "1.0.2",
		format: "standard" as const,
		entrypoint: "premium-restaurant/sandbox",
		options: {},
		capabilities: ["email:send", "users:read", "network:request", "plugins:call"],
		allowedHosts: ["api.printnode.com"],
	};
}
