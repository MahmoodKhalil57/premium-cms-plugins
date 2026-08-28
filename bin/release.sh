#!/usr/bin/env bash
#
# Build step of the release runner's Cloudflare Workers Build (root directory
# .release; deploy command `npx wrangler deploy`).
#
# Every sandboxed plugin whose version is not on the marketplace yet is
# validated, built and listed (bin/publish-plugin.sh — idempotent, private
# packages skipped), then the instance tree is asked to apply its pending
# plugin updates. A release is therefore: bump the plugin's version, push main.
#
# Env (build variables on the Worker): CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
# (marketplace account), MASTER_PLATFORM_TOKEN (roll).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bun install

for d in plugins/*/; do
	[ -f "$d/emdash-plugin.jsonc" ] || continue
	id="$(basename "$d")"
	echo "::: $id"
	( cd "$d" && bunx emdash-plugin validate . && bunx tsc --noEmit )
	bin/publish-plugin.sh "$id"
done

# Same roll script the themes repo ships; fetch it so there is one copy.
curl -sSf https://raw.githubusercontent.com/MahmoodKhalil57/premium-cms-themes/main/bin/roll.sh -o /tmp/roll.sh
bash /tmp/roll.sh plugins
