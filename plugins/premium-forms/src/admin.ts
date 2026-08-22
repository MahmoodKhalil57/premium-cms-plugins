/**
 * Block Kit admin for premium-forms: Forms page (create / edit / manage),
 * Submissions page (filter, review, act), and a dashboard widget.
 * No plugin JavaScript runs in the browser — the host renders these blocks.
 */
import { v, ValidationError } from "./validate.js";
import { formsCreateHandler, formsDeleteHandler, formsDuplicateHandler, formsUpdateHandler } from "./handlers/forms.js";
import { submissionDeleteHandler, submissionUpdateHandler } from "./handlers/submissions.js";
import { formCreateSchema, formUpdateSchema } from "./schemas.js";
import type { PluginContext, RouteContext, StorageCollection } from "./shim.js";
import type { FormDefinition, FormField, FormPage, Submission } from "./types.js";
import { getFormFields } from "./types.js";

type Block = Record<string, unknown>;
interface Interaction {
	type: "page_load" | "form_submit" | "block_action";
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
	value?: unknown;
}
const ROUTE_BASE = "/_emdash/api/plugins/premium-forms";

const forms = (ctx: PluginContext) => ctx.storage.forms as StorageCollection<FormDefinition>;
const submissions = (ctx: PluginContext) => ctx.storage.submissions as StorageCollection<Submission>;

const EXAMPLE_FIELDS = JSON.stringify(
	[
		{ name: "name", label: "Your name", type: "text", required: true },
		{ name: "email", label: "Email", type: "email", required: true },
		{ name: "topic", label: "Topic", type: "select", options: ["Sales", "Support", "Other"] },
		{ name: "message", label: "Message", type: "textarea", required: true },
	],
	null,
	2,
);

/* ---- field JSON (admin-friendly) → FormPage[] ---- */

const simpleFieldSchema = v.object({
	name: v.string({ regex: /^[a-zA-Z][a-zA-Z0-9_-]*$/, message: "Field names: letters, numbers, _ and - (start with a letter)" }),
	label: v.string({ min: 1 }),
	type: v.string().default("text"),
	required: v.boolean().default(false),
	placeholder: v.string().optional(),
	helpText: v.string().optional(),
	options: v.array(v.or(v.string(), v.object({ label: v.string(), value: v.string() }))).optional(),
	defaultValue: v.string().optional(),
	width: v.enumOf(["full", "half"] as const).default("full"),
	validation: v.record(v.unknown()).optional(),
	condition: v.record(v.unknown()).optional(),
});

function parseFieldsJson(raw: unknown): FormPage[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw ?? ""));
	} catch {
		throw new Error("Fields must be valid JSON");
	}
	const pagesInput: unknown[][] = Array.isArray(parsed)
		? [parsed]
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { pages?: unknown[] }).pages)
			? ((parsed as { pages: Array<{ fields?: unknown[] }> }).pages.map((p) => p.fields ?? []) as unknown[][])
			: (() => {
					throw new Error('Fields must be a JSON array of fields, or { "pages": [{ "title", "fields": [...] }] }');
				})();
	const titles = Array.isArray(parsed) ? [] : ((parsed as { pages: Array<{ title?: string }> }).pages.map((p) => p.title));
	return pagesInput.map((fields, i) => ({
		title: titles[i],
		fields: fields.map((f): FormField => {
			const s = simpleFieldSchema.parse(f);
			return {
				id: s.name,
				type: s.type as FormField["type"],
				label: s.label,
				name: s.name,
				required: s.required,
				placeholder: s.placeholder,
				helpText: s.helpText,
				defaultValue: s.defaultValue,
				width: s.width,
				validation: s.validation as FormField["validation"],
				condition: s.condition as FormField["condition"],
				options: s.options?.map((o) => (typeof o === "string" ? { label: o, value: o } : o)),
			};
		}),
	}));
}

