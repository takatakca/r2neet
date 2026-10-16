# R2NETTE — Project status

Snapshot: **2026-10-16**. Repository `takatakca/r2neet`; release branch `main`. **Not 100% production-accepted.**

## Confirmed running release

- Latest verified main commit deployed: `f1d56bf6c6ea0e14955d78cf52e5c167a48cdc31` (CI #38849810401, non-skipped Deploy #38849959878, both health probes).
- [CI #38849810401](https://github.com/takatakca/r2neet/actions/runs/38849810401) succeeded.
- [Deploy #38849959878](https://github.com/takatakca/r2neet/actions/runs/38849959878) performed non-skipped Contabo roll and logged `/healthz ok`, `/readyz ok`, `Deploy verified for commit f1d56bf6c6ea0e14955d78cf52e5c167a48cdc31`.
- Contabo VPS Docker Compose `/opt/r2nette`; Coolify proxy; MochaHost DNS/email. Do not mistake green Actions with a skipped roll for deployment proof.

## Implemented platform

Server-controlled booking quotes and pricing, saved customer bookings/account, crew/staff session roles, PostgreSQL/Prisma, recurrence scheduling, notification/payment/provider integration **code**, durable TAKATAK signed outbox. Verified earlier improvements: PR #26 Unicode-safe ICS; #27 private browser draft sanitization; #28 structured API failure handling; #29 bounded Docker npm retries; #30 spoof-resistant rate limiter; #31 agent continuity reconciliation. Presence of provider integration code does **not** establish live provider availability.

## Newly completed hardening — deployed

- PR #32: once-per-local-calendar-day attempts for failing daily workers; a local PostgreSQL dump with no off-host destination retains the file but logs FAILED and opens an incident. PR CI #38848750100, main CI #38848882332, non-skipped Deploy #38849030331 verified `aa51fd30`.
- PR #33: password-bearing PostgreSQL URLs are scrubbed from `pg_dump` argv; `PGPASSWORD` passed to the child process. PR CI #38849124573, main CI #38849296051, non-skipped Deploy #38849434426 verified `1c140ac1`.

Documentation closure `f1d56bf6c6ea0e14955d78cf52e5c167a48cdc31` passed CI and exact-SHA deployment. PR #34 added signed streamed S3 GET and remote SHA-256 verification, passed PR CI #38853224241 and merged as `02b0653cfc33b6472879f7ac38268b3aa4efedb2`; matching main CI and non-skipped Contabo deployment have not yet been proven in this snapshot. Branch `chatgpt/backup-local-retention-20261016` adds safe local fallback retention on S3 outage; that feature remains CI/deploy pending.

## External launch blockers

The most recent deploy still warned that Stripe secret/publishable/webhook settings, Twilio Voice/SMS, Google Maps, dispatch origin, off-host S3 backups and alert webhook are absent. See [issue #25](https://github.com/takatakca/r2neet/issues/25). No real end-to-end charge, signed webhook, phone OTP, off-host restore, operational paging receipt or every-role booking smoke has been proven. Credentials belong in protected environments, not GitHub source, PRs or logs.

TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is OPEN as of this snapshot; keep `TAKATAK_R2NETTE_SYNC_ENABLED=false` until reviewed, merged, deployed and signature/tenant verified. Preserve strict cross-business segregation and independent R2NETTE UI. Old historical documentation PR #17 needs review before merge.

## Starting point

Read `AGENTS.md`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`; then inspect exact SHA-linked CI and deploy evidence. Canonical Contabo runbook: `docs/deployment/contabo-runbook.md`; recovery: `docs/reservation-system/disaster-recovery.md`.
