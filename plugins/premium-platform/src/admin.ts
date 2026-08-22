/**
 * Block Kit admin (any EmDash admin). The PremiumCMS admin renders its own
 * React Projects screen on top of the same routes.
 */

import { loadEnv } from "./env.js";
import { attachDomain, createProject, deployWorker, destroyProject, setupCms } from "./provisioner.js";
import { getDomains, listProjects } from "./registry.js";
import type { PluginContext, RouteContext } from "./shim.js";

type Block = Record<string, unknown>;
type Toast = { message: string; type: "success" | "error" | "info" };
interface Interaction {
	type: "page_load" | "form_submit" | "block_action";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function page(ctx: PluginContext, toast?: Toast): Promise<{ blocks: Block[]; toast?: Toast }> {
	const env = await loadEnv(ctx);
	const items = await listProjects(ctx);
	const configured = Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.PLATFORM_ZONE);
	const blocks: Block[] = [
		{ type: "header", text: "Platform" },
		{ type: "context", text: "Each project is a fully isolated instance: own Worker, database, storage and domain. Credentials live in this plugin's Settings." },
	];
	if (!configured) blocks.push({ type: "banner", variant: "warning", title: "Provider credentials missing", description: "Set CF_ACCOUNT_ID, CF_API_TOKEN, PLATFORM_ZONE and DEPLOY_KEY in Plugins → Platform → Settings." });
	blocks.push({
		type: "stats",
		items: [
			{ label: "Projects", value: items.length },
			{ label: "Live", value: items.filter((p) => p.status === "live").length },
			{ label: "Errors", value: items.filter((p) => p.status === "error").length },
		],
	});
	blocks.push({
		type: "form",
		block_id: "create",
		fields: [
			{ type: "text_input", action_id: "id", label: "Project name", placeholder: "barbershop" },
			{ type: "text_input", action_id: "adminEmail", label: "Admin email" },
			{ type: "text_input", action_id: "siteTitle", label: "Site title" },
			{ type: "text_input", action_id: "tagline", label: "Tagline (optional)" },
		],
		submit: { label: "Create project (resources only)", action_id: "create" },
	});
	if (items.length > 0) {
		blocks.push({
			type: "form",
			block_id: "step",
			fields: [
				{ type: "select", action_id: "id", label: "Project", options: items.map((p) => ({ label: `${p.id} (${p.status})`, value: p.id })) },
				{
					type: "select",
					action_id: "action",
					label: "Step",
					initial_value: "deploy",
					options: [
						{ label: "Deploy worker (latest bundle)", value: "deploy" },
						{ label: "Attach assigned domain", value: "domain" },
						{ label: "Run CMS setup", value: "setup" },
						{ label: "Destroy project (irreversible)", value: "destroy" },
					],
				},
				{ type: "text_input", action_id: "confirm", label: "Type the project name to confirm destroy" },
			],
			submit: { label: "Run step", action_id: "step" },
		});
		blocks.push({
			type: "table",
			block_id: "projects",
			columns: [
				{ key: "id", label: "Project", format: "code" },
				{ key: "hostname", label: "Site" },
				{ key: "admin_email", label: "Admin" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "bundle", label: "Bundle", format: "code" },
				{ key: "error", label: "Error" },
			],
			rows: items.map((p) => ({ id: p.id, hostname: p.hostname, admin_email: p.admin_email, status: p.status, bundle: p.bundle_version ?? "", error: p.error ?? "" })),
		});
	}
	return toast ? { blocks, toast } : { blocks };
}

export async function adminHandler(ctx: RouteContext<Interaction>) {
	const i = ctx.input ?? ({} as Interaction);
	try {
		if (i.type === "page_load") return page(ctx);
		const v = i.values ?? {};
		const env = await loadEnv(ctx);
		if (i.type === "form_submit" && i.action_id === "create") {
			const p = await createProject(ctx, env, { id: str(v.id), adminEmail: str(v.adminEmail), siteTitle: str(v.siteTitle), tagline: str(v.tagline) || undefined });
			return page(ctx, { message: `Project ${p.id} created — now run Deploy, Attach domain, Setup.`, type: "success" });
		}
		if (i.type === "form_submit" && i.action_id === "step") {
			const id = str(v.id);
			const action = str(v.action);
			if (action === "deploy") await deployWorker(ctx, env, id);
			else if (action === "domain") await attachDomain(ctx, env, id);
			else if (action === "setup") {
				const r = await setupCms(ctx, id);
				if (r.retryable) return page(ctx, { message: `Not ready yet: ${r.detail ?? ""} — run Setup again in a moment.`, type: "info" });
			} else if (action === "destroy") {
				if (str(v.confirm) !== id) throw new Error("Type the project name to confirm destroy.");
				const r = await destroyProject(ctx, env, id);
				return page(ctx, { message: `Deleted: ${r.removed.join(", ")}${r.warnings.length ? ` (warnings: ${r.warnings.join("; ")})` : ""}`, type: "success" });
			}
			return page(ctx, { message: `${action} done for ${id}`, type: "success" });
		}
		return page(ctx);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const base = await page(ctx);
		return { blocks: [{ type: "banner", variant: "error", title: "Could not complete that", description: message }, ...base.blocks], toast: { message, type: "error" } };
	}
}

export { getDomains };
