# R2NETTE — Agent handoff

Snapshot: 2026-10-15. Read `AGENTS.md`, `WORKLOG.md` and the other `docs/` status files before new development.

## Latest completed and deployed task

Feature PR #26 (UTF-8 RFC 5545 calendar folding, tests and five continuity documents) was merged to `main`. The follow-up documentation commit `152ddf16016038339af1d265f6c8d29b1960a19a` passed [CI #38613223891](https://github.com/takatakca/r2neet/actions/runs/38613223891) and [production Deploy #38614841577](https://github.com/takatakca/r2neet/actions/runs/38614841577). The deployment log explicitly confirmed `Deploy verified for commit 152ddf16...`, `/healthz ok`, `/readyz ok`.

## Task currently being implemented

Branch `chatgpt/privacy-safe-booking-draft-20261015`: make browser draft storage explicitly allowlist-only, drop persisted address IDs and formatted street addresses, drop expired slot state, safely resume at the address step, rewrite historic potentially identifying draft keys, and keep completed bookings from reappearing. Regression tests in `tests/frontend.test.ts` must pass before merging. No production keys or migrations are needed.

## Files modified in current task

`web/src/lib/api.ts`; `tests/frontend.test.ts`; `WORKLOG.md`; `docs/AGENT_HANDOFF.md`; `docs/PROJECT_STATUS.md`; `docs/TASK_QUEUE.md`; `docs/DEPLOYMENT.md`; `docs/DECISIONS.md`.

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

1. Resolve CI for `chatgpt/privacy-safe-booking-draft-20261015`, fix any failure, and merge the green PR to `main`.
2. Verify the matching `main` SHA, successful CI, successful **non-skipped** deploy, and `Deploy verified for commit <sha>` with `/healthz` and `/readyz`.
3. Update these docs to the **observed** release SHA and continue the first feasible task in `docs/TASK_QUEUE.md`, especially robust API failure handling and production smoke coverage; do not claim issue #25 complete without providers.

