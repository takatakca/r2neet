# R2NETTE — Agent handoff

**Verified 2026-10-16.** Always read AGENTS.md, WORKLOG.md, docs/TASK_QUEUE.md, docs/PROJECT_STATUS.md, docs/DEPLOYMENT.md and docs/DECISIONS.md before changing source. GitHub's main HEAD is authoritative; inspect its CI/Deploy runs (including skipped-roll steps) before recording a new release.

## Last completed task

PR [#33](https://github.com/takatakca/r2neet/pull/33) protects database URI passwords from exposure in backup `pg_dump` process arguments using a password-free URI plus child `PGPASSWORD`. PR CI [#38849124573](https://github.com/takatakca/r2neet/actions/runs/38849124573) and main CI [#38849296051](https://github.com/takatakca/r2neet/actions/runs/38849296051) passed. Merged as `1c140ac19682d238c2eef068370b9a8405d43a2d`; **non-skipped Contabo [Deploy #38849434426](https://github.com/takatakca/r2neet/actions/runs/38849434426) verified that exact SHA, `/healthz ok` and `/readyz ok`.**

Earlier this session: PR [#32](https://github.com/takatakca/r2neet/pull/32) fixed repeat-every-minute failed daily backups and made a local-only dump raise a critical incident and report FAILED instead of SUCCESS. PR CI #38848750100, main CI #38848882332 passed; merged `aa51fd30d8ef3eff44130b806f15029cdf8bb568`; **non-skipped [Deploy #38849030331](https://github.com/takatakca/r2neet/actions/runs/38849030331)** verified that SHA and both health probes. Older completed improvements: PR #26 Unicode-safe ICS, #27 private draft sanitation, #28 resilient HTTP errors, #29 bounded Docker retry, #30 trusted-proxy throttling, #31 five-doc continuity.

## Current task

No additional code change is in progress. Prioritize production readiness [issue #25](https://github.com/takatakca/r2neet/issues/25): configure a real S3-compatible off-host destination, verify stored-object checksum and scratch restore with encryption key, and configure an actual alert endpoint; then Stripe signed webhook, Twilio/Supabase OTP, dispatch/Maps, recurring worker and customer/staff end-to-end acceptance. Do not mark complete without real evidence. Unrelated historical [PR #17](https://github.com/takatakca/r2neet/pull/17) remains open; do not merge its older 2026-10-08 deployment claims into the canonical current state without review.

## Files modified in this session

`src/workers/scheduler.ts`, `tests/scheduler.test.ts`, `scripts/loop-backup.ts`, `src/workers/backup-policy.ts`, `tests/backup-policy.test.ts`, `scripts/backup.ts`, `scripts/pg-cli.ts`, `tests/pg-cli.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`.

## Last pushed and verified SHA / checks executed

Last fully verified **functional** main SHA and live Docker image: `1c140ac19682d238c2eef068370b9a8405d43a2d`. This handoff's documentation-only follow-up commit must be resolved from current GitHub `refs/heads/main`, and its CI and deploy independently verified; it does NOT negate the verified functional image above.

GitHub source, agent docs, recent commits, PRs, issue #25 and workflow files read. GitHub Actions PR/main CI checked for both fixes; checks include TypeScript, Vite bundle, database migrations, Vitest tests/invariants and container startup. Non-skipped VPS roll job logs independently checked for each merged code SHA. No local npm/test command, live Stripe charge, real OTP, real S3 restore, paging receipt or cross-tenant sync test was performed.

## Problems / required operator access

The latest Deploy #38849434426 logs warn that Stripe, Twilio Voice/SMS, Maps, dispatch origin, off-host S3 and alert webhook remain unconfigured. Production has not proved live cards, provider sign-in, recovery or alerting. Secrets must be supplied in protected GitHub/server environment by authorized owner; never put secret values in commits, issues or chat. TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) was still OPEN; `TAKATAK_R2NETTE_SYNC_ENABLED=false` until signed receiver is deployed and tenant verified. No new billable services should be created without authorization.

## Exact next action

1. Resolve current main HEAD and inspect matching CI and **non-skipped** Deploy result for this docs-only closure. On failure inspect job log, fix and update WORKLOG; never assume green=rolled.
2. Once the authorized owner configures S3 and alert credentials, run a real off-host backup, HEAD/hash verification, scratch restore, key/MFA validation and a delivered test alert; document specific evidence in issue #25.
3. Continue with Stripe signed webhook and controlled booking/OTP/customer-staff acceptance, or pick the next independent code defect if secrets are still unavailable.
