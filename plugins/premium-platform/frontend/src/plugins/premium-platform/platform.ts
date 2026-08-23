/**
 * PremiumCMS product site (the platform's own frontend): sign up / sign in by
 * email link, the customer dashboard (credits, projects, new project) and the
 * pricing block. Talks to the `premium-platform` plugin on this same site.
 *
 *   [data-platform-auth]      sign-in / sign-up form (magic link)
 *   [data-platform-account]   dashboard for the signed-in user
 *   [data-platform-pricing]   packs, what a project costs, unit prices
 *   [data-platform-session]   "Sign in" link that turns into "Account" when signed in
 */
import { API, esc } from "../../lib/client";

const BASE = `${API}/_emdash/api/plugins/premium-platform`;
const ACCOUNT_PATH = "/account";

interface Me { id: string; email: string; name?: string | null; permissions?: string[] }
interface Pricing { signups: boolean; provider: string; canBuy: boolean; packsCents: number[]; provisionFeeCents: number; preloadCents: number; maxProjects: number; markup: number; prices: Record<string, number> }
interface Credits { provider: string; canBuy: boolean; packsCents: number[]; provisionFeeCents: number; preloadCents: number; balanceCents: number; purchasedCents: number; spentCents: number; ledger: Array<{ id: string; kind: string; cents: number; note: string; createdAt: string }> }
interface Project { id: string; hostname: string; admin_email: string; site_title: string; status: string; error: string | null; preloaded_cents?: number | null; created_at: string }

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function api<T>(route: string, body: unknown = {}): Promise<T> {
	const res = await fetch(`${BASE}/${route}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify(body) });
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } };
	if (!res.ok || json.success === false) {
		const err = new Error(json.error?.message ?? `Request failed (${res.status})`) as Error & { status?: number };
		err.status = res.status;
		throw err;
	}
	return json.data as T;
}

let mePromise: Promise<Me | null> | null = null;
function whoAmI(): Promise<Me | null> {
	if (!mePromise) mePromise = fetch(`${API}/_emdash/api/auth/me`, { credentials: "include" }).then(async (r) => (r.ok ? (((await r.json()) as { data?: Me }).data ?? null) : null)).catch(() => null);
	return mePromise;
}
async function signOut(): Promise<void> {
	await fetch(`${API}/_emdash/api/auth/logout`, { method: "POST", credentials: "include", headers: { "X-EmDash-Request": "1" } }).catch(() => undefined);
	mePromise = null;
}

/* ---- sign in / sign up ------------------------------------------------------ */

function authFormHtml(mode: "signin" | "signup", redirect: string): string {
	return `<form class="pf-auth" data-auth-form data-redirect="${esc(redirect)}">
		<label class="pf-field"><span>Email</span><input type="email" name="email" required placeholder="you@example.com" autocomplete="email"></label>
		${mode === "signup" ? `<label class="pf-field"><span>Your name</span><input type="text" name="name" autocomplete="name" placeholder="Optional"></label>` : ""}
		<button type="submit" class="pf-btn pf-btn--primary">${mode === "signup" ? "Create my account" : "Email me a sign-in link"}</button>
		<p class="pf-status" data-status aria-live="polite"></p>
		<p class="pf-help">${mode === "signup" ? "No password to remember — we email you a link. By continuing you agree to the <a href=\"/terms\">Terms</a> and <a href=\"/privacy\">Privacy policy</a>." : "No password: we email you a link that signs you in. New here? <a href=\"/signup\">Create an account</a>."}</p>
	</form>`;
}

async function renderAuth(root: HTMLElement): Promise<void> {
	const me = await whoAmI();
	if (me) {
		root.innerHTML = `<p class="pf-help">You are signed in as <strong>${esc(me.email)}</strong>. <a class="pf-btn pf-btn--primary" href="${ACCOUNT_PATH}">Go to your account</a></p>`;
		return;
	}
	const mode = root.dataset.platformAuth === "signup" ? "signup" : "signin";
	root.innerHTML = authFormHtml(mode, root.dataset.redirect || ACCOUNT_PATH);
	wireAuth(root);
}

function wireAuth(root: ParentNode): void {
	root.querySelectorAll<HTMLFormElement>("[data-auth-form]:not([data-wired])").forEach((form) => {
		form.dataset.wired = "1";
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
			const name = (form.elements.namedItem("name") as HTMLInputElement | null)?.value.trim();
			const status = form.querySelector<HTMLElement>("[data-status]")!;
			const btn = form.querySelector<HTMLButtonElement>("button")!;
			btn.disabled = true;
			status.textContent = "Sending…";
			try {
				const r = await fetch(`${API}/_emdash/api/auth/customer/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, name: name || undefined, redirect: form.dataset.redirect || ACCOUNT_PATH }) });
				const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
				status.textContent = r.ok ? "Check your inbox — the link signs you in and brings you back here." : (j.error?.message ?? "Could not send the link");
				if (r.ok) form.classList.add("is-sent");
			} catch {
				status.textContent = "Could not send the link";
			}
			btn.disabled = false;
		});
	});
}

