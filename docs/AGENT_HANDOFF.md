# R2NETTE — Agent handoff

Snapshot **2026-10-16**. Read AGENTS.md, WORKLOG.md and docs/TASK_QUEUE.md, docs/PROJECT_STATUS.md, docs/DEPLOYMENT.md, docs/DECISIONS.md on every reactivation. GitHub main and exact deploy logs, not prior agent claims, are authoritative.

## Last completed code change

PR [#37](https://github.com/takatakca/r2neet/pull/37) replaces in-memory PostgreSQL dump reads during S3 PUT with two-pass incremental SHA-256 hashing plus streamed signed PUT; rejects >5 GiB single PUT. PR CI [#38950086842](https://github.com/takatakca/r2neet/actions/runs/38950086842) passed. Merged as `7d03a38522d82a45760aeb69e584d468128fad52`; main CI [#38950346352](https://github.com/takatakca/r2neet/actions/runs/38950346352) was pending at last check, with NO matching production deployment confirmed yet. Do not assert PR #37 deployed without exact-SHA non-skipped deploy proof.

Most recent actually verified production image at start: `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`, main CI #38855018334 success, non-skipped [Deploy #38855160513](https://github.com/takatakca/r2neet/actions/runs/38855160513) success with `/healthz ok`, `/readyz ok`, exact SHA marker. Earlier PRs #34/#35/#36 merged and verified on Contabo; see WORKLOG.

## Current task

Branch `"+branch+"` protects manual and nightly backups from obviously invalid custom-format dump files even when pg_dump returns zero exit status. It implements `validatePostgresDump(file)` in `scripts/backup-validation.ts`, checks `PGDMP` magic + at least 1024 bytes, and calls the guard in `scripts/backup.ts` and `scripts/loop-backup.ts` **before** deleting any old fallback dumps or uploading off-host. Invalid local files remain for diagnostics. New `tests/backup-validation.test.ts` checks valid/malformed/empty/missing files. Last functional branch SHA before docs `"+head+"`; resolve final SHA after docs commit. **PR/CI/deploy pending**; do not claim code shipped.

## Files modified

`scripts/backup.ts`, `scripts/loop-backup.ts`, `scripts/backup-validation.ts`, `tests/backup-validation.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `docs/reservation-system/disaster-recovery.md`.

## Evidence and actual checks executed

GitHub connector read latest main refs, job status/log for existing release, PRs, issue #25, code for backup/storage and security tests; created GitHub branch and commits. PR #37 checks passed and merged, its new main CI and deployment remain to be verified. No local npm/Prisma command, live S3 backup, real payment, OTP or real restore has been performed during this task. The PGDMP check is a guard, NOT proof of a restorable database.

## Blockers/access

[Issue #25](https://github.com/takatakca/r2neet/issues/25): protected off-host S3 credentials and real scratch restore with matching encryption key, alert endpoint and receipt, Stripe live signed webhook, Twilio phone/SMS, Maps/dispatch and end-to-end booking/customer/staff acceptance remain unresolved. TAKATAK central receiver `takatakca/takatak-v1#175` not confirmed merged/deployed; keep sender disabled and preserve tenant isolation. Historical PR #17 is old rollout documentation; do not blindly merge. Never put secrets in source, logs or issues.

## Exact next action

1. Check main CI #38950346352 and matching non-skipped Deploy for `7d03a385...`; log `Deploy verified for commit <sha>`, `/healthz ok` and `/readyz ok` must be seen before reporting success.
2. Open current branch PR, run CI and fix any test failure, then merge if green. Check its main CI and actual VPS release as above; do not bypass protections.
3. Reconcile WORKLOG and all five docs to latest verified SHA before ending. If provider credentials unavailable, continue independent source fixes without claiming 100% ready.
