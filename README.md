# PremiumCMS plugins

First-party marketplace plugins for [PremiumCMS](https://premium-cms.com): sandboxed EmDash plugins built to a single `backend.js`, published to the PremiumCMS marketplace and rolled out to every project automatically.

| Plugin | What it does |
| --- | --- |
| `premium-commerce` | Shop, bookings & deposits, restaurant (delivery / pickup / dine-in, QR tables, POS, kitchen display, printing), discounts, automations |
| `premium-forms` | Form builder, submissions, signatures / consent, Turnstile |
| `premium-site-kit` | Business schema, analytics + consent banner, Google reviews |
| `premium-platform` | The platform control plane (apex only): projects, domains, billing, backups, fleet sync |

## Contributing

1. Fork / branch, then `bun install`.
2. Create a plugin: `mkdir plugins/<id>` with `manifest.json`, `src/sandbox-entry.ts`, `package.json` (`"build": "bash ../../bin/build.sh <id>"`), `README.md`, `emdash-plugin.jsonc` (marketplace listing). Shared code lives in `shared/` — symlink it into your `src/` like the others do (`src/fields.ts -> ../../../shared/fields.ts`).
3. `bash bin/check.sh` (strict typecheck) and `bash bin/build.sh <id>` (bundle + manifest validation).
4. Bump `"version"` in `manifest.json` — the marketplace keys releases by version.
5. Open a pull request. CI builds and typechecks every plugin on the PR.

When the PR is merged to `main`, CI publishes **every** plugin in the repo to the marketplace, removes catalogue entries for plugins that were deleted, and asks the platform to update all projects (`fleet/sync plugins`). No keys are needed locally: the Cloudflare token and the platform deploy key live in the repo's `marketplace` environment.

## Rules of the sandbox

- Plugins run in a Worker-loader isolate with **50 subrequests** per invocation; every `ctx.kv` / `ctx.storage` / `ctx.content` / `ctx.email` / `ctx.http` call counts. Load settings with one `kv.list("settings:")`.
- Routes receive a plain request snapshot (`headers` is an object). Use `staffToken`-style body fields or read headers defensively.
- Never return secrets (PIN hashes, API keys) from routes; settings of type `secret` are masked in the admin only.
