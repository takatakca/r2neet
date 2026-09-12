# Running R2NETTE in production

## The gap this closed

Every worker existed as a command someone had to remember to run. That is a
checklist, not a system. A billing worker that runs when a developer is awake
does not honour "24 hours before service."

## Topology

`docker-compose.yml` runs four roles from one image:

| Process | Command | Why |
|---|---|---|
| `web` | `npm start` | Customer, admin and crew traffic |
| `billing` | `npm run loop:billing` | Money. Isolated on purpose. |
| `scheduler` | `npm run loop:scheduler` | Recurrence, callbacks, notifications, digest |
| `backup` | `npm run loop:backup` | Nightly `pg_dump`, off-host |

`migrate` runs `prisma migrate deploy` once and exits; everything else waits
for it to complete, so no process ever serves against an un-migrated schema.

**Billing is deliberately its own process.** Sharing with notification retries
means a notification bug can delay a charge, and restarting to fix
notifications interrupts billing.

## Cadence

| Job | Interval | Overdue after |
|---|---|---|
| callbacks | 60s | 10 min |
| billing | 5 min | 30 min |
| notification retry | 5 min | 30 min |
| recurrence | 1 hour | 4 hours |
| card expiry | 09:00 local | 48 hours |
| operations digest | 07:00 local | 48 hours |
| backup | 03:00 local | 36 hours |

A callback promised "in about 5 minutes" cannot wait for a nightly cron, so it
runs every minute. Recurrence is idempotent, so an hourly cadence is safe and
a missed hour is caught by the next run.

## Daily jobs use local wall-clock time

Pinning a job to a UTC hour means it fires at 07:00 in summer and 06:00 in
winter. `dailyLocalAt` compares local minutes in `America/Toronto` and records
the local date it last ran, so it fires once per calendar day across both DST
changes. Tested at both transitions.

## Overdue detection

**A job that has never succeeded is overdue from the start.** This matters
more than it sounds: the failure mode being guarded against is a worker that
silently never starts, which would otherwise look identical to a healthy idle
one.

Overdue tracks *successes*, not attempts, so a job failing every minute is
reported as overdue rather than busy.

A failed run still records an attempt, so a broken job backs off to its normal
interval instead of spinning.

## Overlap

A slow run is never started twice. A tick that finds a job still running logs
`job_still_running` and skips it.

## Evidence, not assumption

Every run writes a `WorkerRun` row: worker, start, finish, status, duration,
detail, error. Proven end to end — the scheduler created five recurring
bookings unattended, recorded `{"plans":1,"created":5}`, reported itself no
longer overdue, and created nothing extra on the next pass.

Telemetry writes are best-effort: losing a row never fails the job.

## Backups leave the host

Set `BACKUP_S3_BUCKET` and the nightly dump is copied off-machine. Without it
the backup dies with the machine, and the job reports
`offHost: NOT_CONFIGURED` rather than pretending otherwise.

Local dumps are pruned after `BACKUP_KEEP_DAYS` (default 7). Off-host
retention belongs to the bucket lifecycle policy.

Each run records the encryption key fingerprint, so a restore can confirm it
holds the matching key material.

## Starting it

```bash
cp .env.example .env      # fill in DATABASE_URL, FIELD_ENCRYPTION_KEY, Stripe
docker compose up -d
docker compose logs -f billing
```

Unconfigured providers idle rather than crash-loop: the billing loop logs
`billing_idle` when Stripe is absent and picks it up on the next restart once
credentials appear.

## Still needs arranging

- An S3-compatible bucket and credentials for off-host backups
- An alerting destination for overdue workers and failed backups
- Periodic restore drills (the procedure is in `disaster-recovery.md`)
