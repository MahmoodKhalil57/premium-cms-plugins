#!/usr/bin/env bash
# Typecheck every plugin's sandbox entry (strict). CI runs this before building.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/node_modules/typescript" ] || (cd "$ROOT" && bun install --silent)
status=0
for d in "$ROOT"/plugins/*/; do
	id="$(basename "$d")"; [ -f "$d/src/sandbox-entry.ts" ] || continue
	(cd "$d" && [ -d node_modules ] || bun install --silent)
	if (cd "$d" && "$ROOT/node_modules/.bin/tsc" -p tsconfig.json); then echo "typecheck ok: $id"; else echo "typecheck FAILED: $id"; status=1; fi
done
exit $status
