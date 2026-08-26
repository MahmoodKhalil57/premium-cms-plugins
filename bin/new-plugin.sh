#!/usr/bin/env bash
#
# Scaffold a new PremiumCMS plugin into plugins/<slug>.
#
#   bin/new-plugin.sh <slug> ["description"]
#
# Wraps the official `emdash-plugin init` so every plugin starts from the
# upstream skeleton, then applies this repo's conventions: the shared
# tsconfig, the PremiumCMS publisher + security contact, and a package name
# under the @premium-cms scope.
#
# Read plugins/premium-starter first — it is the worked example for hooks,
# storage, settings and the Block Kit admin surface.
set -euo pipefail

SLUG="${1:-}"
DESCRIPTION="${2:-A PremiumCMS plugin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$SLUG" ]; then
	echo "usage: bin/new-plugin.sh <slug> [\"description\"]" >&2
	exit 1
fi
if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]*$ ]]; then
	echo "error: slug must be lowercase letters, digits and hyphens (got '$SLUG')" >&2
	exit 1
fi
if [ -e "$ROOT/plugins/$SLUG" ]; then
	echo "error: plugins/$SLUG already exists" >&2
	exit 1
fi

npx --yes @emdash-cms/plugin-cli init "$SLUG" \
	--dir "$ROOT/plugins/$SLUG" \
	--yes \
	--license MIT \
	--author-name "PremiumCMS" \
	--description "$DESCRIPTION"

cd "$ROOT/plugins/$SLUG"

# Point at the shared tsconfig instead of the standalone one init writes.
cat > tsconfig.json <<'JSON'
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "./dist",
		"rootDir": "."
	},
	"include": ["src/**/*", "tests/**/*"],
	"exclude": ["node_modules", "dist"]
}
JSON

# Repo conventions: scoped package name, security contact, pinned toolchain.
python3 - "$SLUG" "$DESCRIPTION" <<'PY'
import json, pathlib, sys

slug, description = sys.argv[1], sys.argv[2]

pkg = pathlib.Path("package.json")
d = json.loads(pkg.read_text())
d["name"] = f"@premium-cms/plugin-{slug}"
d["description"] = description
d["scripts"] = {
    "build": "emdash-plugin build",
    "dev": "emdash-plugin dev",
    "bundle": "emdash-plugin bundle",
    "validate": "emdash-plugin validate .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
}
d["peerDependencies"] = {"emdash": ">=0.35.0"}
d["devDependencies"] = {
    "@emdash-cms/plugin-cli": "^0.8.1",
    "@emdash-cms/plugin-types": "^0.3.0",
    "emdash": "^0.35.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.5",
}
pkg.write_text(json.dumps(d, indent="\t") + "\n")

# Rewrite the upstream skeleton's `export default { ... } satisfies SandboxedPlugin`
# into an explicitly annotated const. `satisfies` is correct inside the EmDash
# monorepo but cannot emit portable .d.mts declarations from a standalone repo
# (TS2883 on PluginStorageConfig), so a freshly scaffolded plugin would fail to
# build. The annotation preserves per-hook/per-route inference exactly.
entry = pathlib.Path("src/plugin.ts")
src = entry.read_text()
src = src.replace(
    """ * Sandboxed plugin entry. The default export is a bare object; the
 * `satisfies SandboxedPlugin` annotation gives TypeScript per-hook /
 * per-route inference (`ctx` is `PluginContext` automatically; hook
 * `event` parameters are typed by hook name).""",
    """ * Sandboxed plugin entry. The annotation on `plugin` gives TypeScript
 * per-hook / per-route inference (`ctx` is `PluginContext` automatically;
 * hook `event` parameters are typed by hook name) and, unlike `satisfies`,
 * emits declarations that resolve outside the EmDash monorepo.""",
)
src = src.replace("export default {", "const plugin: SandboxedPlugin = {", 1)
src = src.replace("} satisfies SandboxedPlugin;", "};\n\nexport default plugin;", 1)
entry.write_text(src)

manifest = pathlib.Path("emdash-plugin.jsonc")
text = manifest.read_text()
# `init` resolves --publisher over the network, so a placeholder handle cannot be
# passed as a flag. Written here instead: `validate` and `build` only check syntax.
# It must resolve for real before `emdash-plugin publish`.
text = text.replace('"publisher": ""', '"publisher": "plugins.premium-cms.com"')
text = text.replace(
    '"security": { "email": "TODO@example.com" }',
    '"security": {\n\t\t"url": "https://github.com/MahmoodKhalil57/premium-cms-plugins/security/advisories/new",\n\t}',
)
manifest.write_text(text)
PY

echo
echo "Scaffolded plugins/$SLUG"
echo "Next:"
echo "  1. bun install                       # from the repo root"
echo "  2. edit plugins/$SLUG/emdash-plugin.jsonc   # capabilities, storage, admin"
echo "  3. edit plugins/$SLUG/src/plugin.ts         # hooks + routes"
echo "  4. cd plugins/$SLUG && npx vitest run && npx emdash-plugin build"
