/**
 * Route input validation (ported from @emdash-cms/plugin-forms' zod
 * schemas onto the tiny validator in ./validate.ts).
 */
import { v } from "./validate.js";

const httpUrl = v.string({ url: true });
const urlOrEmpty = v.or(httpUrl, v.literal("")).optional();

const fieldOptionSchema = v.object({
	label: v.string({ min: 1 }),
	value: v.string({ min: 1 }),
	priceDelta: v.number().optional(),
	image: v.string().optional(),
	color: v.string().optional(),
	sku: v.string().optional(),
	stock: v.number({ int: true, min: 0 }).nullable().optional(),
	description: v.string().optional(),
});
const fieldValidationSchema = v
	.object({
		minLength: v.number({ int: true, min: 0 }).optional(),
		maxLength: v.number({ int: true, min: 1 }).optional(),
		min: v.number().optional(),
		max: v.number().optional(),
		pattern: v.string().optional(),
		patternMessage: v.string().optional(),
		accept: v.string().optional(),
		maxFileSize: v.number({ int: true, min: 1 }).optional(),
	})
	.optional();
const fieldConditionSchema = v
	.object({ field: v.string({ min: 1 }), op: v.enumOf(["eq", "neq", "filled", "empty", "in", "nin"] as const), value: v.string().optional() })
	.optional();
export { FIELD_TYPES } from "./fields.js";
import { FIELD_TYPES } from "./fields.js";
export const fieldTypeSchema = v.enumOf(FIELD_TYPES);
const formFieldSchema = v.object({
	id: v.string({ min: 1 }),
	type: fieldTypeSchema,
	label: v.string({ min: 1 }),
	name: v.string({ min: 1, regex: /^[a-zA-Z][a-zA-Z0-9_-]*$/, message: "Invalid field name" }),
	placeholder: v.string().optional(),
	helpText: v.string().optional(),
	required: v.boolean(),
	validation: fieldValidationSchema,
	options: v.array(fieldOptionSchema).optional(),
	defaultValue: v.string().optional(),
	width: v.enumOf(["full", "half"] as const).default("full"),
	condition: fieldConditionSchema,
	priceDelta: v.number().optional(),
	// Design-field configuration is validated when used (see fields.ts validateDesign).
	design: v.record(v.unknown()).optional(),
});
const formPageSchema = v.object({
	title: v.string().optional(),
	fields: v.array(formFieldSchema, { min: 1, message: "Each page must have at least one field" }),
});
const autoresponderSchema = v.object({ subject: v.string({ min: 1 }), body: v.string({ min: 1 }) }).optional();
const formSettingsSchema = v.object({
	confirmationMessage: v.string({ min: 1 }).default("Thank you for your submission."),
	redirectUrl: urlOrEmpty,
	notifyEmails: v.array(v.string({ email: true })).default([]),
	digestEnabled: v.boolean().default(false),
	digestHour: v.number({ int: true, min: 0, max: 23 }).default(9),
	autoresponder: autoresponderSchema,
	webhookUrl: urlOrEmpty,
	retentionDays: v.number({ int: true, min: 0 }).default(0),
	spamProtection: v.enumOf(["none", "honeypot", "turnstile"] as const).default("honeypot"),
	submitLabel: v.string({ min: 1 }).default("Submit"),
	nextLabel: v.string().optional(),
	prevLabel: v.string().optional(),
});
const slug = v.string({ min: 1, max: 100, regex: /^[a-z][a-z0-9-]*$/, message: "Slug must be lowercase alphanumeric with hyphens" });

export const formCreateSchema = v.object({
	name: v.string({ min: 1, max: 200 }),
	slug,
	pages: v.array(formPageSchema, { min: 1 }),
	settings: formSettingsSchema,
});
export const formUpdateSchema = v.object({
	id: v.string({ min: 1 }),
	name: v.string({ min: 1, max: 200 }).optional(),
	slug: slug.optional(),
	pages: v.array(formPageSchema, { min: 1 }).optional(),
	settings: formSettingsSchema.partial().optional(),
	status: v.enumOf(["active", "paused"] as const).optional(),
});
export const formDeleteSchema = v.object({ id: v.string({ min: 1 }), deleteSubmissions: v.boolean().default(true) });
export const formDuplicateSchema = v.object({ id: v.string({ min: 1 }), name: v.string({ min: 1, max: 200 }).optional(), slug: slug.optional() });
export const definitionSchema = v.object({ id: v.string({ min: 1 }) });
export const submitSchema = v.object({
	formId: v.string({ min: 1 }),
	data: v.record(v.unknown()),
	files: v.record(v.object({ filename: v.string(), contentType: v.string(), bytes: v.unknown() })).optional(),
});
export const submissionsListSchema = v.object({
	formId: v.string({ min: 1 }),
	status: v.enumOf(["new", "read", "archived"] as const).optional(),
	starred: v.boolean().optional(),
	cursor: v.string().optional(),
	limit: v.number({ int: true, min: 1, max: 100 }).default(50),
});
export const submissionGetSchema = v.object({ id: v.string({ min: 1 }) });
export const submissionUpdateSchema = v.object({
	id: v.string({ min: 1 }),
	status: v.enumOf(["new", "read", "archived"] as const).optional(),
	starred: v.boolean().optional(),
	notes: v.string().optional(),
});
export const submissionDeleteSchema = v.object({ id: v.string({ min: 1 }) });
export const exportSchema = v.object({
	formId: v.string({ min: 1 }),
	format: v.enumOf(["csv", "json"] as const).default("csv"),
	status: v.enumOf(["new", "read", "archived"] as const).optional(),
	from: v.string({ datetime: true }).optional(),
	to: v.string({ datetime: true }).optional(),
});

type Out<S> = S extends { parse(value: unknown, path?: string): infer T } ? T : never;
export type FormCreateInput = Out<typeof formCreateSchema>;
export type FormUpdateInput = Out<typeof formUpdateSchema>;
export type FormDeleteInput = Out<typeof formDeleteSchema>;
export type FormDuplicateInput = Out<typeof formDuplicateSchema>;
export type DefinitionInput = Out<typeof definitionSchema>;
export type SubmitInput = Out<typeof submitSchema>;
export type SubmissionsListInput = Out<typeof submissionsListSchema>;
export type SubmissionGetInput = Out<typeof submissionGetSchema>;
export type SubmissionUpdateInput = Out<typeof submissionUpdateSchema>;
export type SubmissionDeleteInput = Out<typeof submissionDeleteSchema>;
export type ExportInput = Out<typeof exportSchema>;
