/** Build-time hooks of the Site Kit frontend: schema.org, analytics tags and the consent config in <head>. */
import type { PluginHeadContext } from "../server";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const jsonScript = (s: unknown) => JSON.stringify(s).replace(/</g, "\\u003c");

export function head({ layout }: PluginHeadContext): string {
	const kit = layout.siteKit;
	if (!kit) return "";
	const parts: string[] = [];
	if (kit.analytics.searchConsoleToken) parts.push(`<meta name="google-site-verification" content="${esc(kit.analytics.searchConsoleToken)}">`);
	if (kit.business) parts.push(`<script type="application/ld+json">${jsonScript(kit.business)}</script>`);
	parts.push(`<script id="pcx-site-kit" type="application/json">${jsonScript({ analytics: { ga4Id: kit.analytics.ga4Id, gtmId: kit.analytics.gtmId }, consent: kit.consent })}</script>`);
	if (kit.analytics.cfBeaconToken) parts.push(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${jsonScript({ token: kit.analytics.cfBeaconToken })}'></script>`);
	return parts.join("\n");
}
