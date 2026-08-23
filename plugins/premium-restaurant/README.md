# Restaurant

Everything a restaurant needs that Commerce and Bookings do not already do. The menu is your `products` collection (with `category`, `station`, `dietary`, `available`, `popular` fields); every order is a Commerce order; table reservations are Bookings. This plugin adds:

- **Ordering** — delivery with postcode zones (fee, minimum, ETA), pickup, dine-in from QR table cards, opening hours → order slots, tips and service charge. It takes part in the Commerce checkout through `extensions["premium-restaurant"]`.
- **Staff app** (`/staff` on the site) — PIN sign-in; **POS** that rings up orders through Commerce (cash, card terminal, open tabs, manual discount), dispatches drivers, voids; **cash drawer** shifts with Z reports; **kitchen display** per station; **printer agent** for browser printing.
- **Printing** — kitchen tickets per station and receipts, through the browser agent or PrintNode.
- **Reservations** — every table is mirrored into Bookings as a resource (seats = capacity, opening hours = availability) with one "Table reservation" service; guests book on the Bookings routes, staff manage them in Plugins → Bookings.

Requires **Commerce**. **Bookings** is optional (reservations).

## Storefront

Checkout (Commerce `checkout`): add `extensions: { "premium-restaurant": { mode, at?, tableCode?, postcode?, tipPercent? | tipAmount? } }`. The order gets delivery / service / tip adjustments and `extensions["premium-restaurant"]` (mode, table, zone, time) on the receipt page.

| Route | Body | Returns |
| --- | --- | --- |
| `config` | — | modes, hours, tips, pay-later flags, `reservationServiceId` |
| `menu` | — | products by category with modifiers and stations |
| `slots` | `{ mode, date }` | order times |
| `zone` | `{ postcode }` | delivery zone or a friendly "no" |
| `table` | `{ code }` | the table behind a QR code |
| `track` | `{ order, token }` | live status for the tracking page |

Staff routes (`staff/*`, `pos/*`, `kds/*`, `print/*`) take the PIN session token in `X-Staff-Token`.

## Interop

- Implements `commerce/checkout` (called by Commerce) and subscribes to `premium-commerce:order.*` events to create tickets, prints and the fulfilment record.
- Calls Commerce `internal/catalog`, `internal/order(s)`, `internal/create-order`, `internal/settle`, `internal/cancel`, `internal/fulfil`.
- Calls Bookings `services/sync`, `resources/sync|unsync`, `bookings/query`.
- Exposes `internal/fulfilment { id }` to any plugin.
