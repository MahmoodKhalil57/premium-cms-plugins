/**
 * Projects-collection mirror. The `projects` collection is created by a seed
 * elsewhere; this plugin only reads its rows and writes provisioning status
 * back. The authoritative registry is the kv state (state:project:<id>) — the
 * content row is a human-facing mirror, matched by its `project_id` field.
 *
 * Collection slug: "projects". Fields (all under ContentItem.data):
 *   label (string), theme (string), project_id (string), status (string),
 *   url (url).
 */

import type { PluginContext } from "@premium-cms/emdash/plugin";
import type { ProjectState } from "./provisioner.js";

export const COLLECTION = "projects";

/** Pull the custom-field bag off a content event record (event.content) or item. */
export function fieldsOf(row: unknown): Record<string, unknown> {
	if (row && typeof row === "object" && "data" in row) {
		const data = (row as { data?: unknown }).data;
		if (data && typeof data === "object") return data as Record<string, unknown>;
	}
	return {};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/**
 * Every Projects row not yet claimed (no `project_id`) that has a label.
 * The cron tick claims these — the `content:afterSave` hook cannot, because it
 * runs inside the content-save request and has no subrequest budget left.
 */
export async function listUnclaimed(
	ctx: PluginContext,
): Promise<Array<{ contentId: string; label: string; theme: string }>> {
	if (!ctx.content) return [];
	const out: Array<{ contentId: string; label: string; theme: string }> = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const res = await ctx.content.list(COLLECTION, { limit: 100, cursor });
		for (const item of res.items) {
			const f = fieldsOf(item);
			if (str(f.project_id)) continue;
			const label = str(f.label);
			if (!label) continue;
			out.push({ contentId: item.id, label, theme: str(f.theme) });
		}
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	return out;
}

/** Locate the Projects row whose `project_id` field matches, scanning pages. */
export async function findRowByProjectId(ctx: PluginContext, id: string): Promise<string | null> {
	if (!ctx.content) return null;
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const res = await ctx.content.list(COLLECTION, { limit: 100, cursor });
		for (const item of res.items) {
			if (str(fieldsOf(item).project_id) === id) return item.id;
		}
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	return null;
}

/**
 * Mirror a project's status (and, when live, its URL) into its content row.
 * Resolves the row id from state.content_id, falling back to a project_id
 * scan. No-op when write access or the row is unavailable.
 */
export async function mirrorState(ctx: PluginContext, state: ProjectState): Promise<void> {
	if (!ctx.content?.update) return;
	const rowId = state.content_id ?? (await findRowByProjectId(ctx, state.id));
	if (!rowId) return;

	const patch: Record<string, unknown> = {
		project_id: state.id,
		provision_status: state.status,
	};
	if (state.status === "live") patch.url = `https://${state.hostname}`;

	try {
		await ctx.content.update(COLLECTION, rowId, patch);
	} catch (err) {
		ctx.log.warn(`[premiumcms-projects] could not mirror status for ${state.id}`, err);
	}
}
