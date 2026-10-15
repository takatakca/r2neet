# R2NETTE — Agent handoff

Snapshot: 2026-10-15. Read `AGENTS.md`, `WORKLOG.md` and the other `docs/` status files before new development.

## Latest completed and deployed task

Feature PR #26 (UTF-8 RFC 5545 calendar folding, tests and five continuity documents) was merged to `main`. The follow-up documentation commit `152ddf16016038339af1d265f6c8d29b1960a19a` passed [CI #38613223891](https://github.com/takatakca/r2neet/actions/runs/38613223891) and [production Deploy #38614841577](https://github.com/takatakca/r2neet/actions/runs/38614841577). The deployment log explicitly confirmed `Deploy verified for commit 152ddf16...`, `/healthz ok`, `/readyz ok`.

## Task currently being implemented

PR #27 was merged as `c7a472336c440ac30953522daf78d381274494e8` (CI green). PR #28 API response recovery passed CI #38775884609 and merged as `ce8eb68dbb49d67fd9c7949c700fd25261d66380`. IMPORTANT: c7a47233 production Deploy #38775849037 FAILED during Docker `RUN npm ci` with npm `ECONNRESET`; one failed-jobs retry was started, but is not a deployment success. Current task in branch `chatgpt/docker-npm-network-recovery-20261015`: bounded recovery from transient npm registry failures in Dockerfile, preserving deterministic install and failing after three attempts.

## Files modified in current task

Current infrastructure task: `Dockerfile`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`. Earlier PR #28 changed the API client, frontend tests, and continuity docs.

## Last pushed commit and verification

- Last **verified production**: `152ddf16016038339af1d265f6c8d29b1960a19a` (CI success, Deploy success and both application probes).
- Feature branch PR SHA must be resolved from live GitHub before deployment; branch creation does **not** mean publication.
- Inspected GitHub main, last commits, active PR #17, issue #25, CI/deploy logs, code, runbooks, and frontend persisted-draft flows. New regression tests are committed for GitHub CI; local `npm ci`, `npx prisma generate`, `npm run ci` were not yet run in this session.
- Standard checks: `npm ci && npx prisma generate && npm run ci`; remote CI also applies migrations from scratch and builds Docker. Never claim success before the workflow reports it.

## Known failures / blockers and permissions

- Production logs still warn Stripe card payment, Twilio Voice/SMS, Google Maps, dispatch coordinates, off-host S3 backup, and alert webhook are unconfigured. Owner/provider access is required to supply real values via protected GitHub `production` environment and server setup, not chat/git. See [issue #25](https://github.com/takatakca/r2neet/issues/25).
- TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is still open. Keep R2NETTE → TAKATAK sync disabled until deployed receiver verifies signed events.
- Historical open PR #17 supplies useful 2026-10-08 production/auth acceptance records; review separately before merging to avoid stale launch claims.
- No destructive force-push or bypass of required CI/deploy gates.

## Exact next step

1. Inspect `chatgpt/docker-npm-network-recovery-20261015` PR CI (Docker build is critical), fix any failing job and merge a green PR.
2. Verify the most recent `main` CI and matching **non-skipped** Deploy; read `Build and push` and `Roll the VPS` logs, `/healthz`, `/readyz`, and exact released SHA. An npm registry ECONNRESET must not be reported as a successful deploy.
3. Record SHA and verified deployment in this file, `docs/DEPLOYMENT.md` and `WORKLOG.md`; then pursue external integrations in issue #25 only when owner credentials exist.

