# R2NETTE — Agent handoff

Updated 2026-10-16. On restart read `AGENTS.md`, `WORKLOG.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, and `docs/DECISIONS.md` and check GitHub open PRs before new work.

## CURRENT P0 — disk exhaustion, hotfix PR #39

Last verified production: `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`, non-skipped Deploy #38855160513 with `/healthz ok`, `/readyz ok` and exact SHA. PR #37 merged streamed S3 PUT at `7d03a38522d82a45760aeb69e584d468128fad52` and main CI #38950346352 passed, but Deploy #38950594071 FAILED extracting a containerd image layer with `No space left on device`. Do NOT assert PR #37 deployed. PR #38 PGDMP archive validation passed PR CI #38950701808 but should remain OPEN until recovery.

Current branch `chatgpt/contabo-disk-recovery-20261016` and PR #39 modifies `scripts/deploy/remote-deploy.sh`, adds `scripts/deploy/pre-pull-cleanup.sh` and `tests/pre-pull-cleanup.test.ts`. Cleanup runs before pull and after successful promotion; it only deletes old R2NETTE SHA image tags, protecting current/previous/target and other applications/volumes. Last functional branch commit before docs: `cfce52ac848d1bb8e69c61b8962526280a48a7fe`. Actual branch HEAD must be checked after docs commit; CI, merge and production recovery not yet verified. No local SSH, df, Docker prune or actual VPS modifications performed here — reviewed GitHub Actions job log of failed Deploy #38950594071 and source/runbooks. Next exact action: require green PR #39 CI, fix failures, merge; verify non-skipped main deploy and exact SHA/health. If still ENOSPC, no blind retries: authorized server operator must inspect disk and approve any broader selective cleanup. After recovery, merge CI-green PR #38, verify deployment and reconcile docs. Provider issue #25 and TAKATAK receiver gate remain unresolved.

## 2026-10-17 — why the Contabo disk is full (read from Deploy #38952711773)

PR #39 merged as `deb7dd26` and its pre-pull cleanup ran in Deploy #38952711773, which still failed. The job log is the evidence: `Removed 0 unused old R2NETTE image tags` and `/dev/sda1 96G 96G 550M 100% /`. So the entire 96 GB root filesystem is full and R2NETTE's images are not what fills it; the cleanup can only ever remove obsolete R2NETTE SHA tags and found none. Each R2NETTE pull needs several hundred MB of containerd snapshot space (the `node_modules` layer alone is 117 MB compressed) and fails with 550 MB free. The server is a shared Coolify host (snapshot ids above 7,700), so the space belongs to other applications' images, build cache, container logs or volumes, which no R2NETTE workflow may delete. Branch `claude/hopeful-clarke-xvwac3` adds a read-only **Server admin → `disk-report`** task that prints `df`, `docker system df`, the largest directories, oversized container logs, journal size and R2NETTE's own images/backups/logs. Next exact action: owner runs `disk-report` on `main` once this branch is merged (or runs the same commands over SSH), frees space as the server operator, then re-runs **Deploy** by "Run workflow" on `main`. Do not run `docker system prune --volumes`.

## 2026-10-17 — customer phone login / OTP (branch `claude/hopeful-clarke-xvwac3`)

Field report: `/login?google=phone` on r2nette.ca showed "That phone number needs 10 digits." The number typed was `51445874587`, eleven digits without a leading 1, so the server's `normalizePhone` rejected it correctly; the page simply gave no formatting or pre-check. Verified facts, not assumptions:

- R2NETTE already authenticates customers against the **shared TAKATAK Supabase project** (`TAKATAK_SUPABASE_URL` + anon key, GoTrue `/auth/v1/otp` and `/auth/v1/verify`). RentAuto (`takatakca/rentautoca`, `src/lib/takatak-phone-auth.ts`) and TAKATAK's own login (`master-phone-login-form.tsx`) call the same project with `signInWithOtp` / `verifyOtp`. The "one identity for every company" design is in place; nothing in R2NETTE talks to Twilio directly.
- Twilio is configured **inside that Supabase project** (Authentication → Providers → Phone), not in any R2NETTE variable. `takatak-v1` `docs/mimt/AUTH_AND_CRM.md` and issue takatak-v1#141 still list "confirm live provider config and real SMS test" as open. That is where "the code never arrives" is fixed; no R2NETTE setting can.
- The TAKATAK receiver `src/app/api/integrations/r2nette/events/route.ts` is present in `takatak-v1` `main` at `574766b7` (2026-10-16). Its production deployment and secrets are still unverified, so `TAKATAK_R2NETTE_SYNC_ENABLED` stays `false`.
- TAKATAK's `/api/v1/auth/otp/{send,verify}` master API is scoped to the 1LV integration (`TAKATAK_1LV_API_KEY`, `source_application` must be `1lv`); it is not a route R2NETTE may use.

Changes on the branch: `web/src/lib/auth.ts` formats the number as typed (`formatPhoneInput`) and refuses anything but ten national digits with a hint before any request; `web/src/i18n/index.ts` gains `nationalPhoneDigits`; `src/identity/identity.ts` adds `diagnose()` (GET `/auth/v1/settings`: phone enabled, `sms_provider`, auto-confirm) and logs GoTrue `error_code` on a refused send; `/api/v1/admin/integrations` returns `phoneAuth` and `web/admin.html` shows it as the first card; `source_application: R2NETTE` rides the OTP request. Tests: `tests/supabase-phone-auth.test.ts`, `tests/frontend.test.ts`. Local: typecheck, build, and the non-database suites pass; see WORKLOG for CI.

Exact next action: open the PR, get CI green, merge only after PR #39 restores deploys. Then the owner opens `/admin#integrations` on the deployed build: `PHONE DISABLED` or `UNREACHABLE` names the exact Supabase-side fix; `READY` means run one real handset SMS login and record it in issue #25 and takatak-v1#141. Nothing in this branch claims OTP delivery works.

