# Bookings

Appointments and reservations for any business on PremiumCMS: a dentist, a nail salon, a tattoo studio, an event hall, a restaurant's tables. One plugin, one mental model, reused by every theme.

- **Services** — what gets booked: duration, buffer, price, deposit (fixed or %), who can take it, an optional intake form (Forms plugin). Two kinds: *appointment* (one customer, one staff member) and *reservation* (a party on an asset with enough capacity).
- **Staff & resources** — *staff are your CMS users* (pick them from the user list; they get weekly hours and time off). *Assets* are rooms, tables, chairs, courts — anything with a capacity.
- **Slot engine** — free times in your time zone, per resource, honouring hours, time off, buffers, per-slot capacity, minimum notice and the booking horizon. Reservations pick the smallest free table that fits the party.
- **Holds & payment** — a paid service is *held* for a few minutes while the customer pays through the Commerce plugin (deposit or full price). The order confirms it; an abandoned checkout releases it.
- **Automations** — confirmation, reminders before, thank-you / aftercare after, recalls months later, no-show follow-ups. Placeholders: `{{first_name}} {{name}} {{service}} {{resource}} {{when}} {{party_size}} {{store}} {{site_url}} {{manage_url}}`.

## Storefront routes (public)

| Route | Body | Returns |
| --- | --- | --- |
| `config` | — | time zone, currency, horizon |
| `services` | `{ kind? }` | bookable services with deposit, intake form, pickable staff |
| `availability` | `{ serviceId, date, resourceId?, partySize? }` | slots for a day |
| `days` | `{ serviceId, days?, partySize? }` | days with at least one slot |
| `hold` | `{ serviceId, startsAt, resourceId?, partySize?, customer, notes?, intakeSubmissionId? }` | the booking, its token, and `checkoutItem` to pass to Commerce when payment is due |
| `lookup` / `cancel` | `{ id, token }` | the customer's booking |

Paying: add `checkoutItem` (`{ productId: "premium-bookings:<bookingId>", quantity: 1 }`) to a Commerce `checkout`. Commerce asks this plugin for the price and reports the order's life cycle back.

## Interop (other plugins)

Declare the `plugins:call` capability and call:

- `resources/sync { externalId, record }` — mirror your own record (a restaurant table, a treatment room) as a bookable resource; `resources/unsync { externalId }` removes it.
- `services/sync { slug, record }` — keep a service in sync (the restaurant's "Table reservation").
- `bookings/query { from?, to?, externalId?, kind?, status? }` — bookings in a window.
- `bookings/create` — a walk-in / phone booking, confirmed at once.

Events consumed: `premium-commerce:order.created|paid|cancelled|refunded` (provider lines of this plugin).

## Settings

Time zone, slot interval, minimum notice, horizon, hold minutes, cancellation cut-off, booking page path, notify email, business name, currency.
