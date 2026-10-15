# R2NETTE — Agent handoff

Verified snapshot: **2026-10-15**. Always read `AGENTS.md`, `WORKLOG.md`, `docs/TASK_QUEUE.md`, and the relevant runbooks before work.

## Last completed task

PR #30 hardened the API rate limiter against spoofed `X-Forwarded-For` prefixes by using Express's configured trusted-proxy-derived `req.ip`. PR [#30](https://github.com/takatakca/r2neet/pull/30) passed [CI #38776981777](https://github.com/takatakca/r2neet/actions/runs/38776981777), merged into `main` as `a46849b5e29619a7ee8fd14469e2a98d70b6b28c`, and passed main [CI #38777285346](https://github.com/takatakca/r2neet/actions/runs/38777285346). **Production [Deploy #38777515485](https://github.com/takatakca/r2neet/actions/runs/38777515485) succeeded**: non-skipped VPS roll, `/healthz ok`, `/readyz ok`, and `Deploy verified for commit a46849b5e29619a7ee8fd14469e2a98d70b6b28c`.

Other verified releases: PR #28's `ce8eb68dbb49d67fd9c7949c700fd25261d66380` [Deploy #38776393992](https://github.com/takatakca/r2neet/actions/runs/38776393992) and PR #29's Docker retry `6a7f192e0ffb46deecde97a6e836ba88fc59e93a` [Deploy #38776842943](https://github.com/takatakca/r2neet/actions/runs/38776842943), each with `/healthz ok`, `/readyz ok` and exact-SHA verification. PR #27's privacy fix was included in these later deployed images.

## Current task

Branch `chatgpt/finalize-handoff-20261015`: reconcile the five durable project-status files with real PR, CI and release evidence. This is documentation, not a substitute for provider activation or live end-to-end smoke. Its own PR and deployment need verification.

## Modified files

`WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/DEPLOYMENT.md`.

## Last pushed SHA / checks executed

- Newest merged **functional** `main` commit: `a46849b5e29619a7ee8fd14469e2a98d70b6b28c`, CI passed.
- Last **verified deployed** SHA: `a46849b5e29619a7ee8fd14469e2a98d70b6b28c` ([Deploy #38777515485](https://github.com/takatakca/r2neet/actions/runs/38777515485), probes and roll passed).
- Checked GitHub commits/PRs/issues, GitHub CI and deploy jobs/logs; inspected frontend privacy/API handling, Docker retry and server rate-limiter code. CI suites include TypeScript, migrations from scratch, Vitest, security and container. No local `npm ci`, `npm run ci`, or production secrets were executed or exposed in chat.
- Deployment logs for a46849b5: `Deploy verified for commit a46849b5...`, `/healthz ok`, `/readyz ok`.

## Known blockers / required access

- [Issue #25](https://github.com/takatakca/r2neet/issues/25): provider credentials for Stripe (including signed webhook), Twilio, Google Maps, dispatch origin, off-host S3 backup and alert webhook are missing in production; the owner/provider admin must place them through protected environments. No guessed secrets or fake payment tests.
- TAKATAK receiving [PR #175](https://github.com/takatakca/takatak-v1/pull/175) was OPEN on latest check. Keep synchronization disabled pending approved receiver deployment and HMAC verification.
- [PR #17](https://github.com/takatakca/r2neet/pull/17) contains dated 2026-10-08 auth/production acceptance history; review separately, do not overwrite fresher release evidence or merge unexamined.
- Full real SMS/Google login, payments, cancellation and staff/worker smoke tests remain unverified.

## Exact next action

1. Verify this documentation branch's PR #31 CI, resolve any failures, merge after passing, and record its merge SHA in WORKLOG.
2. Verify **the docs-only commit's** independent main CI and non-skipped deployment, including `/healthz`, `/readyz` and `Deploy verified for commit <sha>`.
3. Continue the next executable item in `docs/TASK_QUEUE.md`, prioritizing proof of real provider setup, backups, alerts and auth/payment flows, and keep TAKATAK sync gated.
