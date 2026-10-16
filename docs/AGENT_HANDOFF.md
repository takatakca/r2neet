# R2NETTE — Agent handoff

Snapshot: **2026-10-16**. Restart by reading AGENTS.md, WORKLOG.md and all five docs/* continuity files. Recheck main HEAD, recent open PRs, main CI, deployed exact SHA; do not redo previous agents' work.

## Last completed change

PR [#35](https://github.com/takatakca/r2neet/pull/35) adds safe local retention after a valid fresh pg_dump even when S3 is unavailable. PR CI #38853550724 passed and merge SHA is `46fa61d32d1ff8b973d2910f597c5cacd992948a`; main CI #38853881854 passed. Matching Deploy #38853994829 was **PENDING** behind the preceding release. The feature is merged but its VPS rollout is NOT yet verified.

PR [#34](https://github.com/takatakca/r2neet/pull/34) compares streamed S3 remote SHA-256 against local dump, catching same-length corruption; initial PR CI #38853010076 failed due a historical HEAD-only mock; corrected and PR CI #38853224241 passed. Merge `02b0653cfc33b6472879f7ac38268b3aa4efedb2`, main CI #38853348818 passed. [Deploy #38853464615](https://github.com/takatakca/r2neet/actions/runs/38853464615) was **IN PROGRESS, Roll the VPS to that image**, not yet a verified production release. Do not claim these code SHA releases deployed without successful non-skipped job logs and health probes.

## Current task

Branch `"+branch+"` adds `AbortSignal.timeout(10000)` to signed operational webhook POST requests, ensuring an unresponsive alert receiver cannot indefinitely stall a worker or backup failure recording. New tests in `tests/alert-webhook-timeout.test.ts` cover a successful POST with signal, hanging fetch rejection, and HTTP 503 failure. PR CI and VPS deploy pending. Final branch pushed SHA before this documentation: `"+head+"` (resolve actual SHA after docs commit).

## Files modified

Current: `src/workers/health.ts`, `tests/alert-webhook-timeout.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`.
Prior session: `src/workers/object-storage.ts`, `tests/object-storage-integrity.test.ts`, `tests/infrastructure.test.ts`, `scripts/loop-backup.ts`, `scripts/backup-retention.ts`, `tests/backup-retention.test.ts` and recovery/monitoring docs.

## Checks executed / last known deployed SHA

On GitHub reviewed repo HEAD, open PRs, WORKLOG/AGENTS, backup and alert code, issues, CI and deployment status. PR #34 and #35 green CI, main #34 and #35 green CI. CI/deploy for this alert timeout code remain pending. No local `npm ci`, database changes, Stripe charge, Twilio OTP or real S3 restore were run. Most recent **independently verified production** image remains `f1d56bf6c6ea0e14955d78cf52e5c167a48cdc31` ([CI #38849810401](https://github.com/takatakca/r2neet/actions/runs/38849810401), [Deploy #38849959878](https://github.com/takatakca/r2neet/actions/runs/38849959878), exact SHA, /healthz and /readyz). This may be superseded ONLY with new proven logs.

## Known errors / access

Deploy #38853464615 ran unusually long at its VPS rolling step. Its final job state and logs MUST be inspected. Missing actual production configuration per [issue #25](https://github.com/takatakca/r2neet/issues/25): Stripe live card and signed webhook, Twilio Voice/SMS and phone Auth, Google Maps, dispatch coordinates, off-host S3, alert webhook, real remote restore and worker/customer acceptance. No provider secrets have been installed. TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) OPEN at last check: keep sender disabled; no cross-tenant shortcuts. Historical docs PR #17 remains unrelated/stale. Protected credentials from authorized owner needed for actual integration proof, not for these code fixes.

## Exact next action

1. Check Deploy #38853464615 for non-skipped success and `Deploy verified for commit 02b0653c...`; diagnose any failure rather than re-running blindly. Check queued Deploy #38853994829 and exact SHA health proof for `46fa61d3...`.
2. Open this alert timeout branch PR; require complete green CI, fix failures and merge only passing changes.
3. Check final main CI and non-skipped deployment, update WORKLOG and handoff with exact deployed SHA, then advance issue #25 provider/restore/alert acceptance or the next executable code defect.
