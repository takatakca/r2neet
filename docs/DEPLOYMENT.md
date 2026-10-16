# R2NETTE — Verified production and deployment runbook

Snapshot: **2026-10-16**. Canonical instructions: [Contabo runbook](deployment/contabo-runbook.md) and [disaster recovery](reservation-system/disaster-recovery.md).

## P0 deploy failure / recovery path

Deploy #38950594071 for SHA `7d03a38522d82a45760aeb69e584d468128fad52` FAILED on Contabo ENOSPC (containerd overlayfs layer extraction). Repeated image pull did not resolve the issue. Do not delete PostgreSQL or Coolify volumes, and do not use global `docker system prune --volumes`. Hotfix PR #39 runs conservative R2NETTE-only old image cleanup BEFORE pull, keeping current and previous images, and other sites untouched. CI and successful actual rollout must be proven; if cleanup cannot free enough space, stop blind retries and request authorized operator storage inspection. Last verified SHA is `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`, Deploy #38855160513.

[Deploy #38952711773](https://github.com/takatakca/r2neet/actions/runs/38952711773) also FAILED after PR #39 target-only cleanup found zero obsolete R2NETTE image tags. Disk `/dev/sda1` showed 96G full with ~550M free. Follow [incident #40](https://github.com/takatakca/r2neet/issues/40) for read-only operator diagnostics; do not delete volumes or other tenants' images. PR #38 is conflict-reconciled but deliberately NOT merged while this P0 blocker remains.

## Last verified Contabo release

- Actual deployed immutable image SHA: `56cde1b6ddd98be1cb146c9d33fff3d91ca6d51d`.
- [Main CI #38854383066](https://github.com/takatakca/r2neet/actions/runs/38854383066): completed SUCCESS.
- [Deploy #38854525800](https://github.com/takatakca/r2neet/actions/runs/38854525800): **non-skipped VPS roll** succeeded, with `/healthz ok`, `/readyz ok` and `Deploy verified for commit 56cde1b6ddd98be1cb146c9d33fff3d91ca6d51d`.
- Previous proven code rollouts: [PR #34 release #38853464615](https://github.com/takatakca/r2neet/actions/runs/38853464615) `02b0653c`; [PR #35 release #38853994829](https://github.com/takatakca/r2neet/actions/runs/38853994829) `46fa61d3`; PR #36 is included in latest image.
- **Documentation-only closure pushes after this snapshot require a separate main CI and non-skipped Deploy check before calling the new SHA deployed.** Source commit and currently running image need not share SHA while CI/roll is in flight.

## Real environment and release rules

GitHub `main` triggers CI and then SHA-tagged Docker Compose Deploy on the Contabo VPS under `/opt/r2nette`, with an existing Coolify reverse proxy. MochaHost handles DNS and email, not the application. No Docker image `:latest` and no server-side Node builds on MochaHost. The deploy guard checks the current main SHA to skip obsolete queued rolls.

1. Read `AGENTS.md`, `WORKLOG.md`, five continuity files, open PRs/issues, and actual main SHA before changes.
2. Make a reviewable branch and run GitHub CI: migrations from scratch, TypeScript, Vitest/invariants, container build/start and security safeguards.
3. Merge only green PR. Confirm matching main CI and exact-SHA Deploy log, **including** an executed `Roll the VPS to that image` step, `/healthz ok`, `/readyz ok`, and `Deploy verified for commit <sha>`. A green skipped deployment is not a release.
4. Verify public TLS, actual operation/worker evidence and customer smoke before declaring business acceptance. Track previous known-good SHA for rollback; read the runbook before destructive or recovery commands.

## Latest verified handoff closure

The docs closure commit `1a8de4abe8bf24dc0e5742070590d1fd974efe9b` also passed [CI #38855018334](https://github.com/takatakca/r2neet/actions/runs/38855018334) and **non-skipped** [Deploy #38855160513](https://github.com/takatakca/r2neet/actions/runs/38855160513), including `/healthz ok`, `/readyz ok` and exact SHA log. This is the latest proven running image before the streaming-upload PR.

Pending branch `chatgpt/s3-stream-upload-20261016`: two-pass streaming SHA-256 + signed S3 PUT removes full dump allocation and guards >5 GiB single PUT requests. PR CI, merge and non-skipped VPS roll are still required; never call provider backups operational based only on unit tests.

## Known missing production configuration

The newest deploy still warns: Stripe cards and signed webhook, Twilio Voice/SMS, Maps, dispatch origin, off-host S3 backup and alert webhook have no protected production configuration. Source code defaults to safe degraded behavior. Real S3 restore and alert receipt NOT verified. Real Stripe payment, OTP, authenticated customer/crew workflows NOT verified. Issue [#25](https://github.com/takatakca/r2neet/issues/25) owns acceptance. Keep TAKATAK event synchronization **disabled** while receiver PR #175 remains unverified. Protected secrets must not enter source, logs, or chat.

## Disaster recovery

A local PostgreSQL dump is not off-host disaster recovery. Schedule off-host upload, check remote size and streamed SHA-256, then restore to scratch DB and validate booking data, operator MFA and matching `FIELD_ENCRYPTION_KEY`. Preserve retired keys during rotation. Run controlled alert delivery and inspect worker-run records. Do not claim the synthetic CI restore drill proves a production off-host restore. Rollback scripts are described in `docs/deployment/contabo-runbook.md` and `scripts/deploy/`.
