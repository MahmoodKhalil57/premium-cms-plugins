# cloudflare-email-byo

**Email from the site owner's own Cloudflare account.**

EmDash's built-in `cloudflareEmail` provider sends through the Worker's
`send_email` binding — which belongs to whichever Cloudflare account deployed
the Worker. On a fleet that means every project's mail leaves from the
platform's account, on the platform's sending domain and reputation, against
the platform's quota.

This provider calls the Cloudflare Email Sending **REST API** with an API token
the owner enters in the admin, so mail leaves from _their_ account and _their_
verified domain. The platform never holds the credential.

## Setup (for the site owner)

1. In your own Cloudflare dashboard, onboard a domain for **Email Sending**.
2. Create an **API token** with email sending permission.
3. Open the plugin's **Email (own Cloudflare)** settings page and fill in the
   account ID, token, and sender address.
4. Click **Send test email**.
5. Under **Settings → Email**, select `cloudflare-email-byo` as the provider.

Step 5 matters: EmDash auto-selects a provider only when exactly one is active.
With both this and the built-in provider installed, the choice must be explicit.

## Settings

| Field       | Notes                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Account ID  | 32 hex characters; validated before any request is made                  |
| API token   | Stored in plugin KV, never returned by any route or rendered into a page |
| Send from   | Must be on a domain onboarded for Email Sending in _your_ account        |
| Sender name | Optional                                                                 |
| Reply-To    | Optional                                                                 |

Leaving the token field blank on save **keeps** the stored token — Block Kit
submits an empty string for an untouched secret field, so writing it blindly
would wipe a working credential on every unrelated edit. Type `clear` to remove it.

## Trust contract

```jsonc
"capabilities": ["hooks.email-transport:register", "network:request"],
"allowedHosts": ["api.cloudflare.com"]
```

`hooks.email-transport:register` is what permits the exclusive `email:deliver`
hook — **without it the hook is silently skipped at registration** and the
plugin appears to do nothing at all.

`network:request` is the host-restricted form (not `:unrestricted`), pinned to
`api.cloudflare.com` via `allowedHosts`. The owner's API token is the most
sensitive thing here; restricting egress to the single host that token is valid
for means a bug or a bad setting cannot post it anywhere else.

## The REST API is not the Workers binding

Field names differ, and getting them wrong produces a 400 that reads like a
domain-verification problem:

| Workers binding         | REST API                                             |
| ----------------------- | ---------------------------------------------------- |
| `from: { email, name }` | `from: { address, name }`                            |
| `replyTo`               | `reply_to`                                           |
| returns `messageId`     | returns `delivered` / `permanent_bounces` / `queued` |

A permanent bounce comes back on **HTTP 200** with the recipient listed in
`permanent_bounces`, so a naive status check reports success on a message that
was never delivered. This plugin treats that as a failure.

## Working on it

```bash
bun install              # from the repo root
npx vitest run           # 19 tests, no CMS and no network
npx tsc --noEmit
npx emdash-plugin build
```

The tests assert the REST contract itself — endpoint, auth header, `address`
vs `email`, `reply_to` casing — plus that the token and message bodies never
reach the logs. Message text carries magic-link and invite tokens, so it must
never be logged.
