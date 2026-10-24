## Private site customer database — 2026-10-24

Continued PR #43 on `feat/customer-source-inventory-20261022`. Adds owner-only `/admin#customers`, persistent historical contacts/source evidence, existing-account view, search/pagination, editable name/classification and idempotent bounded import. Migration `20261024090000_add_customer_contacts` is NEW and NOT applied to production. The private inventory validates as 105 contacts / 345 source references / six batches. No real contact data is in Git. No account verification, marketing grant, external send or identity merge is performed by importing it.

Local: eight contact-input/HTTP tests passed, six extraction tests and eight existing marketing HTTP tests passed; frontend build passed. Database tests must run in CI with generated Prisma types and a disposable Postgres database. See `docs/customer-database.md`. Next: final branch CI, recover/verify production storage, deploy migration/image, then import the private file and smoke-test the owner-only directory. None of these production steps has occurred in this session.

## Customer inventory and marketing preferences — 2026-10-22

PR [#43](https://github.com/takatakca/r2neet/pull/43), branch `feat/customer-source-inventory-20261022`, adds a private Gmail JSON-to-CSV inventory tool and a bilingual account marketing-preference editor using existing Customer fields. No schema migration, external marketing send, production import or new verification claim. The tool records correspondence evidence; it does not treat all correspondents as customers or as opted-in subscribers. Raw Gmail/CSV and customer data stay OUTSIDE this public repository.

Executed: 6 Python inventory tests, 8 HTTP boundary tests with a mocked persistence adapter, and Vite production build passed locally. Prisma client generation is blocked by the execution network returning HTTP 403 for binaries.prisma.sh; full TypeScript verification therefore lacks generated model types and must run in GitHub CI. The HTTP tests do not prove real database persistence or live TAKATAK synchronization.

Deployment evidence refreshed: PR #39 is already merged, but Deploy #38952711773 failed on Contabo `no space left on device` even after the scoped cleanup removed 0 tags. Main is `38fc9aac856ca902ac09616c1fb55d6b5fa4109d`; manual login asset hotfix #39255689426 succeeded, which does not prove a full immutable-image rollout. No server credentials or operational identity are attached to this execution environment. Do not retry image pulls blindly. Next: PR CI, authorized server disk inspection/recovery, then non-skipped exact-SHA rollout and authenticated preferences smoke.

# R2NETTE — Agent handoff

Updated 2026-10-19. On restart read `AGENTS.md`, `WORKLOG.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, and `docs/DECISIONS.md` and check GitHub open PRs before new work.

## Login OTP — 2026-10-19

The Google phone-link page rejected an 11-digit entry with `PHONE_INVALID_LENGTH` before TAKATAK/Twilio was called. A separate live check showed a 10-digit Canadian number is accepted by `POST /api/v1/auth/phone/send` and a wrong code is denied. Branch `fix/phone-otp-entry-20261019` ([PR #41](https://github.com/takatakca/r2neet/pull/41)) tells the customer that no code was sent and why, and keeps the Google-link button labeled “Send verification code” after the error. Do not send OTP codes to company servers. TAKATAK sync stays disabled until receiver PR takatakca/takatak-v1#175 is approved. Disk P0 below still blocks a production roll of this fix.

## CURRENT P0 — disk exhaustion, hotfix PR #39

Last verified production: `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`, non-skipped Deploy #38855160513 with `/healthz ok`, `/readyz ok` and exact SHA. PR #37 merged streamed S3 PUT at `7d03a38522d82a45760aeb69e584d468128fad52` and main CI #38950346352 passed, but Deploy #38950594071 FAILED extracting a containerd image layer with `No space left on device`. Do NOT assert PR #37 deployed. PR #38 PGDMP archive validation passed PR CI #38950701808 but should remain OPEN until recovery.

Current branch `chatgpt/contabo-disk-recovery-20261016` and PR #39 modifies `scripts/deploy/remote-deploy.sh`, adds `scripts/deploy/pre-pull-cleanup.sh` and `tests/pre-pull-cleanup.test.ts`. Cleanup runs before pull and after successful promotion; it only deletes old R2NETTE SHA image tags, protecting current/previous/target and other applications/volumes. Last functional branch commit before docs: `cfce52ac848d1bb8e69c61b8962526280a48a7fe`. Actual branch HEAD must be checked after docs commit; CI, merge and production recovery not yet verified. No local SSH, df, Docker prune or actual VPS modifications performed here — reviewed GitHub Actions job log of failed Deploy #38950594071 and source/runbooks. Next exact action: require green PR #39 CI, fix failures, merge; verify non-skipped main deploy and exact SHA/health. If still ENOSPC, no blind retries: authorized server operator must inspect disk and approve any broader selective cleanup. After recovery, merge CI-green PR #38, verify deployment and reconcile docs. Provider issue #25 and TAKATAK receiver gate remain unresolved.

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
