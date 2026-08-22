# Commerce

Sell from your CMS. Products are a normal **Products** collection (title, price, compare-at price, SKU, stock, image, summary, description, requires shipping) — edit them like any content, design product pages in the page builder.

- **Checkout** runs on Stripe Checkout: cards and wallets, Stripe Tax, shipping rates, promotion codes, address and phone collection. Prices are always taken from the CMS, never from the browser.
- **Pay-later** orders (bank transfer, cash on delivery) can be enabled — you mark them paid in Orders.
- **Inventory**: stock is set per product; the plugin tracks reserved (open checkouts) and sold counts, and exposes live availability to the storefront.
- **Orders** (Plugins → Commerce): stats, filter by status, fulfil with tracking, cancel (restocks), refund via Stripe, CSV/JSON export.
- **Emails**: confirmation to the customer and a notification to the store.

Storefront: the PremiumCMS frontend template ships `/products`, `/products/<slug>`, `/cart` and `/checkout/success`, plus `data-add-to-cart="<slug>"` / `[data-cart-count]` markers for page-builder sections.

Stripe webhook (optional but recommended): point `checkout.session.*` events at `https://<your-site>/_emdash/api/plugins/premium-commerce/webhook`. The plugin never trusts the payload — it re-reads the session from Stripe before marking an order paid, so no signing secret is needed.