/* ---- pricing ------------------------------------------------------------------ */

const UNIT_LABELS: Record<string, [string, number]> = {
	"cf:request": ["1,000 page views / API requests", 1000],
	"cf:cpu_ms": ["1,000 ms of worker CPU", 1000],
	"cf:d1_rows_read": ["1 million database rows read", 1_000_000],
	"cf:d1_rows_written": ["1,000 database rows written", 1000],
	"cf:r2_gb_day": ["1 GB of media stored, per day", 1],
	"media:upload": ["100 media uploads", 100],
	"email:send": ["100 emails sent", 100],
	"plugin:route": ["1,000 plugin requests", 1000],
};

async function renderPricing(root: HTMLElement): Promise<void> {
	let p: Pricing;
	try {
		p = await api<Pricing>("pricing");
	} catch {
		root.innerHTML = `<p class="pf-help">Pricing is not available right now.</p>`;
		return;
	}
	const unit = (key: string) => {
		const [label, qty] = UNIT_LABELS[key] ?? [key, 1];
		const micros = (p.prices[key] ?? 0) * qty;
		return `<li><span>${esc(label)}</span><strong>${micros < 10_000 ? `${(micros / 10_000).toFixed(3)}¢` : money(Math.round(micros / 10_000))}</strong></li>`;
	};
	root.innerHTML = `
		<div class="pf-pricing">
			<div class="pf-card pf-card--accent">
				<h3>Pay as you go</h3>
				<p class="pf-big">${p.provisionFeeCents + p.preloadCents > 0 ? money(p.provisionFeeCents + p.preloadCents) : "Free"}<small> to start a site</small></p>
				<p>${p.provisionFeeCents > 0 ? `${money(p.provisionFeeCents)} setup` : "No setup fee"}${p.preloadCents > 0 ? ` + ${money(p.preloadCents)} of credits loaded into your new site` : ""}. Then usage is metered from the site's credits — top up any time, no subscription, no surprises: when credits run out the site pauses instead of billing you.</p>
				<p class="pf-help">Credit packs: ${p.packsCents.map(money).join(" · ")}${p.maxProjects ? ` · up to ${p.maxProjects} sites per account` : ""}</p>
				<a class="pf-btn pf-btn--primary" href="/signup">Create your account</a>
			</div>
			<div class="pf-card">
				<h3>What credits buy</h3>
				<ul class="pf-units">${["cf:request", "cf:cpu_ms", "cf:d1_rows_read", "cf:d1_rows_written", "cf:r2_gb_day", "media:upload", "email:send", "plugin:route"].map(unit).join("")}</ul>
				<p class="pf-help">Our cost × ${p.markup}, shown per unit; every action is itemised in your site's admin under Credits.</p>
			</div>
		</div>`;
}

/* ---- account dashboard ------------------------------------------------------- */

