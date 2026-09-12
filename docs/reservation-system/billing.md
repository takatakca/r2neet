# Recurring billing and notifications

## The gap this closed

The recurrence worker created future visits and the payment path could charge
a card, but nothing connected them. A weekly customer was served indefinitely
and never billed.

## Scheduling is separate from charging

`scheduleDueBookings()` writes a `BillingAttempt` row for every visit entering
the charge window; `run()` then charges what is claimable. The split means the
queue is **inspectable before money moves** — an operator can see exactly what
is about to be billed.

`PAY_LATER` bookings never enter the queue at all.

## Never charge twice

Three independent guards:

1. `@@unique([bookingId, attemptNumber])` — the database refuses a duplicate.
2. The provider call carries a stable idempotency key, so a timeout after
   Stripe succeeded replays rather than re-charges.
3. `FOR UPDATE SKIP LOCKED` plus a worker lease — two workers on two machines
   cannot claim the same attempt. Tested with independent clients.

A test runs the worker twice and asserts `createPaymentIntentCalls` is
unchanged and exactly one Payment row exists.

## A decline is not a system failure

| Outcome | Behaviour |
|---|---|
| Network, 5xx, 429 | **Soft** — retry at 4h, 24h, 72h, then abandon |
| `card_declined`, `expired_card`, `stolen_card`, `account_closed` | **Hard** — stop immediately |
| `authentication_required` (3DS) | **Hard** — off-session retry cannot succeed |
| No saved card | **Hard** — nothing to charge; surface it |
| Booking cancelled | **Abandoned** — Stripe is never called |

Retrying a dead card annoys the customer, can trigger issuer blocks, and in
some schemes attracts fees. Hard declines land in `needsAttention()` for a
person to chase.

**The booking is never cancelled for a failed payment.** The cleaning stands;
the customer is asked to fix the card.

## Notifications

The rule: **anything that moves money or changes a commitment is told to the
customer.** A silent charge is worse than a declined one.

Deduplication is a unique constraint on `dedupeKey`, not an in-memory guard —
three concurrent sends produce exactly one message, asserted by test.

The row is written **before** the provider call, so a crash mid-send leaves
evidence rather than silence. An unconfigured channel records `SUPPRESSED` and
is never reported as sent.

Only a SHA-256 of the recipient is stored: proof of delivery, not a second
copy of their contact details.

Copy exists in English and French for every template, and payment-failure
copy is checked by test to say the cleaning is **still booked** and how to fix
the card — never anything accusatory.

## The workers

```bash
npm run worker:recurrence   # hourly — create upcoming visits
npm run worker:billing      # every 15 min — charge visits in the window
```

The billing worker exits cleanly with `billing_skipped` when Stripe is not
configured. It never pretends to have billed anything.

## Dunning

`/admin#billing` is the work queue. Cases are keyed by **customer, not
attempt** — three failed visits for one person is one conversation, not three
tickets.

A hard failure opens a case automatically; a successful payment closes it, so
a customer who quietly fixes their own card is never chased. A card that fails
again after being fixed **reopens** the case, because that is new information.

Each row shows what the operator needs without opening it: reason, amount
owed, days open, and **how many cleanings are upcoming** — a dead card matters
far more when someone is booked in two days.

Actions: mark contacted, resolve, write off, or retry one charge immediately
without waiting for the worker.

## Card expiry

`CardExpiryService` warns before a saved card expires at the end of this month
or next, or if it has already expired and is still on file.

Only customers **with an upcoming cleaning** are contacted. Telling a dormant
customer their card expired is noise, not service. Deduped to one warning per
card per month by database constraint, so repeated worker runs do not nag.

## Notification retry

The original design hashed the recipient, which made resending impossible.
That was a real flaw and is now fixed properly: the address is still never
stored, and a retry **re-derives it from the customer record**.

That is better than storing it. If the customer corrected their email in the
meantime, the retry goes to the new one; if they asked us to delete it, the
retry finds nothing and stops with `NO_RECIPIENT` rather than resurrecting
data we were asked to forget. Both are tested.

Three attempts, then `SUPPRESSED` — a person looks at it instead.

## A bug this work uncovered

`ensureStripeCustomer` caught a unique-constraint violation on `customerId`
but not on `providerCustomerId`. When the provider returned an id already on
file, the charge failed with a raw `P2002` that the scheduler classified as a
retryable UNKNOWN — so a stale mapping would have soft-failed **every**
recurring charge for that customer, forever, with no useful error.

Fixed by resolving from either constraint. Found because a dunning test
expected `card_declined` and got `P2002`.

Related: decline classification now reads the error's own `code` and
`retryable` fields rather than `instanceof`. Under some module loaders the
provider class is duplicated and the check silently fails, which would have
turned every hard decline into an endless retry.

## Not built

- Second factor for OWNER accounts
- Notification digest for operations (per-event only today)
