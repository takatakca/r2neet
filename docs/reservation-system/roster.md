# The cleaner roster

## A promise I had to make good

The Setmore migration doc said staff schedules should be "rebuilt in
`/admin`". That screen did not exist — cleaners could only be created by seed
fixtures, so the owner could not hire anyone without a developer.

`/admin#roster` is that screen.

## Why availability is not a detail

Availability is what the scheduling engine reads to decide whether a slot can
be offered at all. A day with no cleaners silently offers nothing, which looks
to a customer exactly like being fully booked.

The coverage table makes that visible before a customer finds it:

| Day | Cleaners | Two-cleaner jobs |
|---|---|---|
| Sunday | 0 | No |
| Monday–Friday | 2 | Yes |
| Saturday | 1 | **No** |

Saturday has someone working but cannot staff a 2-cleaner service — the most
common booking. That distinction is the point of the column.

## Guardrails

**Overlapping windows are rejected, not merged.** Two overlapping windows are
almost always a typo, and merging them hides the mistake until someone is
booked at a time they never offered. The error names the day.

**Reducing a week reports the jobs it orphans.** Restricting a cleaner to
weekdays when they have a Saturday booking returns the affected booking
numbers, so a dispatcher moves them deliberately. Verified:

```
CONFLICT_REPORTED: R2N-2026-000777
```

**Deactivation is refused while jobs remain.**

```
DEACTIVATE_REFUSED: 409 | HAS_UPCOMING_JOBS
```

Cleaners are deactivated, never deleted — someone who has done work is part of
the record, and deleting them would orphan history.

**Time off names the bookings it covers**, so they are reassigned rather than
silently abandoned. Overlapping periods are refused so coverage stays legible.

**A new cleaner gets a standard weekday week by default.** Created with no
availability they can never be booked, which reads as a broken system rather
than an empty schedule. Creating someone unbookable is possible, but has to be
asked for.

That default lives in the service, not the route — a cleaner created by any
path gets a workable week. Caught by a test that exercised the service
directly and found it produced an unbookable cleaner.

## Staff vs StaffUser

`Staff` is a schedulable resource; `StaffUser` is a login. An owner may have a
login and never be dispatched; a cleaner may be on the schedule before they
have an account. The roster shows which cleaners have a login without exposing
anything about the account.

## Permissions

Viewing needs `dispatch.view`, so a dispatcher can see coverage. Editing the
roster needs `staff.manage` — owner only. Time off needs `dispatch.assign`,
because a dispatcher handling a same-day call-in should not need the owner.

## Cutover

The Setmore cutover page now requires **two** active cleaners, not one:
two-cleaner services are most of the catalogue and cannot be booked with fewer.
