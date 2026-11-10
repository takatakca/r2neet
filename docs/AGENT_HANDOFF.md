# R2NETTE — Agent handoff

## 2026-11-10 16:30 UTC — Claude (Anthropic) : zéro PR ouverte, drill réparé

Sur ordre du propriétaire (« no pull request, no code issue ») :

- **Fusionnées** : #54 (3151da8, drill : binaires PostgreSQL 16 en tête du PATH, le runner Ubuntu 26 prenait pg_dump 18.6) ; #38 (0ca0861, contrôle PGDMP + taille minimale avant envoi/rétention ; les deux sauvegardes sont bien en `--format=custom`) ; #50 (1e70eb5, après fusion de main et correction du cast TS2352 dans `tests/pg-cli.test.ts` ; vitest 786/786 en local sur PostgreSQL 16 UTC).
- **Fermées sans fusion** : #43 CRM (le propriétaire préfère éviter la migration et l’import ; branche conservée, réouvrable), #45 et #17 (notes périmées ; tâches propriétaire de #45 reportées dans la note Drive du jour). **Issue #40 fermée** : disque 79 % (21 Go libres) au Deploy 42847318418.
- **Issues #25 et #48 fermées** sur ordre du propriétaire (« all resolved ») sans que le travail soit fait : les réglages de #25 (Stripe, Twilio, Google Maps + BUSINESS_ORIGIN_LAT/LNG, sauvegardes S3, webhook d’alerte, parcours réel, synchro TAKATAK désactivée) sont repris dans la note Drive du 2026-11-10 ; la mission #48 reste dans le Drive (SPEC A–Z Rapide 2 Nette, signée Taktak).
- **Preuves en production après #50** (Deploy 42854808932) : `/api/v1/integrations/status` public → 404 ; JSON invalide → 400 VALIDATION_ERROR ; `/.env` → 404 « Not found. » ; cookies de déconnexion `HttpOnly; Secure; SameSite=Lax` ; `/`, `/book`, `/login`, `/signup`, `/account`, `/admin`, `/healthz`, `/readyz` → 200 ; bouton TAKATAK visible, clic → takatak.ca/login ; les 24 actions admin et 4 actions crew sont sur `window`. Restore drill 42855338061 sur 1e70eb5 : 11/11 PASS.
- **Reste** : branches fusionnées à supprimer à la main (le proxy refuse la suppression) ; vrai parcours TAKATAK (compte neuf + existant) ; connexion courriel toujours désactivée.

## 2026-11-10 — Claude (Anthropic) : ménage du dépôt

Supprimés sur accord du propriétaire (branche `claude/remove-unused-files`) : `dist/` et `dist-single/` (anciennes sorties Vite, reconstruites par la CI et l’image Docker, désormais dans `.gitignore`), `qa.ts` (script ponctuel du 2026-09-12, remplacé par `tests/`), `booking.html` et `web/prototype-reference.html` (prototypes non construits ni servis), `.agent/CONTINUATION.md` (remplacé par ce fichier). Conservés à la demande du propriétaire : workflows « Install login phone format » et « DNS (MochaHost) ».

## 2026-11-10 — Claude (Anthropic) : bouton TAKATAK masqué en production — résolu

Résolu : PR #52 fusionnée (f3eb9a7), Server setup 42844540901 a copié `TAKATAK_OAUTH_CLIENT_ID`, Deploy 42844918942 ; `configured:true`, bouton visible, le clic mène à takatak.ca/login. Reste : vrai parcours avec un compte TAKATAK neuf et un compte existant.

PR #51 (b032c91) est en production, mais `/api/v1/auth/takatak/config` répond `{"configured":false}` : le bouton reste masqué et `/login` affiche « Sign-in is unavailable ». Cause : le téléversement web de #51 a perdu `.github/` et `.env.example` (16 fichiers au lieu de 18). `server-setup.yml` ne passait donc pas `TAKATAK_OAUTH_CLIENT_ID` à `ci-server-setup.sh`, et Server setup 42840801557 n’a copié que `TAKATAK_SUPABASE_URL TAKATAK_SUPABASE_ANON_KEY`. Correctif : branche `claude/server-setup-takatak-client-id` (accepte un secret ou une variable d’environnement). Reste : CI, fusion, Server setup (le journal doit lister `TAKATAK_OAUTH_CLIENT_ID`), Deploy, puis vérifier `configured:true` et un vrai parcours.

## 2026-11-10 — Claude (Anthropic) : « Continuer avec TAKATAK » (branche, non déployé)

Branche `claude/r2nette-takatak-sso` depuis `main` 73a17e2. TAKATAK devient le compte maître : `/login` et `/signup` envoient le client sur TAKATAK (OAuth 2.1 + PKCE, client public), puis R2NETTE crée ou retrouve sa copie du client et ouvre la session. Liaison d’un ancien compte depuis `/account`. Flux et règles : `docs/TAKATAK_INTEGRATION.md`, décision 19.

