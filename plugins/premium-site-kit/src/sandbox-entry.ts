/**
 * premium-site-kit — the "everything a business site needs" plugin:
 * business profile → schema.org JSON-LD, analytics (GA4 / GTM / Cloudflare)
 * gated by a consent banner, Search Console verification, and a live
 * Google reviews feed. The storefront reads `config` at build/render time.
 */

import { definePlugin, route, type PluginContext, type RouteContext } from "./shim.js";
import { PluginRouteError } from "./shim.js";

const KEYS = ["businessType", "businessName", "phone", "email", "streetAddress", "locality", "region", "postalCode", "country", "latitude", "longitude", "openingHours", "priceRange", "sameAs", "logoUrl", "imageUrl", "ga4Id", "gtmId", "cfBeaconToken", "searchConsoleToken", "consentEnabled", "consentTitle", "consentText", "privacyUrl", "googlePlacesApiKey", "googlePlaceId", "reviewsMinRating"] as const;
type Settings = Record<(typeof KEYS)[number], unknown>;

async function settings(ctx: PluginContext): Promise<Settings> {
	const kv = ctx.kv as { list?: (prefix?: string) => Promise<Array<{ key: string; value: unknown }>> };
	if (typeof kv.list === "function") {
		const rows = await kv.list("settings:").catch(() => null);
		if (Array.isArray(rows) && rows.length) {
			const bag = Object.fromEntries(rows.map((r) => [r.key.replace(/^settings:/, ""), r.value]));
			return Object.fromEntries(KEYS.map((k) => [k, bag[k]])) as Settings;
		}
	}
	const values = await Promise.all(KEYS.map((k) => ctx.kv.get<unknown>(`settings:${k}`)));
	return Object.fromEntries(KEYS.map((k, i) => [k, values[i]])) as Settings;
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => str(v).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);

export function buildJsonLd(s: Settings, siteUrl: string, siteTitle: string): Record<string, unknown> | null {
	const name = str(s.businessName) || siteTitle;
	if (!name) return null;
	const address = str(s.streetAddress) || str(s.locality) ? { "@type": "PostalAddress", streetAddress: str(s.streetAddress) || undefined, addressLocality: str(s.locality) || undefined, addressRegion: str(s.region) || undefined, postalCode: str(s.postalCode) || undefined, addressCountry: str(s.country) || undefined } : undefined;
	const lat = Number(s.latitude);
	const lng = Number(s.longitude);
	const geo = Number.isFinite(lat) && Number.isFinite(lng) && str(s.latitude) && str(s.longitude) ? { "@type": "GeoCoordinates", latitude: lat, longitude: lng } : undefined;
	const out: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": str(s.businessType) || "LocalBusiness",
		"@id": `${siteUrl}/#business`,
		name,
		url: siteUrl || undefined,
		telephone: str(s.phone) || undefined,
		email: str(s.email) || undefined,
		address,
		geo,
		openingHours: list(s.openingHours).length ? list(s.openingHours) : undefined,
		priceRange: str(s.priceRange) || undefined,
		sameAs: list(s.sameAs).length ? list(s.sameAs) : undefined,
		logo: str(s.logoUrl) || undefined,
		image: str(s.imageUrl) || str(s.logoUrl) || undefined,
	};
	for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
	return out;
}

async function configHandler(ctx: RouteContext) {
	const s = await settings(ctx);
	const siteUrl = ctx.site?.url?.replace(/\/$/, "") ?? "";
	return {
		analytics: { ga4Id: str(s.ga4Id) || null, gtmId: str(s.gtmId) || null, cfBeaconToken: str(s.cfBeaconToken) || null, searchConsoleToken: str(s.searchConsoleToken) || null },
		consent: s.consentEnabled === true ? { title: str(s.consentTitle) || "We use cookies", text: str(s.consentText) || "We use essential cookies to make the site work and, with your consent, analytics cookies to understand how it is used.", privacyUrl: str(s.privacyUrl) || "/privacy" } : null,
		business: buildJsonLd(s, siteUrl, ""),
		reviewsConfigured: Boolean(str(s.googlePlacesApiKey) && str(s.googlePlaceId)),
	};
}

