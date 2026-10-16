# R2NETTE — Agent handoff

Updated: 2026-10-15. On restart read AGENTS.md, WORKLOG.md, docs/TASK_QUEUE.md, docs/PROJECT_STATUS.md, docs/DEPLOYMENT.md and docs/DECISIONS.md. Verify GitHub main and CI/deploy logs before any claims.

## Last completed work

PR #31 documentation was merged as b845e0f1; follow-up 2ca571af succeeded in production. The most recent main SHA, **10d11e89cfc496c58b4773735e60a43efab279ec**, passed [CI #38792313100](https://github.com/takatakca/r2neet/actions/runs/38792313100) and **actually rolled** on Contabo in [Deploy #38792567205](https://github.com/takatakca/r2neet/actions/runs/38792567205). Logs show both `/healthz ok`, `/readyz ok` and `Deploy verified for commit 10d11e89cfc496c58b4773735e60a43efab279ec`. This is the last verified deployed SHA until a newer non-skipped deployment is proven.

Earlier verified hardening: PR #26 UTF-8 calendar export; #27 private browser draft cleanup; #28 API error resilience; #29 bounded Docker npm retry; #30 spoof-resistant trusted-proxy rate limits; #31 continuity docs. Do not redo them.

## Current task / branch

`chatgpt/backup-daily-failure-hardening-20261015`: fix daily scheduler re-running failed jobs on every tick (which can exhaust backup volume); require off-host destination after a local dump or mark backup FAILED and create a backup incident. Preserve local file when missing off-host target, keep successful S3 verified upload path unchanged. Created/modified:

- `src/workers/scheduler.ts`, `tests/scheduler.test.ts`
- `scripts/loop-backup.ts`, `src/workers/backup-policy.ts`, `tests/backup-policy.test.ts`
- `WORKLOG.md` and continuity documents.

Latest **functional branch** SHA before these docs: `c5a4bf77754db93097cf9b5fdbdfa1ece9d19104`. Resolve updated branch SHA after pushing documentation. Main still `10d11e89cfc496c58b4773735e60a43efab279ec` at task start. **The new fix has not yet passed CI or deployed**; treat PR status as pending until proven.

## Checks genuinely run

GitHub API: read AGENTS, five status docs, WORKLOG, relevant source, tests, production Compose/workflows, issue #25 and open PR titles; validated main CI #38792313100; examined non-skipped deploy #38792567205 logs and exact SHA + health probes. Used GitHub Git tree/commit/ref writes on a separate branch. **No local npm, Vitest, DB drill, production secret check or real payment flow was run in chat.** Next check is GitHub PR CI (TypeScript, tests, migrations, image).

## Known blockers and necessary access

Issue [#25](https://github.com/takatakca/r2neet/issues/25): missing Stripe live key/webhook, Twilio phone/Voice/SMS provider, Maps key/business dispatch coordinates, off-host S3 target, alert webhook, and actual booking/payment/worker/restore acceptance. Secrets must be provisioned through protected server environment, never in Git. TAKATAK receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) remains OPEN, so `TAKATAK_R2NETTE_SYNC_ENABLED=false`. Old unrelated documentation PR #17 remains open and must not be blindly merged. No additional human access is needed for this PR; provider activation needs authorized owner credentials.

## Next exact action

1. Open the branch PR; monitor GitHub PR CI, correct any failure and merge only green checks.
2. Verify `main` CI and the **non-skipped** Contabo roll with `Deploy verified for commit <actual merge SHA>`, `/healthz`, `/readyz`.
3. Update the documented SHA and handoff again; continue issue #25 off-host restore/alerts as provider access allows, or move to another independent code task.
