# R2NETTE database

## Concurrency strategy

Capacity contention is serialized with a **PostgreSQL transaction-level
advisory lock** (`pg_advisory_xact_lock`), keyed by a 64-bit FNV-1a hash of the
appointment window (`src/db/prisma-repositories.ts` → `capacityLockKey`).

Why this and not a JavaScript mutex: an in-process lock protects one Node
process. R2NETTE will run behind more than one — multiple containers, or
serverless invocations. The advisory lock lives in Postgres, so every process
contends for the same lock no matter where it runs. It is transaction-scoped,
so it is released on COMMIT, on ROLLBACK, and if the process dies mid-flight.
Keying on the time window rather than a single global lock means bookings for
different days never block each other.

**Verified by falsification.** `tests/postgres.test.ts` races two independent
`PrismaClient` instances (separate connection pools, no shared JS state) for
the final crew. With the lock removed, both succeed — the test fails with
"expected 1, got 2". With it restored, exactly one wins.

## Booking numbers

`R2N-YYYY-NNNNNN`, allocated from `BookingNumberSequence` with
`UPDATE ... RETURNING` inside the booking transaction. Postgres serializes
concurrent updates to the same row. `SELECT MAX(n)+1` would race and is not
used. A 20-way concurrent allocation test asserts zero duplicates.

Gaps are possible after a rolled-back transaction. Uniqueness is guaranteed;
gaplessness is not, and uniqueness is what matters.

## Money

Integer cents everywhere. No `Float` on any monetary column. Tax rates are
micro-percent integers (9.975% = `9_975_000`) so QST arithmetic is exact.

## Timezone

All instants are `timestamptz` (UTC). Local business meaning is applied at the
edges via `America/Toronto`. `StaffAvailability` stores weekday +
minute-of-day, never an absolute instant — "Mondays 8–5" is a local rule that
must survive DST, and storing it as a timestamp would break it twice a year.

## Hold expiry

Availability queries filter on `status = 'ACTIVE' AND expiresAt > now()`.
Correctness never depends on a cleanup job running on time; a lapsed hold stops
consuming capacity the moment it expires, whether or not its row is gone.

## Snapshot immutability

`Quote.priceSnapshot` and `Booking.priceSnapshot` are frozen JSON. Amounts are
copied in, never referenced. Tax rates used are copied onto the quote row too,
so a later rate change cannot rewrite history. Tested against real Postgres:
updating `ServiceOption.basePriceCents` leaves existing quotes and bookings
untouched.

## Test database safety

`src/db/safety.ts` resolves the database per environment with **no fallback
chain**. Under `NODE_ENV=test` only `TEST_DATABASE_URL` is consulted; if it is
missing, resolution throws rather than reaching for `DATABASE_URL`. That
fallback is exactly how a test run destroys production data.

Destructive operations additionally require the *resolved URL* to look
disposable — local host, and a database name containing test/ci/scratch/tmp/
shadow. The check is on the URL, not on a variable name.

Local test instance used during development:

    postgresql://postgres@localhost:5433/r2nette_test

Reset: `npx prisma migrate reset` against `TEST_DATABASE_URL`.