### Historical sections below predate this current incident; prioritize P0 above

## Last completed and deployed task

PR #36 bounded alert webhook delivery to ten seconds; main CI #38854383066 passed and Deploy #38854525800 performed an actual Contabo roll with `/healthz` and `/readyz` OK. PR #34 streamed S3 remote GET SHA-256 verification, non-skipped Deploy #38853464615; PR #35 bounded local backup retention, Deploy #38853994829. All are deployed. Prior authentication, ICS and backup fixes remain intact.

The most recent **exactly verified production** release is `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`. [CI #38855018334](https://github.com/takatakca/r2neet/actions/runs/38855018334) succeeded and the **non-skipped** [Deploy #38855160513](https://github.com/takatakca/r2neet/actions/runs/38855160513) shows `/healthz ok`, `/readyz ok`, `Deploy verified for commit 1a8de4abe8bf24dc0e5742070590d1fd974efe9b`. Don't infer deployment of later branch SHAs from CI alone.

## Current task and scope

Branch `chatgpt/s3-stream-upload-20261016` fixes the S3 upload path that previously used `readFileSync(filePath)` and buffered entire PostgreSQL dumps. `src/workers/object-storage.ts` now first hashes the dump in bounded chunks and then streams a signed PUT with explicit Node fetch `duplex: 'half'`. The unchanged HEAD + signed streamed GET verification must still match remote SHA-256. Files exceeding S3's 5 GiB limit for a single PUT fail with `UPLOAD_TOO_LARGE` (multipart upload is not yet implemented). Added `tests/object-storage-stream.test.ts` with digest equivalence, streamed payload verification, failure and oversized-file cases.

Last functional branch commit before docs update: `8c84a31d824ef3d2e52d4c68525200062fef6c19`. Resolve actual branch HEAD after the docs commit. This task has NOT yet passed CI or been deployed. Do not claim memory-safe uploads in production until a matching non-skipped rollout and health checks pass.

## Files modified in this session

`src/workers/object-storage.ts`, `tests/object-storage-stream.test.ts`, `WORKLOG.md`, `docs/AGENT_HANDOFF.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, `docs/DECISIONS.md`, `docs/reservation-system/monitoring.md`.

## Checks actually executed

GitHub API: read all agent continuity documents, main ref, latest CI/deploy summaries and **job log** #38855160513, open PR titles and issue #25, important backup/storage source, test and workflow files. Used GitHub Git tree/commit/ref writes to a new branch. **No local `npm ci`, production database copy, live S3 operation, stripe charge or real SMS authentication was performed.** Next technical validation is GitHub PR CI (TypeScript/build/Prisma/Vitest/security/container), then main CI and non-skipped VPS rollout.

## Known problems, access and security

[Issue #25](https://github.com/takatakca/r2neet/issues/25) remains open: missing protected S3 destination and real restore, alert webhook/delivery, Stripe signed webhook/card policy, Twilio Voice/SMS and phone OTP, Maps/dispatch origin, end-to-end customer/staff acceptance. A real provider account/secure keys are necessary to validate operations; no new billable account or secret has been created. `takatakca/takatak-v1#175` receiver is still unproven; keep TAKATAK sync disabled and tenant boundaries intact. Historical docs PR #17 remains open and outdated. Provider secrets must never appear in GitHub comments/logs/docs.

## Exact next action

1. Open a PR for `chatgpt/s3-stream-upload-20261016`; watch CI, correct TypeScript/Vitest failures on the branch. If CI green and PR mergeable, squash merge to `main`.
2. Verify the resulting main SHA CI, non-skipped Contabo Deploy, and exact `Deploy verified for commit <sha>`, `/healthz`, `/readyz`. Do not mistake a skipped release for a deployment.
3. Update all five continuity files / WORKLOG with actual verified SHA, or move to an independent code task if the provider-dependent P0 acceptance remains blocked. Avoid documentation-only chains if they would cause unnecessary image rollouts.
