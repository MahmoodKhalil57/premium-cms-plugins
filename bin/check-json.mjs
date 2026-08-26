#!/usr/bin/env node
/**
 * Validate JSON and JSONC files.
 *
 * wrangler.jsonc and emdash-plugin.jsonc both use comments and trailing
 * commas, so a plain JSON.parse rejects them. This strips both before
 * parsing — while respecting string literals, because a naive regex for `//`
 * mangles every "https://..." URL in the file (of which the seeds and
 * manifests have many).
 *
 * Usage: check-json.mjs <file>...
 */

import { readFile } from "node:fs/promises";

/** Remove // and /* *​/ comments that are not inside a string literal. */
function stripComments(text) {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += ch;
			// A backslash escapes the next character, including a quote.
			if (ch === "\\") {
				out += text[++i] ?? "";
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

/** Drop trailing commas before } or ], outside strings. */
function stripTrailingCommas(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += text[++i] ?? "";
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			// Look ahead past whitespace for a closing bracket.
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}

const files = process.argv.slice(2);
let failed = 0;

for (const file of files) {
	try {
		const raw = await readFile(file, "utf8");
		const cleaned = file.endsWith(".jsonc") ? stripTrailingCommas(stripComments(raw)) : raw;
		JSON.parse(cleaned);
	} catch (error) {
		console.error(`  invalid: ${file}\n    ${error.message}`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\n${failed} file(s) failed JSON validation.`);
	process.exit(1);
}
if (files.length > 0) console.log(`  ${files.length} JSON file(s) valid`);
