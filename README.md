# R2NETTE Reservation Platform

First-party replacement for Setmore. This repository contains **Phase 1: the authoritative
pricing engine** plus a working customer booking flow.

```
npm install
npm test         # 46 tests
npm run typecheck
```

Open `booking.html` in a browser to see the customer flow.

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

### `booking.html` — the customer flow

Mobile-first, single file, no build step. Drop it on any host and point a TikTok or
Instagram link at it. Steps: service → property → **products (required)** → frequency →
extras → address → contact → review.

The running receipt on the right is the point of the whole thing: every fee appears the
moment it applies, so nobody discovers the $25 transport charge at the end.

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

## What is not built yet

Deliberately out of scope for this phase:

- **Availability and scheduling.** Staff capacity, slot holds, double-booking prevention,
  travel buffers, preferred cleaner. A 2-cleaner job must block two people for the full
  window — that's the next piece.
- **Stripe.** Payment policy is seeded `PAY_LATER` to match how Setmore behaves today
  ($0 collected online). The `DEPOSIT` / `FULL_PAYMENT` / `CARD_ON_FILE` types exist in the
  domain; the integration doesn't. Recurring off-session charging comes with it.
- **Database.** The catalogue is in TypeScript. It maps cleanly to Prisma models — every
  monetary field is already an integer, every enum is already defined.
- **Customer accounts, admin dashboard, cleaner app, notifications.**

## Order I'd build the rest in

1. **Postgres + Prisma.** Move `data/` into the schema. The engine doesn't change.
2. **Availability.** The hard one. Staff, shifts, time off, slot holds with expiry, atomic
   booking so two customers can't take the last slot.
3. **Stripe.** Server-created PaymentIntents from engine totals only. Webhook is the source
   of truth. SetupIntent for recurring cards.
4. **Customer portal + admin.** Everything in `config.ts` becomes editable without a deploy.
5. **Cleaner mobile view.** Job sheet, en route, arrived, complete.

---

## Wiring the browser to the server

`booking.html` contains a mirror of the pricing math so the total updates instantly while
someone answers questions. It is **display only**. When you connect a backend:

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
