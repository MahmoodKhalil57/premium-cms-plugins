#!/usr/bin/env bash
# Build one plugin (or all) into dist/<id>/: backend.js (self-contained ESM for
# the sandbox isolate) + manifest.json + README.md + emdash-plugin.jsonc, then
# validate the manifest against EmDash's own schema.
#   bin/build.sh premium-commerce      bin/build.sh        (all)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/node_modules/emdash" ] || (cd "$ROOT" && bun install --silent)
build_one() {
	local id="$1" dir="$ROOT/plugins/$1" out="$ROOT/dist/$1"
	[ -f "$dir/manifest.json" ] || { echo "skip $id (no manifest.json)"; return 0; }
	mkdir -p "$out"
	(cd "$dir" && [ -d node_modules ] || bun install --silent)
	(cd "$dir" && bun build src/sandbox-entry.ts --target=browser --format=esm --minify --outfile="$out/backend.js" >/dev/null)
	cp "$dir/manifest.json" "$out/"; [ -f "$dir/README.md" ] && cp "$dir/README.md" "$out/"; [ -f "$dir/emdash-plugin.jsonc" ] && cp "$dir/emdash-plugin.jsonc" "$out/"; [ -f "$dir/icon.png" ] && cp "$dir/icon.png" "$out/"
	if grep -qE '^import |from ?"[a-z@]' "$out/backend.js"; then echo "$id: backend.js has unbundled imports"; exit 1; fi
	(cd "$ROOT" && bun -e '
import { pluginManifestSchema } from "emdash";
const m = JSON.parse(await Bun.file(process.argv[1]).text());
// The published schema predates plugin-grant permissions (<pluginId>:<grant>), which the
// PremiumCMS image accepts; map them to a built-in permission for this structural check only.
for (const route of m.routes ?? []) if (typeof route.permission === "string" && route.permission.startsWith(`${m.id}:`)) route.permission = "settings:manage";
const r = pluginManifestSchema.safeParse(m);
if (!r.success) { console.error("manifest INVALID:", JSON.stringify(r.error.issues, null, 1)); process.exit(1); }
console.log("built", r.data.id, r.data.version, "| routes:", r.data.routes.length, "| hooks:", r.data.hooks.length, "| backend", (await Bun.file(process.argv[2]).size / 1024).toFixed(0) + " KB");
' "$out/manifest.json" "$out/backend.js")
}
if [ $# -gt 0 ]; then for id in "$@"; do build_one "$id"; done
else for d in "$ROOT"/plugins/*/; do build_one "$(basename "$d")"; done; fi
