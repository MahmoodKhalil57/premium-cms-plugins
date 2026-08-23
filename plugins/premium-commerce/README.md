# Commerce

Sell the products in your CMS. The `products` collection (seeded by the storefront template) is the catalogue; the plugin owns orders, carts, customers, discounts, inventory counters and the money.

- **Checkout** — Stripe Checkout or Polar (cards, wallets, automatic tax, shipping rates, promo codes), saved addresses and vaulted cards for signed-in shoppers, pay-later orders, coupons and automatic promotions, product options with price deltas and per-choice stock, print-on-demand designs.
- **Orders** — numbers, timelines, fulfilment with tracking, refunds, CSV / JSON export, deposit orders with balance collection (saved card, pay link, waive).
- **Inventory** — stock per product and per tracked choice (reserved by open checkouts, committed on payment, restocked on cancel).
- **Discounts** — percentage / fixed / cart-wide, codes or automatic, limits and dates.

## Interop — how other plugins take part in an order

Commerce is deliberately generic. Bookings (deposits for appointments), Restaurant (delivery fees, tips, a POS) and any plugin you write plug in through three small contracts; declare the `plugins:call` capability to use them.

### 1. Provider lines — sell something Commerce does not know

A checkout item whose `productId` is `<pluginId>:<ref>` is priced by that plugin. Commerce calls `<pluginId>/commerce/line` with `{ ref, quantity, email, userId }` and expects:

```json
{ "title": "Check-up — Mon 2 Sep 10:00 with Dr Khan (deposit)", "unitAmount": 2500, "fullAmount": 8500, "depositAmount": 2500, "display": [{ "name": "when", "label": "When", "value": "…" }] }
```

Minor units. A `depositAmount` turns the order into a payment plan (balance collected later from Orders). Provider lines are never discounted and carry no stock. Put `"callers": ["premium-commerce"]` on that route.

### 2. Checkout extensions — validate and add fees

`extensions: { "<pluginId>": { … } }` in the checkout body makes Commerce call `<pluginId>/commerce/checkout` with the items, subtotal, method, customer and `data`. The plugin answers:

```json
{ "adjustments": [{ "label": "Delivery · Central", "amount": 250, "key": "delivery" }], "meta": { "mode": "delivery" }, "allowPayLater": true, "requireEmail": true }
```

Adjustments join the total (and the Stripe line items); `meta` is kept public-safe at `order.extensions[pluginId]` for receipts; `allowPayLater` vouches for a pay-later order (pay at the table); `requireEmail: false` lets dine-in guests order without an email.

### 3. Order events

Every state change is published to plugins subscribed through a `plugin:event` hook: `premium-commerce:order.created`, `order.paid`, `order.fulfilled`, `order.cancelled`, `order.refunded` — payload `{ id, order }` with the full order (items carry `provider`/`ref` for provider lines, `extensions` for extensions).

### Internal routes (`callers: ["*"]`)

`internal/config`, `internal/catalog` (products with availability), `internal/order { id | number, token? }`, `internal/orders { status?, channel?, sinceHours? }`, `internal/create-order` (ring up an order from a till / phone: items priced from the catalogue, adjustments, manual discount, offline payment), `internal/settle` (pay-later → paid with cash / terminal), `internal/cancel`, `internal/fulfil`, `internal/extension` (keep public-safe meta on an order). Direct HTTP callers are refused.

## Storefront routes (public)

`catalog`, `availability`, `checkout`, `confirm`, `webhook`, `order`, `upload`, `cart/guest`, `discounts/preview`; signed-in: `checkout/account`, `account/*`, `cart/get|save`.

## Settings

Payment provider (Stripe / Polar) and keys, currency, store name, pay-later, customer accounts, automatic tax, shipping rates and countries, promo codes, phone collection, success / cancel paths, notify email.
