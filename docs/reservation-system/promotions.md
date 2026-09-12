# Promotion claims

## The rule

A limited promotion is consumed **exactly once, when an eligible booking
becomes genuinely committed**. A quote never consumes it. An abandoned or
failed checkout never consumes it.

## Why a state machine and not a boolean

The original design redeemed on payment success. Under the seeded `PAY_LATER`
default no payment ever happens at reservation time, so a customer could book
repeatedly and claim the $15 welcome offer every time. A simple
redeemed-yes/no flag also cannot express the interesting middle state: a
checkout that is holding the offer but has not yet committed.

`PromotionClaim` has three states:

    RESERVED  ──▶ REDEEMED   (committed; final)
        │
        └───────▶ RELEASED   (payment failed, hold expired, abandoned)

## Commitment point by payment policy

| Policy | Redeemed when |
|---|---|
| `PAY_LATER` | booking reaches CONFIRMED and the hold is consumed |
| `FULL_PAYMENT` | Stripe confirms payment **and** booking is CONFIRMED |
| `DEPOSIT` | the required deposit succeeds **and** booking is committed |
| `CARD_ON_FILE` | the SetupIntent succeeds **and** booking is CONFIRMED |

For `PAY_LATER` the reservation and redemption happen in the same transaction
as the booking, because there is nothing to wait for.

## Losing candidates are never reserved

`BEST_SINGLE_DISCOUNT` evaluates every eligible discount, but only the
**winner** is claimed. Basic $110 weekly: the 25% frequency discount ($27.50)
beats the welcome offer ($15), so no claim row is created at all and the
welcome offer stays available for a future booking.

Basic $110 monthly is the other way round: 10% is $11, the welcome offer is
$15, so the offer wins and is redeemed on commitment. Later visits in that
plan use the 10% discount.

## Concurrency

A partial unique index carries the invariant:

```sql
CREATE UNIQUE INDEX "PromotionClaim_one_active_per_family"
  ON "PromotionClaim" ("customerId", "promotionFamily")
  WHERE "status" IN ('RESERVED', 'REDEEMED');
```

`RELEASED` rows are excluded, so a failed checkout genuinely frees the offer
while history is preserved. Two simultaneous checkouts cannot both hold the
welcome offer — the loser fails on the database, not on an application-level
check-then-act. Tested with two independent `PrismaClient` instances.

## Family scope

`NEW_CUSTOMER_BASIC` ($15) and `NEW_CUSTOMER_DEEP` ($20) share the
`NEW_CUSTOMER` family with a lifetime limit of one. Redeeming either makes the
other ineligible.

## Tested

17 tests in `tests/promotion-claims.test.ts`, including the PAY_LATER exploit,
two-client concurrency on both `reserve` and `reserveAndRedeem`, webhook
replay idempotency, expired-claim release, and the weekly/monthly
BEST_SINGLE_DISCOUNT interaction.
