/** Descriptor (build-time) — for sites that prefer config installs over the marketplace. */
export function premiumForms() {
	return {
		id: "premium-forms",
		version: "0.4.1",
		format: "standard" as const,
		entrypoint: "premium-forms/sandbox",
		options: {},
		capabilities: ["email:send", "network:request:unrestricted", "media:write"],
		allowedHosts: [],
	};
}
