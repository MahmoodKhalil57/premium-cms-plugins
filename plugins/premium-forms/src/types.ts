import type { FormField } from "./fields.js";
/**
 * Core types for the forms plugin.
 *
 * These define the data model stored in plugin storage.
 */

// ─── Form Definitions ────────────────────────────────────────────

export interface FormDefinition {
	name: string;
	slug: string;
	pages: FormPage[];
	settings: FormSettings;
	status: "active" | "paused";
	submissionCount: number;
	lastSubmissionAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface FormPage {
	/** Page title shown in multi-page progress indicator. Optional for single-page forms. */
	title?: string;
	fields: FormField[];
}

export interface FormSettings {
	/** Message shown after successful submission */
	confirmationMessage: string;
	/** Redirect URL after submission (overrides confirmation message) */
	redirectUrl?: string;
	/** Email addresses for submission notifications */
	notifyEmails: string[];
	/** Enable daily digest instead of per-submission notifications */
	digestEnabled: boolean;
	/** Hour (0-23) to send digest, in site timezone */
	digestHour: number;
	/** Autoresponder email sent to the submitter */
	autoresponder?: {
		subject: string;
		body: string;
	};
	/** Webhook URL for submission notifications */
	webhookUrl?: string;
	/** Days to retain submissions (0 = forever) */
	retentionDays: number;
	/** Spam protection strategy */
	spamProtection: "none" | "honeypot" | "turnstile";
	/** Submit button text */
	submitLabel: string;
	/** Label for Next button on multi-page forms */
	nextLabel?: string;
	/** Label for Previous button on multi-page forms */
	prevLabel?: string;
}

// ─── Form Fields ─────────────────────────────────────────────────
// The field model is shared with the Commerce plugin (product options) and
// the storefront renderer: see ./fields.ts.

export type { FormField, FieldType, FieldValidation, FieldOption, FieldCondition, DesignConfig, DesignDoc } from "./fields.js";

// ─── Submissions ─────────────────────────────────────────────────

export interface Submission {
	formId: string;
	data: Record<string, unknown>;
	files?: SubmissionFile[];
	/** Sum of the chosen options' price deltas (major units), when the form prices anything. */
	total?: number;
	status: "new" | "read" | "archived";
	starred: boolean;
	notes?: string;
	createdAt: string;
	meta: SubmissionMeta;
}

export interface SubmissionFile {
	fieldName: string;
	filename: string;
	contentType: string;
	size: number;
	/** Reference to media library item */
	mediaId: string;
}

export interface SubmissionMeta {
	ip: string | null;
	userAgent: string | null;
	referer: string | null;
	country: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Get all fields across all pages */
export function getFormFields(form: FormDefinition): FormField[] {
	return form.pages.flatMap((p) => p.fields);
}

/** Check if a form has multiple pages */
export function isMultiPage(form: FormDefinition): boolean {
	return form.pages.length > 1;
}

/** Check if a form has any file fields */
export function hasFileFields(form: FormDefinition): boolean {
	return getFormFields(form).some((f) => f.type === "file");
}
