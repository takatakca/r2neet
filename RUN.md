# Running R2NETTE

## The booking app

```bash
npm install
npx prisma generate
npm run build          # builds web/ -> dist/
npm start              # serves the API + built frontend
```

Then open **http://localhost:3000/book**

To reach it from your phone on the same wifi, use your computer's LAN address,
e.g. `http://192.168.1.42:3000/book`.

Required env (see `.env.example`):

```
DATABASE_URL=postgresql://...
PRISMA_DATABASE_URL=postgresql://...      # same as DATABASE_URL
```

Everything else is optional and degrades to a NOT_CONFIGURED state.

## Pages

- `/book` — customer booking
- `/account` — the customer's own cleanings: reschedule, cancel, addresses,
  recurring plans, saved card crumbs, profile
- `/admin` — dashboard, dispatch, callbacks, reviews, integrations, cutover
- `/crew?staffId=<id>` — the cleaner's phone app

`/account` uses the same phone-verified session as booking. There is no
password and no separate sign-up: verify once and your cleanings are there.

## Staff accounts

`/admin` and `/crew` require a real staff login. Create the first one:

```bash
npm run staff:create -- --email you@r2nette.ca --name "Your Name" --role OWNER
```

The password prints once. Sign in at `/admin` and change it immediately.

Roles: **OWNER** (everything), **DISPATCHER** (the day, no integrations or
review moderation), **CLEANER** (their own jobs only, in `/crew`).

Turn on two-step verification at `/admin#security`. Set
`FIELD_ENCRYPTION_KEY` first, or the secret is stored unencrypted:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Save the recovery codes shown at enrolment — they are displayed once, and
without them a lost phone means a lost account.

A cleaner login needs `--staffId <id>` so it can be scoped to that person's
schedule.

## Portable preview

`dist-single/index.html` is a genuinely self-contained file: the JS and CSS are
inlined, and it imports nothing external. It will render the full interface
offline, but the booking flow needs the API, so it shows the recovery screen
rather than pretending to work.

For a real test on your phone, use `npm start` and the `/book` URL above.

## Why the earlier download was blank

The previous `r2nette-booking.html` was not standalone. It contained
`import ... from './src/lib/api.js'` — files that were never sent with it, and
which existed only as TypeScript. The module never executed, so translations
never populated and `onclick="goNext()"` referenced a function that was never
defined.

Fixed by: bundling with Vite, replacing all 31 inline handlers with delegated
listeners keyed on `data-action`, and shipping real fallback copy in the HTML
so a JS failure degrades to readable content plus a recovery screen.

## Production

See `docs/reservation-system/deployment.md`. In short:

```bash
NODE_ENV=production TRUST_PROXY=true npm start
```

The app refuses to start in an unsafe configuration — a leftover
`ADMIN_TOKEN`, a test database pointed at production, or a Stripe key with no
webhook secret.

Probes: liveness `/healthz` (never touches the database), readiness `/readyz`.

Rate limiting, security headers, HTTPS enforcement, structured logging and
graceful shutdown are on by default in production. Set `RATE_LIMIT=false` or
`REQUIRE_HTTPS=false` only for local debugging.

## Recurring plans

Weekly, biweekly and monthly plans generate their own visits:

In production these run automatically:

```bash
docker compose up -d
```

Four processes: `web`, `billing`, `scheduler`, `backup`. See
`docs/reservation-system/operations.md` for cadences and overdue thresholds.

The single-shot commands still exist for manual runs:

```bash
npm run worker:recurrence
npm run worker:billing
npm run worker:maintenance
```

Failed payments appear at `/admin#billing`. The cleaning is never cancelled
for a failed card.

It creates bookings up to 35 days ahead, prices each one fresh, verifies a
crew is actually available, and is safe to run twice. Customers can pause a
plan or skip a single visit from `/account`.

## Backup and recovery

```bash
npm run db:backup                       # timestamped pg_dump
npm run security:rotate-key -- --apply  # re-encrypt under a new key
```

**Recovery needs two things: the database dump AND `FIELD_ENCRYPTION_KEY`.**
Restore the data without the key and every two-factor account is locked out.
Store them separately, and store them both.

The full drill — dump, restore to a scratch database, owner signs in with
password plus TOTP against the restored data — is documented in
`docs/reservation-system/disaster-recovery.md` and has been run.

## Monitoring

`/admin#operations` shows what runs unattended, distinguishing **never run
here** from **stopped**, and lists open alerts.

Cutover stays blocked until every critical worker has actually succeeded in
that environment.

Two things need a decision before launch:

```
BACKUP_S3_BUCKET=...      # any S3-compatible provider
ALERT_WEBHOOK_URL=...     # anything accepting a POST
```

Without off-host storage the backups die with the machine, and the admin says
so plainly. See `docs/reservation-system/monitoring.md`.

## Migrating from Setmore

```bash
npm run migrate:setmore -- --customers customers.csv --appointments appointments.csv
```

Dry run by default; add `--apply` to write. Safe to re-run — records carry
deterministic ids, so nothing duplicates.

Imported bookings arrive **unassigned**: open `/admin#dispatch` to crew them.
Rebuild the team and their weekly availability at `/admin#roster` first —
nothing can be booked until at least two cleaners have availability.
Imported phones are **unverified**: customers prove their own number on first
sign-in.

See `docs/reservation-system/setmore-migration.md`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: typecheck,
build, migrations from an empty database, 631 tests, safety invariants, and a
container build that asserts production startup refuses an unsafe config.

```bash
npm run ci                 # typecheck, build, tests
npm run test:invariants    # verify every business rule is still proven
npm run drill:restore      # full backup and restore drill
```

There is no minimum test count. `tests/invariants.ts` names 34 rules that must
never regress; the proving test carries that rule's id in its title, like
`it('[INV-TAX-01] ...')`.

Rewording a test is free. Removing the tag, tagging two tests with the same
id, or tagging one with an undeclared id all fail CI by name, with the
business consequence spelled out.

A weekly workflow re-runs the restore drill, so recovery is verified on a
schedule rather than assumed. Require the `CI` check on `main`.
