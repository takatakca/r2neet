# R2NETTE — Agent handoff

Snapshot: **2026-10-14**, from GitHub-connected review. Read `AGENTS.md` and the newest `WORKLOG.md` entries before modifying code.

## Last completed task
Previous agent repaired the TypeScript CI fixture, secured ICS text escaping, guarded against stale release jobs, and corrected the README. Last **verified deployed** SHA: `fea51644ecee9e8ed600a72915dfb72425daae66`. [CI](https://github.com/takatakca/r2neet/actions/runs/38611375959) and [Deploy](https://github.com/takatakca/r2neet/actions/runs/38611624915) both succeeded; deploy logs checked `/healthz` and `/readyz`.

## Task currently in progress
Add RFC 5545 **UTF-8 byte-aware** calendar folding and regression tests; establish canonical status/queue/handoff/deploy/decision files. Branch: `chatgpt/r2nette-handoff-ics-20261014`. See `docs/TASK_QUEUE.md`.

## Modified / new files in this task
`web/src/lib/api.ts`, `tests/frontend.test.ts`, `WORKLOG.md`, `docs/TAKATAK_INTEGRATION.md`, and the new `docs/PROJECT_STATUS.md`, `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`.

## Last pushed SHA and checks
- Last verified `main` and production SHA before this task: `fea51644ecee9e8ed600a72915dfb72425daae66`.
- **After the branch is pushed**, use `git log -1 --format=%H`, the PR head or GitHub branch ref for the exact task SHA. Never infer that pushing a branch means production deployed.
- Already checked: default branch and open issues/PRs, deploy run results, source code and infrastructure docs. New changes require independent PR CI and then a `main` deploy check; do not report those as passing before they actually pass.

## Commands / verification
```bash
npm ci
npx prisma generate
npm run ci
npm run test:invariants
git rev-parse HEAD
```
These are prescribed local commands; they are **not** claimed as executed by this agent. Automated GitHub `CI` includes TypeScript, build, tests, migrations, security checks and container validation. Verify the exact matching `main` deploy job and its `Deploy verified for commit ...` log, not merely a green workflow name.

## Known blockers / required access (never paste secret values)
- [Issue #25](https://github.com/takatakca/r2neet/issues/25): Stripe live/test keys + webhook, Twilio credentials/numbers, Google Maps key + business origin, S3-compatible provider/retention/access, alert endpoint.
- TAKATAK [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is open; production synchronization MUST remain disabled.
- Protected GitHub environment `production`, Contabo SSH deployment access, MochaHost domain/email and TAKATAK Supabase Auth provider admin access may require their respective authorized operators.

## Real deployment status
Production ran `fea51644` at the latest verified check, through Contabo Docker (with existing Coolify proxy). External provider readiness is **not proven** by health endpoints.

## Exact next action
1. Check GitHub PR/branch for `chatgpt/r2nette-handoff-ics-20261014` and its CI. If failing, inspect failed job logs, fix **that** code, and rerun. If green, merge through approved `main` gate.
2. Verify `main` CI and its matching deploy run, including `/healthz`, `/readyz` and final SHA.
3. Record the resulting commit and deployed SHA here, update `WORKLOG.md` and queue, then take the next executable item or issue #25 prerequisites.