async function renderAccount(root: HTMLElement): Promise<void> {
	const me = await whoAmI();
	if (!me) {
		root.innerHTML = `<div class="pf-card"><h2>Sign in</h2>${authFormHtml("signin", location.pathname)}</div>`;
		wireAuth(root);
		return;
	}
	// Back from the payment provider
	const m = /[?&]credits=session:([^&]+)/.exec(location.search);
	let flash = "";
	if (m) {
		history.replaceState({}, "", location.pathname);
		try {
			const r = await api<{ credited: boolean; cents: number }>("me/credits", { op: "confirm", sessionId: decodeURIComponent(m[1]!) });
			flash = r.credited ? `${money(r.cents)} added to your credits.` : "Payment received — your credits will appear in a moment.";
		} catch (err) {
			flash = err instanceof Error ? err.message : "Could not confirm the payment";
		}
	} else if (/[?&]credits=cancelled/.test(location.search)) {
		history.replaceState({}, "", location.pathname);
		flash = "Payment cancelled — nothing was charged.";
	}
	const draw = async () => {
		let credits: Credits;
		let projects: { projects: Project[]; maxProjects: number };
		try {
			[credits, projects] = await Promise.all([api<Credits>("me/credits", { op: "status" }), api<{ projects: Project[]; maxProjects: number }>("me/projects")]);
		} catch (err) {
			root.innerHTML = `<p class="pf-status pf-status--error">${esc(err instanceof Error ? err.message : "Could not load your account")}</p>`;
			return;
		}
		const cost = credits.provisionFeeCents + credits.preloadCents;
		const canCreate = projects.projects.length < projects.maxProjects && credits.balanceCents >= cost;
		root.innerHTML = `
			<header class="pf-account-head">
				<div><h1>Your account</h1><p class="pf-help">${esc(me.email)} · <button type="button" class="pf-link" data-signout>Sign out</button></p></div>
			</header>
			${flash ? `<p class="pf-flash">${esc(flash)}</p>` : ""}
			<section class="pf-card">
				<div class="pf-row">
					<div><h2>Credits</h2><p class="pf-big">${money(credits.balanceCents)}</p><p class="pf-help">bought ${money(credits.purchasedCents)} · spent ${money(credits.spentCents)}</p></div>
					<div class="pf-packs">${credits.canBuy ? credits.packsCents.map((c) => `<button type="button" class="pf-btn" data-buy="${c}">Add ${money(c)}</button>`).join("") : `<p class="pf-help">Purchases are not enabled yet.</p>`}</div>
				</div>
				${credits.ledger.length ? `<table class="pf-table"><tbody>${credits.ledger.slice(0, 8).map((l) => `<tr><td>${new Date(l.createdAt).toLocaleDateString()}</td><td>${esc(l.note)}</td><td class="pf-num ${l.cents < 0 ? "" : "pf-pos"}">${l.cents < 0 ? "−" : "+"}${money(Math.abs(l.cents))}</td></tr>`).join("")}</tbody></table>` : ""}
			</section>
			<section class="pf-card">
				<h2>Your sites</h2>
				${projects.projects.length ? `<ul class="pf-projects">${projects.projects.map((p) => `<li><div><strong>${esc(p.site_title)}</strong> <span class="pf-badge pf-badge--${esc(p.status)}">${esc(p.status)}</span><br><a href="https://${esc(p.hostname)}" target="_blank" rel="noopener">${esc(p.hostname)}</a> · <a href="https://${esc(p.hostname)}/_emdash/admin" target="_blank" rel="noopener">open admin</a>${p.error ? `<br><span class="pf-status--error">${esc(p.error)}</span>` : ""}</div><div class="pf-actions">${p.status !== "live" && p.status !== "error" ? `<button type="button" class="pf-btn" data-resume="${esc(p.id)}">Finish setup</button>` : ""}${p.status === "error" ? `<button type="button" class="pf-btn" data-resume="${esc(p.id)}">Retry</button>` : ""}<button type="button" class="pf-link" data-delete="${esc(p.id)}">Delete</button></div></li>`).join("")}</ul>` : `<p class="pf-help">No sites yet — create your first one below.</p>`}
			</section>
			<section class="pf-card">
				<h2>New site</h2>
				<p class="pf-help">${cost > 0 ? `Creating a site takes ${money(cost)} from your credits (${credits.provisionFeeCents > 0 ? `${money(credits.provisionFeeCents)} setup` : "no setup fee"}${credits.preloadCents > 0 ? ` + ${money(credits.preloadCents)} loaded into the site` : ""}).` : "Creating a site is free; usage is metered from its credits."} ${projects.projects.length >= projects.maxProjects ? `You have reached the ${projects.maxProjects}-site limit of this account.` : ""}</p>
				<form class="pf-new" data-new-site>
					<label class="pf-field"><span>Site name <small>(becomes name.premium-cms.com)</small></span><input name="id" required pattern="[a-z][a-z0-9-]{1,28}" placeholder="my-shop" autocomplete="off"></label>
					<label class="pf-field"><span>Site title</span><input name="siteTitle" required placeholder="My Shop"></label>
					<label class="pf-field"><span>Tagline</span><input name="tagline" placeholder="Optional"></label>
					<button type="submit" class="pf-btn pf-btn--primary" ${canCreate ? "" : "disabled"}>Create site</button>
					<pre class="pf-log" data-log hidden></pre>
				</form>
				${!canCreate && credits.balanceCents < cost ? `<p class="pf-status pf-status--error">Add credits first — you need ${money(cost)} and have ${money(credits.balanceCents)}.</p>` : ""}
			</section>`;
		root.querySelector("[data-signout]")?.addEventListener("click", async () => {
			await signOut();
			location.assign("/");
		});
		root.querySelectorAll<HTMLButtonElement>("[data-buy]").forEach((b) =>
			b.addEventListener("click", async () => {
				b.disabled = true;
				try {
					const r = await api<{ url: string }>("me/credits", { op: "checkout", amountCents: Number(b.dataset.buy), origin: location.origin });
					location.assign(r.url);
				} catch (err) {
					alert(err instanceof Error ? err.message : "Could not start the payment");
					b.disabled = false;
				}
			}),
		);
		root.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((b) =>
			b.addEventListener("click", async () => {
				const id = b.dataset.delete!;
				if (prompt(`This permanently deletes ${id} and everything in it. Type the site name to confirm:`) !== id) return;
				b.disabled = true;
				try {
					await api("me/projects/step", { id, step: "destroy" });
					await draw();
				} catch (err) {
					alert(err instanceof Error ? err.message : "Could not delete");
					b.disabled = false;
				}
			}),
		);
		root.querySelectorAll<HTMLButtonElement>("[data-resume]").forEach((b) => b.addEventListener("click", () => void provision(b.dataset.resume!, root.querySelector<HTMLElement>("[data-log]")!, draw)));
		const form = root.querySelector<HTMLFormElement>("[data-new-site]");
		form?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const log = form.querySelector<HTMLElement>("[data-log]")!;
			const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
			btn.disabled = true;
			log.hidden = false;
			log.textContent = "";
			const say = (m: string) => (log.textContent += `${m}\n`);
			const id = (form.elements.namedItem("id") as HTMLInputElement).value.trim().toLowerCase();
			try {
				say("Reserving your site and creating its database, storage and worker…");
				await api("me/projects/create", { id, siteTitle: (form.elements.namedItem("siteTitle") as HTMLInputElement).value.trim(), tagline: (form.elements.namedItem("tagline") as HTMLInputElement).value.trim() || undefined });
				await provision(id, log, draw);
			} catch (err) {
				say(`✘ ${err instanceof Error ? err.message : String(err)}`);
				btn.disabled = false;
			}
		});
	};
	await draw();
}

