# R2NETTE — Agent handoff

## 2026-10-29 — Codex — assistant OpenAI : parcours premium (branche, non déployé)

Travail actif `feat/email-first-premium-20261029` : connexion courriel avec preuve distincte du téléphone, SMS après paiement positif serveur, dialogue de réservation, paiement scoped/confirmation webhook, commercial avec file opérateur, consentement facultatif, calendrier client et GPS. Audit et blocages : [rapport de reprise](experience/2026-10-29-premium-audit.md). Ne pas confondre la branche et la production ni déclarer photos/signatures/transfert/forfaits/IA tous livrés.

Dernière production revérifiée : `74434524f6b8f9348240be9e13d158d0060566c5`, Deploy 40450497185, job 122011814392, Roll exécuté, probes OK, SHA exact. Le log du 27 octobre signalait encore les fournisseurs non configurés. Nouvelle inscription à activer uniquement après preuve SMTP/Supabase et opt-in protégé ; CI complète et réel parcours requis avant release. PR43 CRM reste distincte. Dépôt non renommé (administration indisponible).


Updated 2026-10-19. On restart read `AGENTS.md`, `WORKLOG.md`, `docs/TASK_QUEUE.md`, `docs/PROJECT_STATUS.md`, `docs/DEPLOYMENT.md`, and `docs/DECISIONS.md` and check GitHub open PRs before new work.

## Redeploy pending — 2026-10-26 (Claude)

- **Production** still runs `1a8de4abe8bf24dc0e5742070590d1fd974efe9b` (Deploy #38855160513), plus the 2026-10-19 login hotfix copied into the running container. `https://r2nette.ca/healthz` and `/readyz` answer OK.
- **Not deployed:** `7d03a38` (#37 streamed S3 upload), `deb7dd2` (#39 pre-pull cleanup), `32181c5` and `38fc9aa` (login phone format and file mode, pushed with `[skip ci]`).
- **Why:** Deploy #38950594071 and #38952711773 failed with ENOSPC; the VPS root disk was 96 GB / 100 % on 2026-10-16. On 2026-10-26 Coolify's docker-cleanup check reports vps1 under its 80 % threshold, and other builds on vps1 succeed, so there is room again.
- **Done:** CI dispatched on `main` `38fc9aa`: run #40351215484 green (typecheck/build, tests, container start, safety invariants). That satisfies the "Require a passing CI run" step of a manual Deploy.
- **Blocked:** the agent was not allowed to start a production deploy. Owner action: merge this PR (push to `main` → CI → Deploy), or Actions › Deploy › Run workflow on `main`.
- **Then verify:** Deploy log shows `Deploy verified for commit <sha>`, `/healthz` and `/readyz` OK, the PR #39 cleanup ran before the pull, and the login page still accepts a 10-digit number.

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
