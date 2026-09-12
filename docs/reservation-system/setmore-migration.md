# Migrating from Setmore

## What this moves

Existing **customers** and their **future appointments**. Reviews were already
covered separately; this is the part that actually blocks switching off
Setmore, because real people have real cleanings already booked.

```bash
npm run migrate:setmore -- --customers customers.csv --appointments appointments.csv
npm run migrate:setmore -- --customers customers.csv --appointments appointments.csv --apply
```

Dry run unless `--apply`.

## Three rules

**Dry run is the default.** An operator sees every rejection and its reason
before anything is written. On a deliberately messy export:

```
Customers      read 5   importable 3   rejected 2
Appointments   read 7   importable 3   past 1   rejected 3

Services that need a decision before these can be imported:
   2 × Basic Cleaning

Rejected rows (4):
  row 4  phone        No phone or email. This customer could never sign in.
  row 5  phone        Phone number is not a valid North American number.
```

**Import is idempotent.** Every record carries a deterministic external id, so
a half-finished import is resumed rather than duplicated. Verified: the second
`--apply` reported `importable 0, already 3` and created nothing.

**A row is never guessed.** Wrong data is worse than missing data.

## Service mapping refuses to guess

`"Basic Cleaning"` alone does not say whether two cleaners were booked for
three hours or one for four. Guessing sends the wrong number of people to
someone's home, so an ambiguous name is **rejected and reported** with a
count, and the operator is told exactly how to fix the export.

Crew size and duration must both match a catalogue entry. Single-variant
services — move-out, carpet, window — map by name alone. French names are
recognised.

## Decisions worth knowing about

**Times are read as local Montréal wall-clock.** Setmore exports local times;
treating them as UTC would move every appointment four or five hours. Tested
on both sides of the DST boundary.

**Phones are imported unverified.** The customer proves the number themselves
on first sign-in. Importing a phone as pre-verified would let anyone who knows
a number read that customer's bookings.

**Prices are preserved, not recalculated.** The customer already agreed to the
Setmore figure; re-pricing would change what they owe. Imported quotes are
stamped `pricingVersion: setmore-import` so they are never mistaken for
engine output.

**Bookings arrive unassigned.** Dispatch crews them using real availability
rather than trusting Setmore's roster. Verified: `crew:0` on every imported
booking.

**Past appointments are counted, not created.** History is not work to
dispatch; materialising it would put phantom jobs on the board. Cancelled and
no-show rows are skipped entirely.

**An existing customer is matched, not duplicated.** Someone who already
booked on the new platform is matched by verified phone, and their verified
status is left untouched.

## CSV parsing

A minimal RFC 4180 parser, because Setmore exports CSV and addresses contain
commas and quotes — `"754 Av. 36e, Lachine, QC"` is one field, and
`split(',')` corrupts exactly the rows that matter. Handles escaped quotes,
CRLF, and Excel's byte-order mark.

Common Setmore column names are recognised, so the operator does not have to
rename headers.

## After importing

1. `/admin#dispatch` — imported bookings are unassigned and need crews.
2. `/admin#cutover` — the Setmore row now reports how many records moved.
3. Tell customers the new number and site. Their bookings are already there;
   they verify their phone once and see them.

## Not covered

- Setmore staff schedules — rebuild them at `/admin#roster`, which shows
  coverage gaps and refuses changes that would orphan booked work
- Recurring plans (Setmore models them differently; recreate from `/account`)
- Payment history (Stripe holds the payment side going forward)
