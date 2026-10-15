# R2NETTE — Agent handoff

Snapshot: 2026-10-15. Read `AGENTS.md`, `WORKLOG.md` and the other `docs/` status files before new development.

## Latest completed and deployed task

Feature PR #26 (UTF-8 RFC 5545 calendar folding, tests and five continuity documents) was merged to `main`. The follow-up documentation commit `152ddf16016038339af1d265f6c8d29b1960a19a` passed [CI #38613223891](https://github.com/takatakca/r2neet/actions/runs/38613223891) and [production Deploy #38614841577](https://github.com/takatakca/r2neet/actions/runs/38614841577). The deployment log explicitly confirmed `Deploy verified for commit 152ddf16...`, `/healthz ok`, `/readyz ok`.

## Task currently being implemented

Privacy PR #27 (`c7a47233`) and API recovery PR #28 (`ce8eb68d`) passed CI and merged. `ce8eb68dbb49d67fd9c7949c700fd25261d66380` was VERIFIED in production via [Deploy #38776393992](https://github.com/takatakca/r2neet/actions/runs/38776393992), non-skipped VPS roll plus `/healthz` and `/readyz`. The c7a47233 first Deploy #38775849037 failed at npm registry ECONNRESET; one rerun published the image but correctly skipped the stale VPS roll. Docker install retry PR #29 passed CI and merged as `6a7f192e0ffb46deecde97a6e836ba88fc59e93a`, whose own main-branch deploy must still be verified. Current task: branch `chatgpt/trusted-proxy-rate-limits-20261015`, use trusted Express `req.ip` rather than untrusted raw X-Forwarded-For to prevent spoofed OTP throttle bypass.

## Files modified in current task

Current hardening task modifies `src/api/hardening.ts`, `tests/hardening.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DECISIONS.md`, `docs/DEPLOYMENT.md`. PR #29 previously modified Dockerfile and operational docs.

## Last pushed commit and verification

- Last **verified production**: `ce8eb68dbb49d67fd9c7949c700fd25261d66380` ([Deploy #38776393992](https://github.com/takatakca/r2neet/actions/runs/38776393992), roll and both probes succeeded).
- Feature branch PR SHA must be resolved from live GitHub before deployment; branch creation does **not** mean publication.
- Inspected GitHub main, last commits, active PR #17, issue #25, CI/deploy logs, code, runbooks, and frontend persisted-draft flows. New regression tests are committed for GitHub CI; local `npm ci`, `npx prisma generate`, `npm run ci` were not yet run in this session.
- Standard checks: `npm ci && npx prisma generate && npm run ci`; remote CI also applies migrations from scratch and builds Docker. Never claim success before the workflow reports it.

## Known failures / blockers and permissions

- Production logs still warn Stripe card payment, Twilio Voice/SMS, Google Maps, dispatch coordinates, off-host S3 backup, and alert webhook are unconfigured. Owner/provider access is required to supply real values via protected GitHub `production` environment and server setup, not chat/git. See [issue #25](https://github.com/takatakca/r2neet/issues/25).
- TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is still open. Keep R2NETTE → TAKATAK sync disabled until deployed receiver verifies signed events.
- Historical open PR #17 supplies useful 2026-10-08 production/auth acceptance records; review separately before merging to avoid stale launch claims.
- No destructive force-push or bypass of required CI/deploy gates.

## Exact next step

1. Verify `chatgpt/trusted-proxy-rate-limits-20261015` PR CI and the spoofed-header rate limiter tests; correct failures and merge only after full CI passes.
2. Check matching latest `main` SHA in GitHub Actions CI and a non-skipped Deploy, including `Deploy verified for commit ...`, `/healthz`, `/readyz`.
3. Update `docs/AGENT_HANDOFF.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `WORKLOG.md` with exact verified released SHA; continue issue #25 and end-to-end smoke when real provider credentials exist.