interface PlaceReview { author_name: string; rating: number; text: string; relative_time_description: string; profile_photo_url?: string; time: number }
interface ReviewsPayload { name: string; rating: number | null; total: number; reviews: Array<{ author: string; rating: number; text: string; when: string; avatar: string | null }>; fetchedAt: string; placeUrl: string | null }

async function fetchReviews(ctx: PluginContext, s: Settings): Promise<ReviewsPayload | null> {
	const key = str(s.googlePlacesApiKey);
	const placeId = str(s.googlePlaceId);
	if (!key || !placeId || !ctx.http) return null;
	const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,rating,user_ratings_total,reviews,url&reviews_sort=newest&key=${encodeURIComponent(key)}`;
	const res = await ctx.http.fetch(url);
	const json = (await res.json().catch(() => ({}))) as { status?: string; error_message?: string; result?: { name?: string; rating?: number; user_ratings_total?: number; url?: string; reviews?: PlaceReview[] } };
	if (!res.ok || json.status !== "OK" || !json.result) throw new Error(`Google Places: ${json.status ?? res.status} ${json.error_message ?? ""}`.trim());
	const min = Number(s.reviewsMinRating) || 0;
	const r = json.result;
	return {
		name: r.name ?? "",
		rating: r.rating ?? null,
		total: r.user_ratings_total ?? 0,
		reviews: (r.reviews ?? []).filter((x) => x.rating >= min).map((x) => ({ author: x.author_name, rating: x.rating, text: x.text, when: x.relative_time_description, avatar: x.profile_photo_url ?? null })),
		fetchedAt: new Date().toISOString(),
		placeUrl: r.url ?? null,
	};
}

async function reviewsHandler(ctx: RouteContext) {
	const cached = await ctx.kv.get<ReviewsPayload>("reviews:cache");
	if (cached && Date.now() - Date.parse(cached.fetchedAt) < 6 * 3_600_000) return cached;
	const s = await settings(ctx);
	try {
		const fresh = await fetchReviews(ctx, s);
		if (!fresh) return cached ?? { name: "", rating: null, total: 0, reviews: [], fetchedAt: new Date().toISOString(), placeUrl: null, configured: false };
		await ctx.kv.set("reviews:cache", fresh);
		return fresh;
	} catch (err) {
		if (cached) return cached;
		throw PluginRouteError.badRequest(err instanceof Error ? err.message : "Could not load reviews");
	}
}

async function refreshHandler(ctx: RouteContext) {
	const s = await settings(ctx);
	const fresh = await fetchReviews(ctx, s);
	if (!fresh) throw PluginRouteError.badRequest("Add the Google Places API key and Place ID in the plugin settings first");
	await ctx.kv.set("reviews:cache", fresh);
	return { ok: true, reviews: fresh.reviews.length, rating: fresh.rating };
}


/* ---- config export (theme snapshots) ---------------------------------------- */

/** Non-secret settings as a theme-seed fragment (the Places API key stays out). */
async function configExportHandler(ctx: PluginContext) {
	const s = await settings(ctx);
	const out: Record<string, unknown> = {};
	for (const k of KEYS) {
		if (k === "googlePlacesApiKey") continue;
		const v = (s as Record<string, unknown>)[k];
		if (v !== undefined && v !== null && v !== "") out[k] = v;
	}
	return { settings: out, calls: [] };
}

export default definePlugin({
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				if (ctx.cron) await ctx.cron.schedule("refresh-reviews", { schedule: "0 */6 * * *" }).catch(() => {});
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name !== "refresh-reviews") return;
				const s = await settings(ctx);
				const fresh = await fetchReviews(ctx, s).catch(() => null);
				if (fresh) await ctx.kv.set("reviews:cache", fresh);
			},
		},
	},
	routes: {
		config: { public: true, handler: route(configHandler as never) },
		reviews: { public: true, handler: route(reviewsHandler as never) },
		"reviews/refresh": { handler: route(refreshHandler as never) },
		"config/export": { handler: route(configExportHandler as never) },
	},
});
