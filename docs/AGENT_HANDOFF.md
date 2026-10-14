# R2NETTE — Agent handoff

Snapshot: **2026-10-14**, from GitHub-connected review. Read `AGENTS.md` and the newest `WORKLOG.md` entries before modifying code.

## Last completed task

Merged [PR #26](https://github.com/takatakca/r2neet/pull/26): RFC 5545 UTF-8 75-octet physical-line folding, Unicode regression test, five project continuity documents, accurate TAKATAK integration gate. Newest **feature merge** on `main`: `39e10d165357c3882ed16f9e59b8ded986411719`; PR CI [run #38612761806](https://github.com/takatakca/r2neet/actions/runs/38612761806) succeeded (typecheck/build, tests, safeguards, container, aggregate CI).

## Task currently in progress

Check the exact `main` CI and **real Contabo deployment** for `39e10d16` and the later documentation-maintenance commit. Do not equate an approved PR with a deployed release. Then continue [production readiness issue #25](https://github.com/takatakca/r2neet/issues/25) with the independent tasks possible without new external credentials.

## Files modified

Feature PR #26: `web/src/lib/api.ts`, `tests/frontend.test.ts`, `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `docs/TAKATAK_INTEGRATION.md`, `WORKLOG.md`.

Current handoff update: `AGENTS.md`, `WORKLOG.md`, `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md`.

## Last pushed commit / verification executed

- Last merged *feature* SHA: `39e10d165357c3882ed16f9e59b8ded986411719`. This handoff update itself creates a later documentation commit; find its exact HEAD in GitHub instead of assuming the feature SHA is the current HEAD.
- Latest verified production SHA **before this change**: `fea51644ecee9e8ed600a72915dfb72425daae66`; [Deploy #38611624915](https://github.com/takatakca/r2neet/actions/runs/38611624915) succeeded and logged `/healthz ok`, `/readyz ok`, `Deploy verified for commit fea51644...`.
- Executed: GitHub repo/PR/open issue review, review of AGENTS/WORKLOG/RUN/deploy/monitoring docs, code inspection, GitHub code/tree commits and compare, PR CI inspection. Automated GitHub CI for feature PR #26 passed. Local `npm ci`, `npx prisma generate`, `npm run ci` and `npm run test:invariants` were **not executed locally** in this ChatGPT session (the remote CI ran its equivalent).
- Next checks: GitHub Actions for the new `main` SHA, `Deploy verified for commit <sha>`, HTTP `/healthz`, `/readyz`, and separate external-service smoke tests; never assume a release succeeded until those logs confirm it.

## Known blockers / required access (never paste secret values)
- [Issue #25](https://github.com/takatakca/r2neet/issues/25): Stripe live/test keys + webhook, Twilio credentials/numbers, Google Maps key + business origin, S3-compatible provider/retention/access, alert endpoint.
- TAKATAK [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is open; production synchronization MUST remain disabled.
- Protected GitHub environment `production`, Contabo SSH deployment access, MochaHost domain/email and TAKATAK Supabase Auth provider admin access may require their respective authorized operators.

## Real deployment status
Last proven production SHA is `fea51644` before the new release's deploy check, through Contabo Docker with existing Coolify proxy. The PR #26 code SHA is `39e10d16`, awaiting its own matching deployment verification. External provider readiness is **not proven** by health endpoints.

## Exact next action
1. Confirm the most recent `main` SHA in GitHub, its CI and **matching** Deploy workflow. Inspect actual rollout steps and logs, including `/healthz`, `/readyz` and `Deploy verified for commit <sha>`.
2. If a job fails, read the specific failed step logs and correct the code in a new reviewable branch. If the deploy is green, record the exact released SHA and time in this file and `WORKLOG.md`.
3. Resume issue #25: provider setup (Stripe webhook, Twilio, Google Maps, off-host S3, alert hook), controlled booking/payment smoke, and TAKATAK receiver PR #175 gate. Do not enable integrations without their credentials and verification.