const emails = (raw: unknown) =>
	String(raw ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/* ---- blocks ---- */

function embedHelp(slug: string): Block {
	return {
		type: "code",
		language: "jsonc",
		code: `// On your site's frontend, anywhere (pages, page-builder sections):\n<div data-cms-form="${slug}"></div>\n\n// Endpoints:\n// GET  ${ROUTE_BASE}/definition?id=${slug}\n// POST ${ROUTE_BASE}/submit   { "formId": "${slug}", "data": { ... } }`,
	};
}

function formsTable(items: Array<{ id: string } & FormDefinition>): Block {
	return {
		type: "table",
		block_id: "forms",
		columns: [
			{ key: "name", label: "Form" },
			{ key: "slug", label: "Slug", format: "code" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "submissionCount", label: "Submissions", format: "number" },
			{ key: "lastSubmissionAt", label: "Last submission", format: "relative_time" },
		],
		rows: items.map((f) => ({
			name: f.name,
			slug: f.slug,
			status: f.status,
			submissionCount: f.submissionCount,
			lastSubmissionAt: f.lastSubmissionAt ?? "",
		})),
	};
}

function createForm(): Block {
	return {
		type: "form",
		block_id: "create",
		fields: [
			{ type: "text_input", action_id: "name", label: "Name", placeholder: "Contact" },
			{ type: "text_input", action_id: "slug", label: "Slug", placeholder: "contact" },
			{ type: "text_input", action_id: "fields", label: "Fields (JSON)", multiline: true, initial_value: EXAMPLE_FIELDS },
			{ type: "text_input", action_id: "notifyEmails", label: "Notify emails (comma-separated)", placeholder: "you@example.com" },
			{
				type: "select",
				action_id: "spamProtection",
				label: "Spam protection",
				initial_value: "honeypot",
				options: [
					{ label: "Honeypot (invisible field)", value: "honeypot" },
					{ label: "Cloudflare Turnstile (needs keys in Settings)", value: "turnstile" },
					{ label: "None", value: "none" },
				],
			},
			{ type: "text_input", action_id: "confirmationMessage", label: "Confirmation message", initial_value: "Thank you for your submission." },
			{ type: "text_input", action_id: "redirectUrl", label: "Redirect URL after submit (optional)" },
			{ type: "text_input", action_id: "webhookUrl", label: "Webhook URL (optional)" },
			{ type: "number_input", action_id: "retentionDays", label: "Keep submissions for (days, 0 = forever)", initial_value: 0, min: 0 },
		],
		submit: { label: "Create form", action_id: "create_form" },
	};
}

function formOptions(items: Array<{ id: string } & FormDefinition>) {
	return items.map((f) => ({ label: `${f.name} (${f.slug})`, value: f.id }));
}

function manageForm(items: Array<{ id: string } & FormDefinition>): Block[] {
	if (items.length === 0) return [];
	return [
		{
			type: "form",
			block_id: "manage",
			fields: [
				{ type: "select", action_id: "formId", label: "Form", options: formOptions(items) },
				{
					type: "select",
					action_id: "action",
					label: "Action",
					initial_value: "edit",
					options: [
						{ label: "Edit…", value: "edit" },
						{ label: "Pause (stop accepting submissions)", value: "pause" },
						{ label: "Resume", value: "resume" },
						{ label: "Duplicate", value: "duplicate" },
						{ label: "Delete form AND its submissions", value: "delete" },
					],
				},
			],
			submit: { label: "Apply", action_id: "manage_form" },
		},
	];
}

function editForm(id: string, f: FormDefinition): Block[] {
	return [
		{ type: "header", text: `Edit: ${f.name}` },
		{
			type: "form",
			block_id: "edit",
			fields: [
				{ type: "text_input", action_id: "formId", label: "Form id (do not change)", initial_value: id },
				{ type: "text_input", action_id: "name", label: "Name", initial_value: f.name },
				{ type: "text_input", action_id: "slug", label: "Slug", initial_value: f.slug },
				{
					type: "text_input",
					action_id: "fields",
					label: "Fields (JSON)",
					multiline: true,
					initial_value: JSON.stringify(
						f.pages.length === 1 && !f.pages[0]?.title
							? f.pages[0]?.fields.map(stripField)
							: { pages: f.pages.map((p) => ({ title: p.title, fields: p.fields.map(stripField) })) },
						null,
						2,
					),
				},
				{ type: "text_input", action_id: "notifyEmails", label: "Notify emails", initial_value: f.settings.notifyEmails.join(", ") },
				{
					type: "select",
					action_id: "spamProtection",
					label: "Spam protection",
					initial_value: f.settings.spamProtection,
					options: [
						{ label: "Honeypot", value: "honeypot" },
						{ label: "Turnstile", value: "turnstile" },
						{ label: "None", value: "none" },
					],
				},
				{ type: "text_input", action_id: "confirmationMessage", label: "Confirmation message", initial_value: f.settings.confirmationMessage },
				{ type: "text_input", action_id: "redirectUrl", label: "Redirect URL", initial_value: f.settings.redirectUrl ?? "" },
				{ type: "text_input", action_id: "webhookUrl", label: "Webhook URL", initial_value: f.settings.webhookUrl ?? "" },
				{ type: "toggle", action_id: "digestEnabled", label: "Daily digest instead of per-submission emails", initial_value: f.settings.digestEnabled },
				{ type: "number_input", action_id: "retentionDays", label: "Keep submissions for (days, 0 = forever)", initial_value: f.settings.retentionDays, min: 0 },
			],
			submit: { label: "Save form", action_id: "save_form" },
		},
	];
}

function stripField(f: FormField) {
	const { id: _id, width, ...rest } = f;
	return width === "half" ? { ...rest, width } : rest;
}

function settingsFromValues(v: Record<string, unknown>) {
	return {
		notifyEmails: emails(v.notifyEmails),
		spamProtection: (str(v.spamProtection) || "honeypot") as "none" | "honeypot" | "turnstile",
		confirmationMessage: str(v.confirmationMessage) || "Thank you for your submission.",
		redirectUrl: str(v.redirectUrl),
		webhookUrl: str(v.webhookUrl),
		retentionDays: Number(v.retentionDays ?? 0) || 0,
		digestEnabled: Boolean(v.digestEnabled),
	};
}

/* ---- pages ---- */

async function formsPage(ctx: PluginContext, extra: Block[] = [], toast?: { message: string; type: "success" | "error" | "info" }) {
	const list = await forms(ctx).query({ orderBy: { createdAt: "desc" }, limit: 100 });
	const items = list.items.map((i) => ({ id: i.id, ...i.data }));
	const total = await submissions(ctx).count();
	const fresh = await submissions(ctx).count({ status: "new" });
	const blocks: Block[] = [
		{ type: "header", text: "Forms" },
		{
			type: "stats",
			items: [
				{ label: "Forms", value: items.length },
				{ label: "Submissions", value: total },
				{ label: "Unread", value: fresh },
			],
		},
		...(items.length ? [formsTable(items)] : [{ type: "context", text: "No forms yet — create your first one below." }]),
		...extra,
		...manageForm(items),
		{ type: "divider" },
		{ type: "header", text: "New form" },
		{
			type: "context",
			text: 'Fields: a JSON list of { "name", "label", "type", "required", "options" }. Types: text, email, textarea, number, tel, url, date, select, radio, checkbox, checkbox-group, swatch, image-choice, design, file, hidden. Choices may carry "priceDelta", "image", "color", "stock"; fields "priceDelta" and "condition" { field, op: eq|neq|filled|empty|in|nin, value }. Multi-page: { "pages": [{ "title", "fields": [...] }] }.',
		},
		createForm(),
		...(items[0] ? [{ type: "divider" }, { type: "header", text: "Embed" }, embedHelp(items[0].slug)] : []),
	];
	return toast ? { blocks, toast } : { blocks };
}

async function submissionsPage(ctx: PluginContext, filter?: { formId?: string; status?: string }, toast?: { message: string; type: "success" | "error" | "info" }) {
	const list = await forms(ctx).query({ orderBy: { createdAt: "desc" }, limit: 100 });
	const items = list.items.map((i) => ({ id: i.id, ...i.data }));
	const blocks: Block[] = [{ type: "header", text: "Submissions" }];
	if (items.length === 0) {
		blocks.push({ type: "context", text: "No forms yet." });
		return { blocks };
	}
	const formId = filter?.formId && items.some((f) => f.id === filter.formId) ? filter.formId : items[0]!.id;
	const status = filter?.status && filter.status !== "all" ? filter.status : undefined;
	const form = items.find((f) => f.id === formId)!;
	blocks.push({
		type: "form",
		block_id: "filter",
		fields: [
			{ type: "select", action_id: "formId", label: "Form", options: formOptions(items), initial_value: formId },
			{
				type: "select",
				action_id: "status",
				label: "Status",
				initial_value: status ?? "all",
				options: [
					{ label: "All", value: "all" },
					{ label: "New", value: "new" },
					{ label: "Read", value: "read" },
					{ label: "Archived", value: "archived" },
				],
			},
		],
		submit: { label: "Show", action_id: "filter_submissions" },
	});
	const result = await submissions(ctx).query({
		where: { formId, ...(status ? { status } : {}) },
		orderBy: { createdAt: "desc" },
		limit: 50,
	});
	const fields = getFormFields(form).filter((f) => f.type !== "hidden" && f.type !== "file").slice(0, 4);
	blocks.push({
		type: "table",
		block_id: "submissions",
		columns: [
			{ key: "id", label: "ID", format: "code" },
			{ key: "createdAt", label: "Received", format: "relative_time" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "starred", label: "★" },
			...fields.map((f) => ({ key: `f_${f.name}`, label: f.label })),
		],
		rows: result.items.map(({ id, data }) => {
			const row: Record<string, unknown> = { id, createdAt: data.createdAt, status: data.status, starred: data.starred ? "★" : "" };
			for (const f of fields) {
				const v = data.data[f.name];
				row[`f_${f.name}`] = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v).slice(0, 80);
			}
			return row;
		}),
	});
	if (result.items.length === 0) blocks.push({ type: "context", text: "No submissions match." });
	blocks.push({
		type: "form",
		block_id: "act",
		fields: [
			{ type: "text_input", action_id: "submissionId", label: "Submission ID (from the table)" },
			{
				type: "select",
				action_id: "action",
				label: "Action",
				initial_value: "read",
				options: [
					{ label: "Mark read", value: "read" },
					{ label: "Mark new", value: "new" },
					{ label: "Archive", value: "archived" },
					{ label: "Star", value: "star" },
					{ label: "Unstar", value: "unstar" },
					{ label: "Delete", value: "delete" },
				],
			},
			{ type: "text_input", action_id: "formId", label: "Current form id (keep)", initial_value: formId },
		],
		submit: { label: "Apply", action_id: "act_submission" },
	});
	blocks.push({
		type: "context",
		text: `Export: open ${ROUTE_BASE}/submissions/export?formId=${form.slug}&format=csv (or format=json) while signed in.`,
	});
	return toast ? { blocks, toast } : { blocks };
}

