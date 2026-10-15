# R2NETTE — Agent handoff

Snapshot: 2026-10-15. Read `AGENTS.md`, `WORKLOG.md` and the other `docs/` status files before new development.

## Latest completed and deployed task

Feature PR #26 (UTF-8 RFC 5545 calendar folding, tests and five continuity documents) was merged to `main`. The follow-up documentation commit `152ddf16016038339af1d265f6c8d29b1960a19a` passed [CI #38613223891](https://github.com/takatakca/r2neet/actions/runs/38613223891) and [production Deploy #38614841577](https://github.com/takatakca/r2neet/actions/runs/38614841577). The deployment log explicitly confirmed `Deploy verified for commit 152ddf16...`, `/healthz ok`, `/readyz ok`.

## Task currently being implemented

PR #27 (`c7a472336c440ac30953522daf78d381274494e8`) merged after [successful PR CI #38775267147](https://github.com/takatakca/r2neet/actions/runs/38775267147). The new task in branch `chatgpt/api-response-hardening-20261015` handles malformed/non-JSON proxy/API replies without leaking raw pages or breaking the booking UI. TypeScript and Vitest regression tests in `tests/frontend.test.ts` must pass before merge. The `c7a47233` main-branch CI/deployment is still to be verified; do not call it deployed yet.

## Files modified in current task

New API-response task: `web/src/lib/api.ts`, `tests/frontend.test.ts`, `WORKLOG.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DECISIONS.md`. Previous privacy PR #27 changed the same frontend module and its tests, plus status docs.

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

1. Verify `chatgpt/api-response-hardening-20261015` PR CI and fix specific failed jobs; merge a green PR into `main`.
2. Verify the most recent matching main-branch CI and non-skipped Contabo deployment with `/healthz`, `/readyz`, and exact release SHA.
3. Update `docs/AGENT_HANDOFF.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md` and `WORKLOG.md` with observed deployment, then continue issue #25 or an independent production smoke task.

