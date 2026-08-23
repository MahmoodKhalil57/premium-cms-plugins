/**
 * Tiny schema validator (zod-shaped subset) — the sandbox bundle must stay
 * under the CMS's 256 KB decompressed limit, which rules out bundling zod.
 * Supports exactly what the forms schemas need: objects with defaults,
 * optional/nullable, strings (min/max/regex/email/url/datetime), numbers
 * (int/min/max), booleans, enums, arrays (min), records, unions with "".
 */
export interface Issue {
	path: string;
	message: string;
}
export class ValidationError extends Error {
	constructor(public readonly issues: Issue[]) {
		super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
		this.name = "ValidationError";
	}
}
export interface Schema<T> {
	parse(value: unknown, path?: string): T;
	optional(): Schema<T | undefined>;
	default(value: T): Schema<T>;
	nullable(): Schema<T | null>;
}
const fail = (path: string, message: string): never => {
	throw new ValidationError([{ path, message }]);
};
function make<T>(run: (value: unknown, path: string) => T): Schema<T> {
	const schema: Schema<T> = {
		parse: (value, path = "") => run(value, path),
		optional: () => make<T | undefined>((v, p) => (v === undefined ? undefined : run(v, p))),
		default: (d) => make<T>((v, p) => (v === undefined ? d : run(v, p))),
		nullable: () => make<T | null>((v, p) => (v === null ? null : run(v, p))),
	};
	return schema;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const v = {
	string: (o: { min?: number; max?: number; regex?: RegExp; message?: string; email?: boolean; url?: boolean; datetime?: boolean } = {}) =>
		make<string>((x, p) => {
			if (typeof x !== "string") return fail(p, "Expected a string");
			if (o.min !== undefined && x.length < o.min) return fail(p, o.min === 1 ? "Required" : `Must be at least ${o.min} characters`);
			if (o.max !== undefined && x.length > o.max) return fail(p, `Must be at most ${o.max} characters`);
			if (o.regex && !o.regex.test(x)) return fail(p, o.message ?? "Invalid format");
			if (o.email && !EMAIL_RE.test(x)) return fail(p, "Invalid email address");
			if (o.url) {
				try {
					const u = new URL(x);
					if (u.protocol !== "http:" && u.protocol !== "https:") return fail(p, "URL must use http or https");
				} catch {
					return fail(p, "Invalid URL");
				}
			}
			if (o.datetime && Number.isNaN(Date.parse(x))) return fail(p, "Invalid datetime");
			return x;
		}),
	number: (o: { int?: boolean; min?: number; max?: number } = {}) =>
		make<number>((x, p) => {
			const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
			if (typeof n !== "number" || Number.isNaN(n)) return fail(p, "Expected a number");
			if (o.int && !Number.isInteger(n)) return fail(p, "Expected an integer");
			if (o.min !== undefined && n < o.min) return fail(p, `Must be ≥ ${o.min}`);
			if (o.max !== undefined && n > o.max) return fail(p, `Must be ≤ ${o.max}`);
			return n;
		}),
	boolean: () => make<boolean>((x, p) => (typeof x === "boolean" ? x : fail(p, "Expected true or false"))),
	unknown: () => make<unknown>((x) => x),
	literal: <L extends string>(lit: L) => make<L>((x, p) => (x === lit ? lit : fail(p, `Expected "${lit}"`))),
	enumOf: <const E extends readonly string[]>(values: E) =>
		make<E[number]>((x, p) => (typeof x === "string" && values.includes(x) ? (x as E[number]) : fail(p, `Expected one of ${values.join(", ")}`))),
	array: <T>(item: Schema<T>, o: { min?: number; message?: string } = {}) =>
		make<T[]>((x, p) => {
			if (!Array.isArray(x)) return fail(p, "Expected a list");
			if (o.min !== undefined && x.length < o.min) return fail(p, o.message ?? `Must have at least ${o.min} item(s)`);
			return x.map((el, i) => item.parse(el, `${p}[${i}]`));
		}),
	record: <T>(value: Schema<T>) =>
		make<Record<string, T>>((x, p) => {
			if (!x || typeof x !== "object" || Array.isArray(x)) return fail(p, "Expected an object");
			const out: Record<string, T> = {};
			for (const [k, val] of Object.entries(x as Record<string, unknown>)) out[k] = value.parse(val, p ? `${p}.${k}` : k);
			return out;
		}),
	object: <S extends Record<string, Schema<unknown>>>(shape: S) => {
		const run = (x: unknown, p: string, partial: boolean) => {
			if (!x || typeof x !== "object" || Array.isArray(x)) return fail(p, "Expected an object");
			const src = x as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const [k, s] of Object.entries(shape)) {
				if (partial && src[k] === undefined) continue;
				const val = s.parse(src[k], p ? `${p}.${k}` : k);
				if (val !== undefined) out[k] = val;
			}
			return out as { [K in keyof S]: ReturnType<S[K]["parse"]> };
		};
		const base = make((x, p) => run(x, p, false));
		return Object.assign(base, { partial: () => make((x, p) => run(x, p, true)) });
	},
	/** Accept either schema (first match wins). */
	or: <A, B>(a: Schema<A>, b: Schema<B>) =>
		make<A | B>((x, p) => {
			try {
				return a.parse(x, p);
			} catch {
				return b.parse(x, p);
			}
		}),
};