Preuves locales : `tsc` OK ; `vitest` 781/781 avec PostgreSQL 16 en UTC (dont `tests/takatak-oauth.test.ts` 15 et `tests/takatak-oauth-db.test.ts` 2) ; invariants 34/34 ; `vite build` OK ; contrôle Chromium 390 px et 1280 px sans erreur ni débordement. Aucune CI GitHub : la session n’avait pas le droit de pousser vers `takatakca/r2neet`.

Fait le 2026-11-10 sur ordre du propriétaire : client OAuth « R2NETTE » créé dans Supabase TAKATAK (id public `8e551e10-b1e1-4cf5-8af9-72fc791b9086`, réponse 302 vers takatak.ca/oauth/consent vérifiée) et variable `TAKATAK_OAUTH_CLIENT_ID` posée dans l’environnement GitHub `production`. Reste : 3) PR, CI, Server setup, Deploy ; 4) vrai parcours avec un compte TAKATAK neuf et un compte existant. Note : `R2NETTE_EMAIL_AUTH_ENABLED` n’est pas copié par Server setup (absent de la liste `settings`), donc le formulaire courriel reste désactivé en production tant qu’il n’est pas posé à la main. Paiement : clés Stripe R2NETTE et Google Maps toujours manquantes en production.

## 2026-10-29 — Codex — assistant OpenAI : parcours premium (branche, non déployé)

PR **46** `feat/email-first-premium-20261029` : connexion courriel avec preuve distincte du téléphone, SMS après paiement positif serveur, dialogue de réservation, paiement scoped/confirmation webhook, commercial avec file opérateur, consentement facultatif, calendrier client et GPS. Audit et blocages : [rapport de reprise](experience/2026-10-29-premium-audit.md). Ne pas confondre la branche et la production ni déclarer photos/signatures/transfert/forfaits/IA tous livrés.

Validation initiale : CI 40843380976 sur 5bb6460, 764 tests passés, migration PostgreSQL et conteneur vérifiés. Audit Chromium simulé mobile/ordinateur, consentement/retrait et corrections de facture documentés dans le rapport ; vérifier la CI du suivi final avant release.

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

## CURRENT P0 — disk exhaustion unresolved; PR #38 prepared but NOT deployed

Last verified production: `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`, non-skipped Deploy #38855160513 with `/healthz ok`, `/readyz ok` and exact SHA. PR #37 merged streamed S3 PUT at `7d03a38522d82a45760aeb69e584d468128fad52` and main CI #38950346352 passed, but Deploy #38950594071 FAILED extracting a containerd image layer with `No space left on device`. Do NOT assert PR #37 deployed. PR #38 PGDMP archive validation passed PR CI #38950701808 but should remain OPEN until recovery.

Current branch `chatgpt/contabo-disk-recovery-20261016` and PR #39 modifies `scripts/deploy/remote-deploy.sh`, adds `scripts/deploy/pre-pull-cleanup.sh` and `tests/pre-pull-cleanup.test.ts`. Cleanup runs before pull and after successful promotion; it only deletes old R2NETTE SHA image tags, protecting current/previous/target and other applications/volumes. Last functional branch commit before docs: `cfce52ac848d1bb8e69c61b8962526280a48a7fe`. Actual branch HEAD must be checked after docs commit; CI, merge and production recovery not yet verified. No local SSH, df, Docker prune or actual VPS modifications performed here — reviewed GitHub Actions job log of failed Deploy #38950594071 and source/runbooks. Next exact action: require green PR #39 CI, fix failures, merge; verify non-skipped main deploy and exact SHA/health. If still ENOSPC, no blind retries: authorized server operator must inspect disk and approve any broader selective cleanup. After recovery, merge CI-green PR #38, verify deployment and reconcile docs. Provider issue #25 and TAKATAK receiver gate remain unresolved.

Update on 2026-10-16: PR #39 code was merged as deb7dd2680e1e0f8ae8a59e6a99d7c2576936c52, main CI #38952475969 passed, but Deploy #38952711773 FAILED on ENOSPC. Scoped cleanup removed 0 old R2NETTE tags; `/dev/sda1` 96G/96G, ~550M free. [Issue #40](https://github.com/takatakca/r2neet/issues/40) holds verified incident evidence and read-only operator diagnostic commands. PR #38 now uses the latest main content in its tree and preserves every hotfix; its functional files are scripts/backup.ts, scripts/loop-backup.ts, scripts/backup-validation.ts, tests/backup-validation.test.ts and the disaster-recovery guide. PR #38 remains UNMERGED; do not trigger another doomed image pull before disk recovery. No SSH or privileged server cleanup executed directly by this agent. Next action: authorized disk audit, restore several GB of available disk safely, then verify new deployment of latest main; only then merge PR #38 and verify exact SHA and both probes.

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
