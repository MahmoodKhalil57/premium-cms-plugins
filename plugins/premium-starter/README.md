# premium-starter

**The PremiumCMS reference plugin.** Read this one before writing another.

It flags published content that has not been touched for a configurable number
of days, so editors know what needs a review pass. That job is deliberately
small; the point is that it exercises every extension point a real plugin uses.

## What to look at

| Read this for                         | In `src/plugin.ts`                                            |
| ------------------------------------- | ------------------------------------------------------------- |
| Keeping an index in sync with content | `content:afterSave` / `content:afterDelete` hooks             |
| Seeding defaults on install           | `plugin:install`                                              |
| Querying your own storage             | `findStale` — note `where` only works on declared indexes     |
| Reading + writing settings            | `readSettings` / `saveSettings`, over `ctx.kv`                |
| Rendering an admin page               | `buildFreshnessPage` — Block Kit table + form                 |
| Rendering a dashboard widget          | `buildStaleWidget`                                            |
| Routing admin interactions            | the `admin` route's dispatch on `type` / `page` / `action_id` |
| Testing without a CMS                 | `tests/plugin.test.ts` and its `makeTestContext` stub         |

`emdash-plugin.jsonc` is worth reading alongside — the `capabilities`,
`allowedHosts` and `storage` blocks are annotated with why each entry is there.

## Settings

| Key              | Default | Meaning                                                |
| ---------------- | ------- | ------------------------------------------------------ |
| `staleAfterDays` | `30`    | Days of inactivity before published content is stale   |
| `collections`    | `all`   | `all`, or a comma-separated list such as `posts,pages` |
| `enabled`        | `true`  | When off, saves are not recorded                       |

Editable from **Content Freshness** in the admin, or over the `settings/save` route.

## Routes

| Route                  | Returns                                                  |
| ---------------------- | -------------------------------------------------------- |
| `stale?limit=&cursor=` | Stale items, oldest first, each with `staleForDays`      |
| `settings`             | Current settings, with defaults filled in                |
| `settings/save`        | Persists settings; ignores absent or invalid values      |
| `admin`                | Block Kit blocks — reserved name, called by the admin UI |

## Working on it

```bash
bun install              # from the repo root
npx vitest run           # 14 tests, no CMS required
npx tsc --noEmit
npx emdash-plugin build  # -> dist/{index.mjs,plugin.mjs,manifest.json}
npx emdash-plugin dev    # rebuild on change
```

Hooks never throw. A tracking failure is logged and swallowed, because an
unhandled error in `content:afterSave` would surface to the editor as a failed
save. Keep that property in anything you copy from here.
