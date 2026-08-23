/** Descriptor (build-time) — for sites that prefer config installs over the marketplace. */
export function premiumBookings() {
	return {
		id: "premium-bookings",
		version: "1.0.1",
		format: "standard" as const,
		entrypoint: "premium-bookings/sandbox",
		options: {},
		capabilities: ["email:send", "users:read", "plugins:call"],
		allowedHosts: [],
	};
}
