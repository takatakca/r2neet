# R2NETTE API v1

Base path `/api/v1`. JSON in, JSON out. CAD, integer cents.

## Two invariants

1. **Identity comes from the session cookie**, never from the request body.
   A `customerId` in a payload or query string is ignored.
2. **Money comes from the server.** `total`, `totalCents`, `grandTotalCents`,
   `gstCents`, `qstCents` in a request body are ignored. The pricing engine
   is authoritative.

Both are enforced by tests, not convention.

## Auth

`POST /auth/phone/send` — `{ phone }`. Returns the same shape whether or not
the number is known to us, so the endpoint cannot be used to enumerate
customers. Never returns or logs the code.

`POST /auth/phone/verify` — `{ phone, code }`. On success sets an opaque
`r2n_session` cookie (HttpOnly, Secure in production, SameSite=Lax) and
returns the customer. The cookie carries a random id only; no customer data
rides in the browser.

`POST /auth/logout` — destroys the session.

## Customer (session required)

- `GET /customer/me`
- `GET /customer/addresses` — scoped to the session customer
- `GET /customer/bookings`

## Catalogue

`GET /services` — active, publicly bookable options. Window Cleaning returns
`pricingMode: QUOTE_REQUIRED` with `basePriceCents: null`, never `0`. Internal
migration-review notes are not exposed.

## Quotes

`POST /quotes` — selections only: `serviceOptionId`, `frequency`,
`productSupplyOption`, `addOns`, `distanceKm`. Returns the quote with
`firstVisit` and, for recurring frequencies, `subsequentVisitPricingPreview`.
Persists the quote and its lines. **Never consumes a promotion** — redemption
belongs to a confirmed, paid booking.

Guests are provisionally eligible for the new-customer promotion; the quote
carries `NEW_CUSTOMER_ELIGIBILITY_UNVERIFIED` and must be re-evaluated once
identity is known.

`GET /quotes/:id` — owner-scoped.

## Availability

`GET /availability?serviceOptionId=&date=YYYY-MM-DD` — real slots from the
scheduling engine. Returns times only; staff identities are internal. A
quote-required service returns 400 rather than a fabricated slot.

## Holds

`POST /booking-holds` (session) — `{ quoteId, startAt }`. The server sets
expiry, crew size and staff; the client cannot supply them. 10-minute TTL.

`GET|DELETE /booking-holds/:id` — owner-scoped. DELETE is idempotent.

## Bookings

`POST /bookings` (session) — `{ holdId, quoteId, addressId }`. Everything else
is server-derived. Returns `R2N-YYYY-NNNNNN`, allocated by the database.

Under the seeded `PAY_LATER` default the response carries
`paymentStatus: NOT_COLLECTED`. No Payment row is created and nothing is ever
reported as PAID without Stripe.

`GET /bookings/:id` — owner-scoped, 404 for anyone else.

## Idempotency

`Idempotency-Key` on `POST /booking-holds` and `POST /bookings`, scoped to
(customer, route, key). Same key + same payload replays the stored result.
Same key + a materially different payload returns
`409 IDEMPOTENCY_CONFLICT` rather than silently executing a second command.

## Errors

    { "error": { "code": "...", "message": "...", "requestId": "..." } }

`VALIDATION_ERROR`, `UNAUTHORIZED`, `RATE_LIMITED`, `OTP_*`,
`QUOTE_NOT_FOUND`, `QUOTE_EXPIRED`, `HOLD_NOT_FOUND`, `HOLD_EXPIRED`,
`SLOT_UNAVAILABLE`, `BOOKING_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`,
`INTERNAL_ERROR`. Stack traces are never returned.

## What these replace in the prototype

| Prototype behaviour | Real endpoint |
|---|---|
| hard-coded service constants | `GET /services` |
| in-browser price mirror | `POST /quotes` |
| no availability at all | `GET /availability` |
| no capacity reservation | `POST /booking-holds` |
| `R2N-` number from `Math.random()` | `POST /bookings` |
| local "You're booked" screen | persisted booking response |
| manual km input | server distance (Google Routes, next phase) |

## Known production requirements

`SessionStore` and `IdempotencyStore` are in-process. Both are behind
interfaces; a `Session` table or Redis slots in without touching route code.
**Multi-instance deployment requires that swap** — documented rather than
faked.

## Account (session required)

- `GET /account/overview` — upcoming and past bookings, saved places,
  recurring plans, payment-method crumbs. Every list is scoped to the session
  customer.
- `POST /account/bookings/:id/cancel`
- `POST /account/bookings/:id/reschedule`
- `POST /account/addresses/:id/default`
- `DELETE /account/addresses/:id`
- `PATCH /account/profile`

**The 24-hour policy is enforced on the server, not in the browser.** The
overview returns `canCancel` / `canReschedule` flags so the UI knows what to
offer, but both endpoints re-check the window and return
`409 CANCELLATION_WINDOW_CLOSED` regardless of what the client sends.

**Rescheduling re-runs the same capacity check as a new booking**, inside the
same advisory lock, and reassigns the crew from the result. A customer can
never move onto a slot the business cannot staff. The booking's own current
assignment is excluded from the busy set so it does not block its own move.

**Cancelling releases a claimed welcome offer** back to the customer
(`releaseReason: BOOKING_CANCELLED`), so a cancelled first booking does not
silently consume their one lifetime offer.

An address with an upcoming cleaning cannot be deleted
(`409 ADDRESS_IN_USE`). Payment methods expose brand, last4 and expiry only —
never the provider token, never a PAN.