async function widget(ctx: PluginContext) {
	const total = await submissions(ctx).count();
	const fresh = await submissions(ctx).count({ status: "new" });
	const recent = await submissions(ctx).query({ orderBy: { createdAt: "desc" }, limit: 5 });
	const formList = await forms(ctx).query({ limit: 100 });
	const names = new Map(formList.items.map((f) => [f.id, f.data.name]));
	return {
		blocks: [
			{ type: "stats", items: [{ label: "Submissions", value: total }, { label: "Unread", value: fresh }] },
			{
				type: "table",
				columns: [
					{ key: "form", label: "Form" },
					{ key: "createdAt", label: "Received", format: "relative_time" },
					{ key: "status", label: "Status", format: "badge" },
				],
				rows: recent.items.map(({ data }) => ({ form: names.get(data.formId) ?? data.formId, createdAt: data.createdAt, status: data.status })),
			},
		],
	};
}

/* ---- interaction router ---- */

export async function adminHandler(ctx: RouteContext<Interaction>) {
	const i = ctx.input ?? ({} as Interaction);
	const page = i.page ?? "";
	try {
		if (i.type === "page_load") {
			if (page.startsWith("widget:")) return widget(ctx);
			if (page.startsWith("/submissions")) return submissionsPage(ctx);
			if (page.startsWith("/builder")) {
				// The PremiumCMS admin renders its own drag-and-drop builder for
				// this page; a stock EmDash admin only ever sees this fallback.
				return {
					blocks: [
						{ type: "header", text: "Form builder" },
						{ type: "context", text: "The visual builder is part of the PremiumCMS admin. On this admin, manage forms from the Forms page (fields as JSON)." },
					],
				};
			}
			return formsPage(ctx);
		}
		const v = i.values ?? {};
		if (i.type === "form_submit" && i.action_id === "create_form") {
			const input = formCreateSchema.parse({
				name: str(v.name),
				slug: str(v.slug).toLowerCase(),
				pages: parseFieldsJson(v.fields),
				settings: settingsFromValues(v),
			});
			const created = await formsCreateHandler({ ...ctx, input } as never);
			return formsPage(ctx, [], { message: `Form "${created.name}" created`, type: "success" });
		}
		if (i.type === "form_submit" && i.action_id === "manage_form") {
			const id = str(v.formId);
			const action = str(v.action);
			const f = await forms(ctx).get(id);
			if (!f) return formsPage(ctx, [], { message: "Form not found", type: "error" });
			if (action === "edit") return formsPage(ctx, editForm(id, f));
			if (action === "pause" || action === "resume") {
				await formsUpdateHandler({ ...ctx, input: formUpdateSchema.parse({ id, status: action === "pause" ? "paused" : "active" }) } as never);
				return formsPage(ctx, [], { message: action === "pause" ? "Form paused" : "Form resumed", type: "success" });
			}
			if (action === "duplicate") {
				await formsDuplicateHandler({ ...ctx, input: { id } } as never);
				return formsPage(ctx, [], { message: "Form duplicated", type: "success" });
			}
			if (action === "delete") {
				await formsDeleteHandler({ ...ctx, input: { id, deleteSubmissions: true } } as never);
				return formsPage(ctx, [], { message: "Form and its submissions deleted", type: "success" });
			}
		}
		if (i.type === "form_submit" && i.action_id === "save_form") {
			const id = str(v.formId);
			const input = formUpdateSchema.parse({
				id,
				name: str(v.name) || undefined,
				slug: str(v.slug).toLowerCase() || undefined,
				pages: parseFieldsJson(v.fields),
				settings: settingsFromValues(v),
			});
			await formsUpdateHandler({ ...ctx, input } as never);
			return formsPage(ctx, [], { message: "Form saved", type: "success" });
		}
		if (i.type === "form_submit" && i.action_id === "filter_submissions") {
			return submissionsPage(ctx, { formId: str(v.formId), status: str(v.status) });
		}
		if (i.type === "form_submit" && i.action_id === "act_submission") {
			const id = str(v.submissionId).trim();
			const action = str(v.action);
			const filter = { formId: str(v.formId) };
			if (!id) return submissionsPage(ctx, filter, { message: "Enter a submission ID", type: "error" });
			if (action === "delete") await submissionDeleteHandler({ ...ctx, input: { id } } as never);
			else if (action === "star" || action === "unstar") await submissionUpdateHandler({ ...ctx, input: { id, starred: action === "star" } } as never);
			else await submissionUpdateHandler({ ...ctx, input: { id, status: action } } as never);
			return submissionsPage(ctx, filter, { message: "Done", type: "success" });
		}
		return page.startsWith("/submissions") ? submissionsPage(ctx) : formsPage(ctx);
	} catch (err) {
		const message = err instanceof ValidationError ? err.message : err instanceof Error ? err.message : String(err);
		const base = page.startsWith("/submissions") ? await submissionsPage(ctx) : await formsPage(ctx);
		return { blocks: [{ type: "banner", variant: "error", title: "Could not complete that", description: message }, ...base.blocks], toast: { message, type: "error" } };
	}
}
