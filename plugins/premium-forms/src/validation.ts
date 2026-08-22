/**
 * Server-side submission validation — the shared implementation in
 * ./fields.ts (also used by the Commerce plugin for product options).
 */
export { evaluateCondition, validateFields as validateSubmission } from "./fields.js";
export type { ValidationError, ValidationResult } from "./fields.js";
