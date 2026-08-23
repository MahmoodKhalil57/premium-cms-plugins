# Platform (provider)

The PremiumCMS control plane as a sandboxed plugin. Installed only on provider instances (hidden from the public catalogue); it provisions fully isolated sibling CMS instances onto your Cloudflare account — own Worker, D1, KV, R2 and domain — then runs headless setup, manages custom site/email domains (records-only, nothing transferred) and GitHub-hosted frontends.

Heavy lifting the sandbox can't do (uploading the golden bundle's hundreds of modules, purging buckets) runs in the PremiumCMS deploy service, authenticated with the `DEPLOY_KEY` setting. Credentials live in this plugin's Settings and never leave the server.

## Account credits — paying for provisioning

Users of the platform (apex) hold **account credits** bought with the payment provider configured in Plugins → Platform → Settings (`PAYMENT_PROVIDER` + Stripe / Polar keys, same webhook endpoint as project top-ups: the checkout carries `metadata.account`). Three settings drive it:

- `PROVISION_FEE_CENTS` — one-off charge when a user creates a project (0 = free);
- `PROJECT_PRELOAD_CENTS` — the credits every new project starts with, moved from the owner's account into the project's own ledger at setup (0 = none);
- `ACCOUNT_PACKS_CENTS` — the packs offered on the Platform page (default 1000, 2500, 5000, 10000).

Routes: `account/credits` (`status` · `checkout {amountCents, origin}` · `confirm {sessionId}`, grant `projects:read`, acts on the signed-in user), `projects/create` (charges the caller's account: fee + starting credits, idempotent per project name; refused when the balance is short), `projects/setup` (moves the reserved starting credits into the live project, once), `projects/list` (the caller's own projects). The provider — anyone with the `billing:manage` grant (the `admin` role holds `*`) — gets `projects/list-all`, `projects/create-free` (no charge, optional owner email) and `billing/overview` (`status`: every account with its balance · `grant {email, cents, note}` · `ledger {userId}`). Ledger storage: `credits` (append-only, `ref` unique: `stripe:<session>`, `polar:<checkout>`, `provision:<project>`, `preload:<project>`, `manual:<id>`), `accounts` (Stripe customer per user). Customers need a role with `premium-platform:projects:read` + `projects:manage` (apex has a `customer` role for that).
