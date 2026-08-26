# PremiumCMS plugins

Marketplace plugins for [EmDash](https://docs.emdashcms.com). Each plugin is a
self-contained package under `plugins/<slug>` that builds to a sandboxed bundle
the CMS loads at runtime.

```
plugins/<slug>/
  emdash-plugin.jsonc   the manifest: identity, trust contract, admin surface
  src/plugin.ts         the implementation: hooks + routes
  tests/plugin.test.ts  tests, run against the plugin object with a stub context
  package.json          scripts + pinned toolchain
  tsconfig.json         extends ../../tsconfig.base.json
```

## Start here

**`plugins/premium-starter`** is the worked reference. It is a real, working
plugin (it flags published content that has gone stale) chosen because it
exercises every extension point you are likely to need:

| Surface | Where it shows up |
| --- | --- |
| Content hooks | `content:afterSave` / `content:afterDelete` maintain an index |
| Lifecycle hooks | `plugin:install` seeds default settings |
| Storage | the `tracked` collection, with indexes declared in the manifest |
| Settings | `ctx.kv` under a `settings:` prefix |
| JSON routes | `stale`, `settings`, `settings/save` |
| Admin UI | a `/freshness` page and a dashboard widget, both Block Kit |

Read it before writing a new plugin, then copy the shape.

## Adding a plugin

```bash
bin/new-plugin.sh <slug> "What it does"
bun install
cd plugins/<slug>
npx vitest run && npx emdash-plugin build
```

`bin/new-plugin.sh` wraps the official `emdash-plugin init` so plugins start
from the upstream skeleton, then applies this repo's conventions (shared
tsconfig, `@premium-cms/plugin-*` package name, security contact, and the
portable export form described below).

## The manifest is a trust contract

`emdash-plugin.jsonc` declares what the plugin is allowed to do. Users consent
to it at install time, so keep it minimal — and bump the version when it changes.

- **`capabilities`** unlock APIs on `ctx`. `content:read` is what makes
  `ctx.content` exist; without it the property is `undefined`.
- **`allowedHosts`** is the outbound fetch allow-list. Empty means no network
  access at all, which is the easiest contract for a user to accept.
- **`storage`** declares the plugin's own tables. **A field must be declared as
  an index before it can appear in a `where` or `orderBy` clause** — this is the
  most common mistake when adapting an existing plugin.

Validate any time with `npx emdash-plugin validate plugins/<slug>`.

## Two things that will bite you

**`event.content` is `Record<string, unknown>`, not a `ContentItem`.** Every
field you read off it — `status`, `slug`, `title` — is `unknown`. `event.content.status ?? "draft"`
looks correct and does not compile, because `unknown ?? string` widens to `{}`.
Coerce explicitly; `premium-starter` has an `asString` helper for this.

**Annotate the export, don't use `satisfies`.** EmDash's in-repo plugins write
`export default { ... } satisfies SandboxedPlugin`. That works inside the EmDash
monorepo but fails here: the emitted `.d.mts` must name `PluginStorageConfig`,
whose only resolution path runs through the package manager's internal store,
and TypeScript rejects it (TS2883). Write this instead — it keeps identical
per-hook and per-route inference:

```ts
const plugin: SandboxedPlugin = { /* ... */ };
export default plugin;
```

## Publishing

Plugins are published to an atproto identity, not to npm. The manifest's
`publisher` is currently the placeholder `plugins.premium-cms.com`, which is
syntactically valid — so `validate`, `build` and `bundle` all work today — but
**does not resolve yet**. Before the first `emdash-plugin publish`, either stand
up that handle or replace it with a `did:plc:...` you control, then
`emdash-plugin login`.

## Toolchain

`bun install` at the repo root; per-plugin scripts run through `npx`. The
EmDash plugin build emits TypeScript declarations, so it is sensitive to
module resolution — if you see TS2883, check the export form above.
