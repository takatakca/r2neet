# R2NETTE — Agent handoff

**Verified 2026-10-16.** Always read AGENTS.md, WORKLOG.md, docs/TASK_QUEUE.md, docs/PROJECT_STATUS.md, docs/DEPLOYMENT.md and docs/DECISIONS.md before changing source. GitHub's main HEAD is authoritative; inspect its CI/Deploy runs (including skipped-roll steps) before recording a new release.

## Last completed task

PR [#33](https://github.com/takatakca/r2neet/pull/33) protects database URI passwords from exposure in backup `pg_dump` process arguments using a password-free URI plus child `PGPASSWORD`. PR CI [#38849124573](https://github.com/takatakca/r2neet/actions/runs/38849124573) and main CI [#38849296051](https://github.com/takatakca/r2neet/actions/runs/38849296051) passed. Merged as `1c140ac19682d238c2eef068370b9a8405d43a2d`; **non-skipped Contabo [Deploy #38849434426](https://github.com/takatakca/r2neet/actions/runs/38849434426) verified that exact SHA, `/healthz ok` and `/readyz ok`.**

Earlier this session: PR [#32](https://github.com/takatakca/r2neet/pull/32) fixed repeat-every-minute failed daily backups and made a local-only dump raise a critical incident and report FAILED instead of SUCCESS. PR CI #38848750100, main CI #38848882332 passed; merged `aa51fd30d8ef3eff44130b806f15029cdf8bb568`; **non-skipped [Deploy #38849030331](https://github.com/takatakca/r2neet/actions/runs/38849030331)** verified that SHA and both health probes. Older completed improvements: PR #26 Unicode-safe ICS, #27 private draft sanitation, #28 resilient HTTP errors, #29 bounded Docker retry, #30 trusted-proxy throttling, #31 five-doc continuity.

## Current task

Branch `chatgpt/s3-verified-backup-digest-20261016` addresses insufficient off-host backup verification: `src/workers/object-storage.ts` streams a signed GET and checks remote SHA-256 after PUT and HEAD; `tests/object-storage-integrity.test.ts` covers same-length corruption, truncated bytes and unavailable GET. WORKLOG and the five continuity docs have been updated on this branch. **This fix is not yet merged or production deployed.** Last pushed functional branch SHA before docs: `93417281752b3d198f98ba87a1cf47950e3a7373`. Next action: open PR, wait for green CI including TypeScript/Vitest/container, correct failures, merge green PR and verify non-skipped main CI/Deploy with exact SHA plus health probes.

No provider account or external production secret is added. No real S3 object has been tested. A missing S3 target is still a P0 blocker in issue #25. Prioritize production readiness [issue #25](https://github.com/takatakca/r2neet/issues/25): configure a real S3-compatible off-host destination, verify stored-object checksum and scratch restore with encryption key, and configure an actual alert endpoint; then Stripe signed webhook, Twilio/Supabase OTP, dispatch/Maps, recurring worker and customer/staff end-to-end acceptance. Do not mark complete without real evidence. Unrelated historical [PR #17](https://github.com/takatakca/r2neet/pull/17) remains open; do not merge its older 2026-10-08 deployment claims into the canonical current state without review.

## Files modified in this session

`src/workers/scheduler.ts`, `tests/scheduler.test.ts`, `scripts/loop-backup.ts`, `src/workers/backup-policy.ts`, `tests/backup-policy.test.ts`, `scripts/backup.ts`, `scripts/pg-cli.ts`, `tests/pg-cli.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`.

## Latest verified main release and checks

On 2026-10-16, [CI #38849810401](https://github.com/takatakca/r2neet/actions/runs/38849810401) passed for `f1d56bf6c6ea0e14955d78cf52e5c167a48cdc31`; [Deploy #38849959878](https://github.com/takatakca/r2neet/actions/runs/38849959878) performed non-skipped Contabo VPS roll, `/healthz ok`, `/readyz ok` and exact SHA confirmation. This supersedes older deployment references below. GitHub REST read the current main ref, CI/deploy, agent documents, worker backup/storage code, and TAKATAK PR #175 (still OPEN). Code changes pushed via GitHub Git objects; local npm/Prisma, live S3, restore and alert delivery have NOT been run in this session. After documentation commit, retrieve actual branch HEAD. No additional access required for code; protected S3/alert/Stripe/Twilio credentials and human controlled tests are needed for issue #25.

## Last pushed and verified SHA / checks executed

Last fully verified **functional** main SHA and live Docker image: `1c140ac19682d238c2eef068370b9a8405d43a2d`. This handoff's documentation-only follow-up commit must be resolved from current GitHub `refs/heads/main`, and its CI and deploy independently verified; it does NOT negate the verified functional image above.

GitHub source, agent docs, recent commits, PRs, issue #25 and workflow files read. GitHub Actions PR/main CI checked for both fixes; checks include TypeScript, Vite bundle, database migrations, Vitest tests/invariants and container startup. Non-skipped VPS roll job logs independently checked for each merged code SHA. No local npm/test command, live Stripe charge, real OTP, real S3 restore, paging receipt or cross-tenant sync test was performed.

## Problems / required operator access

The latest Deploy #38849434426 logs warn that Stripe, Twilio Voice/SMS, Maps, dispatch origin, off-host S3 and alert webhook remain unconfigured. Production has not proved live cards, provider sign-in, recovery or alerting. Secrets must be supplied in protected GitHub/server environment by authorized owner; never put secret values in commits, issues or chat. TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) was still OPEN; `TAKATAK_R2NETTE_SYNC_ENABLED=false` until signed receiver is deployed and tenant verified. No new billable services should be created without authorization.

## Exact next action

1. Resolve current main HEAD and inspect matching CI and **non-skipped** Deploy result for this docs-only closure. On failure inspect job log, fix and update WORKLOG; never assume green=rolled.
2. Once the authorized owner configures S3 and alert credentials, run a real off-host backup, HEAD/hash verification, scratch restore, key/MFA validation and a delivered test alert; document specific evidence in issue #25.
3. Continue with Stripe signed webhook and controlled booking/OTP/customer-staff acceptance, or pick the next independent code defect if secrets are still unavailable.
