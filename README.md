# R2NETTE Reservation Platform

First-party replacement for Setmore: a working bilingual reservation platform with authoritative server pricing, PostgreSQL/Prisma, scheduling, customer accounts, crew/dispatch operations, payments integration and CI-gated Docker deployment. Historical phase-1 price audit notes are retained below.

```
npm ci
npx prisma generate
npm run ci
npm start
```

Run the API and open `http://localhost:3000/book` after configuring the database. See [`RUN.md`](RUN.md), [`WORKLOG.md`](WORKLOG.md) and the [Contabo production runbook](docs/deployment/contabo-runbook.md).

---

## What is built

### `src/` — the pricing engine

One function, `createQuote()`, owns every price in the business. The website, the admin
dashboard, Stripe and the future mobile app all call it. A customer can never see one total
on the site and a different one on their invoice.

| File | What it does |
|---|---|
| `domain/money.ts` | Integer cents. `applyRate()` does exact half-up rounding with no floating point anywhere. |
| `domain/types.ts` | Every enum and model in the reservation domain. |
| `data/config.ts` | **All business values live here.** Prices, rates, discounts, tax, transport. Nothing is hard-coded in a component. |
| `data/catalogue.ts` | The 11 services migrated from Setmore, with legacy names preserved. |
| `data/promotions.ts` | New-customer offers, the disabled legacy VIP promo, migration review notes. |
| `engine/tax.ts` | GST + QST, each on the pre-tax base. Throws if anyone ever adds a compounding rule. |
| `engine/discounts.ts` | BEST_SINGLE_DISCOUNT resolution and NEW_CUSTOMER lifetime eligibility. |
| `engine/recurrence.ts` | Weekly = 7 days. Monthly = real calendar dates with short-month clamping. |
| `engine/quote.ts` | The engine. Validates, prices, snapshots. |

### `web/` — the production customer flow

Mobile-first and bilingual. The running app is built from `web/` and served by the Node API at `/book`. Steps cover service, property, required cleaning products, frequency, extras, address, available time, details and checkout. Catalogue choices and price quotes come from the server. `booking.html` remains a legacy/prototype file, not the deployed application.

---

## The rules it enforces

**Tax.** GST 5% and QST 9.975% are each calculated on the pre-tax taxable subtotal. QST does
not compound on GST. Each line rounds half-up independently.

```
taxable subtotal   $135.00
GST  5%            $  6.75
QST  9.975%        $ 13.47   (13.46625 rounded up)
TOTAL              $155.22
```

**Discounts never stack.** Every eligible discount is priced, and only the largest is
applied. A $110 weekly booking gets the $27.50 frequency discount, not $27.50 + $15. The
losing candidates are recorded on the quote so the decision is auditable.

**New-customer offers are once per lifetime.** The $15 Basic and $20 Deep offers share one
eligibility family. Redeem either and the other closes. A promotion that loses is not
consumed — and quote generation never consumes anything at all. Redemption happens inside
the booking confirmation transaction, so an abandoned quote can't burn someone's offer.

**Recurring quotes show two prices.** A new customer booking monthly gets the $15 promo on
visit 1 ($95 service) and 10% afterwards ($99 service). These are returned as separate
sections, always both, never blended into one number. The second is labelled a *preview* at
today's rates, not a locked future charge.

**Products are a required question.** Basic, Deep and Move-In/Out demand an answer. Carpet
and Window are `NOT_APPLICABLE` and reject product charges outright.

**Window Cleaning is quoted, not free.** Requesting a fixed price throws `QuoteRequiredError`.
It has no invented duration — the accepted quote establishes real staffing and time.

**One transport fee per visit.** $25 covers the visit, not each cleaner. First 20 km
included, $0.65/km after. Taxable.

**Clock time ≠ labour time.** 2 cleaners × 2 hours is a 2-hour appointment and 4 labour-hours.
Never displayed as "4HRS" the way Setmore did.

---

## Prices seeded from Setmore

| Service | Crew × time | Price |
|---|---|---|
| Basic | 1 × 3h | $110 |
| Basic | 2 × 3h | $200 |
| Basic | 2 × 2h | $140 |
| Basic | 2 × 4h | $260 |
| Deep | 1 × 3h | $115 |
| Deep | 2 × 3h | $230 |
| Deep | 2 × 2h | $130 ⚠ |
| Deep | 2 × 4h | $260 ⚠ |
| Move-In/Out | 2 × 2h | $140 |
| Carpet | 1 × 2h | $199 |
| Window | quote | — |

⚠ Flagged for your review, price preserved:
- Deep 2×4 at $260 is identical to Basic 2×4.
- Deep 2×2 at $130 is low relative to the other Deep options.

**The legacy weekly promo needs a decision.** Your Setmore page advertises 3h = $125 and
4h = $150 with products and tax included, while the banner says $25/hr with a 4-hour minimum
on a 12-month term. Under the new engine a weekly Basic 3h works out to about $137 all-in.
Existing weekly customers would be paying more. The plan is seeded disabled and private,
with a grandfathering structure ready, until you decide.

---

## Operational features and production configuration

The original phase-1 "not built" list is now obsolete. The repository
implements PostgreSQL/Prisma persistence, capacity-based scheduling and slot
holds, Stripe payment logic, recurring workers, a customer portal, staff
dispatch/crew views, notifications and a production Docker release workflow.
Read [RUN.md](RUN.md) and the reservation-system docs for current contracts.

**Deployed code is not the same as configured service.** The successful
2026-10-14 Contabo release warned of missing production settings for Stripe,
Twilio SMS/Voice, Google Maps, the dispatch origin coordinates, off-host S3
backups, and the alert webhook. These features cannot be considered fully
operational until settings are added securely and verified. Never commit
credential values to the repository.

The TAKATAK synchronization outbox is intentionally disabled pending
TAKATAK-side approval, release and verified HMAC signature handling. See
[TAKATAK integration](docs/TAKATAK_INTEGRATION.md).

---

## Wiring the browser to the server

The deployed browser requests server catalogue values and authoritative quotes. It sends **selections, never client-computed totals**. This sample illustrates the existing backend contract:

```js
// Send selections. Never send a total.
const res = await fetch('/api/v1/quotes', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    serviceOptionId, frequency, productSupplyOption,
    transport: { distanceKm }, addOns, promotionCode
  })
});
```

The server recalculates from `createQuote()` and its number is the one that gets charged.
`TEST 42` proves a client-supplied total is ignored.
