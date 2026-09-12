# Recurring plans

## The gap this closed

`RecurrenceSeries` existed and the booking flow sold weekly plans at 25% off,
but nothing ever created the second visit. A weekly customer booked once and
the plan quietly did nothing. This makes the promise real.

## A DST bug found and fixed

The date generator worked in UTC — `setUTCDate`, `Date.UTC` with UTC hours.
That looks right and is not. A 10:00 EDT cleaning is 14:00 UTC, and after the
November change 14:00 UTC is **09:00 EST**. Demonstrated before the fix:

```
Oct 20, 10:00
Oct 27, 10:00
Nov  3, 09:00   ← the customer's cleaning silently moved an hour earlier
Nov 10, 09:00
```

Occurrences are now generated in local wall-clock time and converted back per
occurrence, so the hour survives both changeovers. Tests assert `10:00` across
the fall-back and `09:00` across the spring-forward.

## The rules

**Weekly is every 7 days, not four visits a month.** A test asserts that a
month containing five weekly slots produces five visits — anything assuming
four would under-deliver and under-bill.

**Monthly is a calendar rule.** From the 31st: Jan 31 → Feb 28 → **Mar 31** →
Apr 30 → May 31. The preferred day is stored and never overwritten by a clamp,
which is why February does not permanently drag the series back to the 28th.
Leap years are handled (Jan 30 → Feb 29 in 2028).

## Materialisation

`RecurrenceService.materialiseSeries` creates real bookings up to a **35-day
horizon** — far enough for dispatch to plan, short enough that a price change
or cancelled plan does not leave months to unwind.

Three guarantees:

1. **Every occurrence is priced fresh.** Each gets its own quote and its own
   frozen snapshot, because products, travel, tax and the catalogue can all
   change between visits. This is exactly why the booking flow calls the
   later-visit figure a *preview*. A test asserts one quote per booking.

2. **Capacity is verified, never assumed.** An occurrence that cannot be
   staffed is recorded as `NO_CAPACITY` and surfaced to operations rather than
   created as a job nobody can service.

3. **Generation is idempotent.** Running twice creates nothing extra, and two
   concurrent workers cannot double-book — a per-slot advisory lock plus an
   existence check. Tested with two independent clients.

## Customer controls

- **Pause** stops generation without losing the plan; resuming starts it again.
- **Skip one visit** cancels that booking and records the date, without
  shifting the rhythm. A test asserts the remaining visits keep their original
  dates and the skipped date is not regenerated.

Both are ownership-checked: one customer cannot pause another's plan.

## The worker

```bash
npm run worker:recurrence
```

Run hourly. More often is harmless; less often risks a plan whose next visit
falls inside the booking lead time. Output is one JSON line, with a separate
warning line per unstaffable visit so they cannot pass unnoticed.

## Not built

- Automatic charging of generated visits (the payment path exists; nothing
  schedules it yet)
- Customer-facing notification when a new visit is generated
