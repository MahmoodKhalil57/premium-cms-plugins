# Forms

Build forms, accept submissions from visitors, get notified, export data.

- **Create forms** in the admin (Plugins → Forms): fields are defined as a small JSON list, with validation, spam protection (honeypot or Cloudflare Turnstile), confirmation message or redirect, notification emails, daily digest, webhook, and retention.
- **Embed anywhere** on your site's frontend: `<div data-cms-form="contact"></div>` (rendered by the platform frontend template) — or a `<form data-ec-form>` you design yourself that posts to the public `submit` route.
- **Review submissions** (Plugins → Forms → Submissions): filter by form and status, mark read/archived, star, delete, and export CSV/JSON.

Sandboxed port of `@emdash-cms/plugin-forms` (MIT) for the PremiumCMS marketplace.