/** Deploy → domain → setup, with retries for the setup step (the new worker needs a moment). */
async function provision(id: string, log: HTMLElement, done: () => Promise<void>): Promise<void> {
	log.hidden = false;
	const say = (m: string) => (log.textContent += `${m}\n`);
	try {
		say("Deploying the worker…");
		await api("me/projects/step", { id, step: "deploy" });
		say(`Attaching ${id}.premium-cms.com…`);
		await api("me/projects/step", { id, step: "domain" });
		say("Setting up the CMS…");
		for (let i = 1; i <= 12; i++) {
			const r = await api<{ retryable?: boolean; detail?: string; preloadedCents?: number }>("me/projects/step", { id, step: "setup" });
			if (!r.retryable) {
				if (r.preloadedCents) say(`✔ ${money(r.preloadedCents)} of credits loaded into the site`);
				break;
			}
			say(`  waiting for the site to come up (${r.detail ?? ""}) — ${i}/12`);
			await new Promise((res) => setTimeout(res, 5000));
		}
		say("✔ Your site is live. A sign-in link for its admin has been emailed to you.");
	} catch (err) {
		say(`✘ ${err instanceof Error ? err.message : String(err)} — you can retry from the list above.`);
	}
	await done();
}

/* ---- session-aware nav link ----------------------------------------------------- */

async function renderSessionLinks(): Promise<void> {
	const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/signin"], a[href="/signup"], [data-platform-session]')];
	if (!links.length) return;
	const me = await whoAmI();
	if (!me) return;
	links.forEach((a) => {
		a.setAttribute("href", ACCOUNT_PATH);
		if (!a.dataset.keepLabel) a.textContent = "Your account";
	});
}

export function initPlatform(): void {
	document.querySelectorAll<HTMLElement>("[data-platform-auth]").forEach((el) => void renderAuth(el));
	document.querySelectorAll<HTMLElement>("[data-platform-account]").forEach((el) => void renderAccount(el));
	document.querySelectorAll<HTMLElement>("[data-platform-pricing]").forEach((el) => void renderPricing(el));
	void renderSessionLinks();
}
