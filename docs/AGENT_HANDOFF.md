# R2NETTE — Agent handoff

Snapshot: **2026-10-16**. Read AGENTS.md, WORKLOG.md, docs/TASK_QUEUE.md, docs/PROJECT_STATUS.md, docs/DEPLOYMENT.md and docs/DECISIONS.md before changes. Respect current GitHub HEAD and open PRs.

## Last completed work

PR #34 `chatgpt/s3-verified-backup-digest-20261016`: signed streamed GET calculates SHA-256 of S3 remote object after PUT/HEAD and compares with local hash/size. Earlier PR CI #38853010076 failed because an old test fixture simulated only PUT/HEAD. Fixed legacy fixture, added five fake-gateway regression tests, then PR CI [#38853224241](https://github.com/takatakca/r2neet/actions/runs/38853224241) passed. PR [#34](https://github.com/takatakca/r2neet/pull/34) squash-merged as `02b0653cfc33b6472879f7ac38268b3aa4efedb2`. Main CI [#38853348818](https://github.com/takatakca/r2neet/actions/runs/38853348818) was in progress at snapshot; **do not mark this SHA deployed until a matching non-skipped Deploy and exact health probes are observed**.

Earlier PR #33 scrubbed DB passwords from pg_dump process arguments, PR #32 bounded daily failed backup retries. Both deployed and verified; see WORKLOG.

## Current task

Branch `"+branch+"`: after a successful fresh PostgreSQL dump, prune only expired regular local fallback files even if off-host S3 upload later fails. Existing retention was after successful S3 and never executed on failure, potentially filling the disk during prolonged outages. Adds `scripts/backup-retention.ts`, modifies `scripts/loop-backup.ts`, and adds `tests/backup-retention.test.ts`. Validate `BACKUP_KEEP_DAYS` (1–365), ignore unrelated files/symlinks, keep fresh dump. **PR CI and production deployment pending.**

## Files modified

This task: `scripts/loop-backup.ts`, `scripts/backup-retention.ts`, `tests/backup-retention.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `docs/reservation-system/disaster-recovery.md`.
Previous PR #34: `src/workers/object-storage.ts`, `tests/object-storage-integrity.test.ts`, `tests/infrastructure.test.ts`, and agent docs.

## Latest pushed SHA / actually run checks

Branch last functional commit before these docs: `"+head+"`. Resolve final branch HEAD after docs push. Main HEAD at branch start: `02b0653cfc33b6472879f7ac38268b3aa4efedb2` (PR #34 merge). Latest **verified deployed** release at start: `f1d56bf6c6ea0e14955d78cf52e5c167a48cdc31` ([CI #38849810401](https://github.com/takatakca/r2neet/actions/runs/38849810401), [Deploy #38849959878](https://github.com/takatakca/r2neet/actions/runs/38849959878); /healthz, /readyz and exact SHA passed). Later releases must be separately verified.

GitHub actions executed: read files/PRs/issues/CI and deployments; wrote GitHub branch trees/commits, reviewed CI log for failed old PUT/HEAD test and corrected it; verified PR #34 tests passed. No local `npm ci`, live S3 provider, Stripe charge, OTP SMS or real restore drill executed.

## Problems, errors, access

Issue [#25](https://github.com/takatakca/r2neet/issues/25) still needs real Stripe keys and signed webhook, Twilio/Supabase phone provider, Maps/dispatch origin, S3 credentials, alert webhook, off-host scratch restore and real end-to-end smoke. No secrets were added. TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) was still OPEN at last check; sync stays disabled. Historical PR #17 is stale; do not overwrite later deployment evidence.

## Next exact step

1. Verify PR #34 **main CI #38853348818** and matching **non-skipped Deploy** for `02b0653c...`, including `/healthz ok`, `/readyz ok`, and `Deploy verified for commit 02b0653c...`.
2. Open the new local-retention PR and wait for CI. Fix any failing tests before merging. Do not merge prematurely if doing so would intentionally skip an in-flight prior deployment.
3. After this PR passes and merges, check its own main CI and non-skipped deploy; update exact SHA in this handoff. Continue issue #25 S3/alert/restore when protected credentials are supplied.
