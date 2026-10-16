# R2NETTE — Project status

Snapshot: **2026-10-15**. Repository `takatakca/r2neet`; release branch `main`. **Not 100% production-accepted.**

## Confirmed running release

- Latest verified main commit deployed: `10d11e89cfc496c58b4773735e60a43efab279ec`.
- [CI #38792313100](https://github.com/takatakca/r2neet/actions/runs/38792313100) succeeded.
- [Deploy #38792567205](https://github.com/takatakca/r2neet/actions/runs/38792567205) performed non-skipped Contabo roll and logged `/healthz ok`, `/readyz ok`, `Deploy verified for commit 10d11e89cfc496c58b4773735e60a43efab279ec`.
- Contabo VPS Docker Compose `/opt/r2nette`; Coolify proxy; MochaHost DNS/email. Do not mistake green Actions with a skipped roll for deployment proof.

## Implemented platform

Server-controlled booking quotes and pricing, saved customer bookings/account, crew/staff session roles, PostgreSQL/Prisma, recurrence scheduling, notification/payment/provider integration **code**, durable TAKATAK signed outbox. Verified earlier improvements: PR #26 Unicode-safe ICS; #27 private browser draft sanitization; #28 structured API failure handling; #29 bounded Docker npm retries; #30 spoof-resistant rate limiter; #31 agent continuity reconciliation. Presence of provider integration code does **not** establish live provider availability.

## Pending code — not a verified production feature

Branch `chatgpt/backup-daily-failure-hardening-20261015` adds one-attempt-per-local-day behavior for failed daily jobs, and makes missing off-host backup destinations raise an incident and return FAILED without deleting the local dump. Added scheduler and backup policy regression tests. Verify PR CI and non-skipped SHA release before moving this to “completed.”

## External launch blockers

The most recent deploy still warned that Stripe secret/publishable/webhook settings, Twilio Voice/SMS, Google Maps, dispatch origin, off-host S3 backups and alert webhook are absent. See [issue #25](https://github.com/takatakca/r2neet/issues/25). No real end-to-end charge, signed webhook, phone OTP, off-host restore, operational paging receipt or every-role booking smoke has been proven. Credentials belong in protected environments, not GitHub source, PRs or logs.

TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is OPEN as of this snapshot; keep `TAKATAK_R2NETTE_SYNC_ENABLED=false` until reviewed, merged, deployed and signature/tenant verified. Preserve strict cross-business segregation and independent R2NETTE UI. Old historical documentation PR #17 needs review before merge.

## Starting point

Read `AGENTS.md`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`; then inspect exact SHA-linked CI and deploy evidence. Canonical Contabo runbook: `docs/deployment/contabo-runbook.md`; recovery: `docs/reservation-system/disaster-recovery.md`.
