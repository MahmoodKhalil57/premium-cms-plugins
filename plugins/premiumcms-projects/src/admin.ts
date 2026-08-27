/**
 * Block Kit admin (/settings): the provider-credentials form, a status line,
 * and a table of provisioned projects each with a Destroy button. Mirrors the
 * cloudflare-email-byo settings page shape.
 */

import type { PluginContext, SandboxedRouteContext } from "@premium-cms/emdash/plugin";
import { destroyProject, listStates, type ProjectState } from "./provisioner.js";
import { readSettings, redact, saveSettings, validate, type Settings } from "./settings.js";

type Block = Record<string, unknown>;

interface Interaction {
	type: "page_load" | "form_submit" | "block_action";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

function statusLine(settings: Settings): string {
	const check = validate(settings);
	return check.ok
		? `Ready — provisioning under *.${settings.zone} with account ${settings.cfAccountId}.`
		: `Not ready — missing ${check.missing.join(", ")}.`;
}

async function buildPage(ctx: PluginContext, note?: string): Promise<{ blocks: Block[] }> {
	try {
		const settings = await readSettings(ctx);
		const check = validate(settings);
		const projects = await listStates(ctx).catch(() => [] as ProjectState[]);

		const blocks: Block[] = [
			{ type: "header", text: "Projects (provider)" },
			{
				type: "context",
				text: "Each project is a fully isolated CMS instance — its own Worker, D1, KV, R2 and domain. Add a row to the Projects collection to provision one; credentials live here.",
			},
			{ type: "divider" },
			{ type: "section", text: statusLine(settings) },
		];

		if (note) blocks.push({ type: "context", text: note });

		blocks.push(
			{ type: "divider" },
			{
				type: "form",
				block_id: "premiumcms-projects-settings",
				fields: [
					{
						type: "text_input",
						action_id: "cfAccountId",
						label: "Cloudflare account ID",
						placeholder: "32 hex characters, from the dashboard sidebar",
						initial_value: settings.cfAccountId,
					},
					{
						type: "secret_input",
						action_id: "cfApiToken",
						label: settings.cfApiToken
							? `Cloudflare API token (stored: ${redact(settings.cfApiToken)} — leave blank to keep, type "clear" to remove)`
							: "Cloudflare API token (Workers, D1, KV, R2, domains)",
					},
					{
						type: "text_input",
						action_id: "zone",
						label: "Platform zone",
						placeholder: "premium-cms.com",
						initial_value: settings.zone,
					},
					{
						type: "secret_input",
						action_id: "deployKey",
						label: settings.deployKey
							? `Marketplace deploy key (stored: ${redact(settings.deployKey)} — leave blank to keep, type "clear" to remove)`
							: "Marketplace deploy key (matches the deploy service's X-Deploy-Key)",
					},
					{
						type: "text_input",
						action_id: "marketplaceUrl",
						label: "Marketplace URL",
						placeholder: "https://marketplace.premium-cms.com",
						initial_value: settings.marketplaceUrl,
					},
					{
						type: "text_input",
						action_id: "ownerEmail",
						label: "Default owner email",
						placeholder: "owner@example.com",
						initial_value: settings.ownerEmail,
					},
				],
				submit: { label: "Save", action_id: "save_settings" },
			},
		);

		blocks.push({ type: "divider" }, { type: "section", text: `*Projects* (${projects.length})` });

		if (projects.length === 0) {
			blocks.push({
				type: "context",
				text: "No projects yet. Add a row to the Projects collection to provision one.",
			});
		} else {
			for (const p of projects) {
				const url = p.status === "live" ? `https://${p.hostname}` : p.hostname;
				const line = `*${p.label}*  \`${p.id}\`  ·  ${p.status}${p.error ? `  ·  ${p.error}` : ""}\n${url}`;
				blocks.push({
					type: "section",
					text: line,
					accessory: {
						type: "button",
						text: "Destroy",
						style: "danger",
						action_id: `destroy:${p.id}`,
						confirm: {
							title: "Destroy project?",
							text: `Permanently delete ${p.label} (${p.id}): its Worker, domain, D1, KV and R2 bucket. This cannot be undone.`,
							confirm: "Destroy",
							deny: "Cancel",
						},
					},
				});
			}
		}

		blocks.push(
			{ type: "divider" },
			{
				type: "context",
				text: check.ok
					? "Provisioning runs step-by-step on the cron tick; watch a project's status here."
					: "Add the missing credentials above, then create a Projects row.",
			},
		);

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build settings page", error);
		return { blocks: [{ type: "context", text: "Failed to load Projects settings." }] };
	}
}

/** The /settings admin route handler. */
export async function adminHandler(
	routeCtx: SandboxedRouteContext,
	ctx: PluginContext,
): Promise<{ blocks: Block[] }> {
	const i = (routeCtx.input ?? {}) as Interaction;

	try {
		if (i.type === "page_load" && i.page === "/settings") {
			return buildPage(ctx);
		}
		if (i.type === "form_submit" && i.action_id === "save_settings") {
			const note = await saveSettings(ctx, i.values ?? {});
			return buildPage(ctx, note);
		}
		if (
			i.type === "block_action" &&
			typeof i.action_id === "string" &&
			i.action_id.startsWith("destroy:")
		) {
			const id = i.action_id.slice("destroy:".length);
			const settings = await readSettings(ctx);
			const check = validate(settings);
			if (!check.ok) return buildPage(ctx, `Cannot destroy — missing ${check.missing.join(", ")}.`);
			const r = await destroyProject(ctx, settings, id);
			const note = `Destroyed ${id}: ${r.removed.join(", ")}${r.warnings.length ? ` (warnings: ${r.warnings.join("; ")})` : ""}`;
			return buildPage(ctx, note);
		}
		return buildPage(ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const base = await buildPage(ctx);
		return {
			blocks: [
				{
					type: "banner",
					variant: "error",
					title: "Could not complete that",
					description: message,
				},
				...base.blocks,
			],
		};
	}
}
