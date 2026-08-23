/** Descriptor (build-time) — for providers that prefer a config install over the marketplace. */
export function premiumPlatform() {
	return {
		id: "premium-platform",
		version: "1.12.0",
		format: "standard" as const,
		entrypoint: "premium-platform/sandbox",
		options: {},
		capabilities: ["network:request:unrestricted", "users:read"],
		allowedHosts: [],
	};
}
