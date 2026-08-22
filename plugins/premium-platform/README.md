# Platform (provider)

The PremiumCMS control plane as a sandboxed plugin. Installed only on provider instances (hidden from the public catalogue); it provisions fully isolated sibling CMS instances onto your Cloudflare account — own Worker, D1, KV, R2 and domain — then runs headless setup, manages custom site/email domains (records-only, nothing transferred) and GitHub-hosted frontends.

Heavy lifting the sandbox can't do (uploading the golden bundle's hundreds of modules, purging buckets) runs in the PremiumCMS deploy service, authenticated with the `DEPLOY_KEY` setting. Credentials live in this plugin's Settings and never leave the server.
