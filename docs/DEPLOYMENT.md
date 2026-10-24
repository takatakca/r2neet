## Note de livraison signée — 2026-10-24

La consolidation présente publie uniquement des notes techniques dans la branche de PR 43. Elle ne déploie pas le site et ne modifie ni la base de production ni son stockage. Le code fonctionnel `effa46d6f6df1b5f043f11ce319d05d07cfcde83` est couvert par la CI 40079381092 réussie. La migration `20261024090000_add_customer_contacts` et l’import privé restent à exécuter lors d’une livraison autorisée et techniquement accessible.

Le dernier déploiement complet inspecté, 38952711773, a échoué ENOSPC. Un correctif de fichiers de connexion ne vaut pas nouvelle image complète. Revoir le serveur avant toute relance, puis consigner le run réellement exécuté et ses sondes. Voir [les preuves et fichiers](dossier-client-r2nette/02-preuves-et-fichiers.md). Le transfert de documents vers OneDrive est lui aussi en attente d’accès.

Note signée : **Codex — assistant OpenAI**. Date : **2026-10-24**, America/New_York.

---

## Private site customer database — 2026-10-24

Continued PR #43 on `feat/customer-source-inventory-20261022`. Adds owner-only `/admin#customers`, persistent historical contacts/source evidence, existing-account view, search/pagination, editable name/classification and idempotent bounded import. Migration `20261024090000_add_customer_contacts` is NEW and NOT applied to production. The private inventory validates as 105 contacts / 345 source references / six batches. No real contact data is in Git. No account verification, marketing grant, external send or identity merge is performed by importing it.

Local: eight contact-input/HTTP tests passed, six extraction tests and eight existing marketing HTTP tests passed; frontend build passed. Database tests must run in CI with generated Prisma types and a disposable Postgres database. See `docs/customer-database.md`. Next: final branch CI, recover/verify production storage, deploy migration/image, then import the private file and smoke-test the owner-only directory. None of these production steps has occurred in this session.

## Deployment check — 2026-10-22

Read Actions run #38952711773 and job #117147818213: the image built/pushed, but the VPS roll failed repeatedly with ENOSPC after scoped image cleanup removed 0 old tags. PR #39 is merged; it did not establish recovery. Run #39255689426 successfully copied login assets into the existing container only. Current customer-growth changes must pass PR CI and wait for actual disk recovery, then require non-skipped exact-SHA Deploy and health checks. No production change was executed in this inventory session.

# R2NETTE — Verified production and deployment runbook

Snapshot: **2026-10-16**. Canonical instructions: [Contabo runbook](deployment/contabo-runbook.md) and [disaster recovery](reservation-system/disaster-recovery.md).

## P0 deploy failure / recovery path

Deploy #38950594071 for SHA `7d03a38522d82a45760aeb69e584d468128fad52` FAILED on Contabo ENOSPC (containerd overlayfs layer extraction). Repeated image pull did not resolve the issue. Do not delete PostgreSQL or Coolify volumes, and do not use global `docker system prune --volumes`. Hotfix PR #39 runs conservative R2NETTE-only old image cleanup BEFORE pull, keeping current and previous images, and other sites untouched. CI and successful actual rollout must be proven; if cleanup cannot free enough space, stop blind retries and request authorized operator storage inspection. Last verified SHA is `1a8de4abe8bf24dc0e5742070590d1fd974efe9b`, Deploy #38855160513.

## Last verified Contabo release

- Actual deployed immutable image SHA: `56cde1b6ddd98be1cb146c9d33fff3d91ca6d51d`.
- [Main CI #38854383066](https://github.com/takatakca/r2neet/actions/runs/38854383066): completed SUCCESS.
- [Deploy #38854525800](https://github.com/takatakca/r2neet/actions/runs/38854525800): **non-skipped VPS roll** succeeded, with `/healthz ok`, `/readyz ok` and `Deploy verified for commit 56cde1b6ddd98be1cb146c9d33fff3d91ca6d51d`.
- Previous proven code rollouts: [PR #34 release #38853464615](https://github.com/takatakca/r2neet/actions/runs/38853464615) `02b0653c`; [PR #35 release #38853994829](https://github.com/takatakca/r2neet/actions/runs/38853994829) `46fa61d3`; PR #36 is included in latest image.
- **Documentation-only closure pushes after this snapshot require a separate main CI and non-skipped Deploy check before calling the new SHA deployed.** Source commit and currently running image need not share SHA while CI/roll is in flight.

## Real environment and release rules

GitHub `main` triggers CI and then SHA-tagged Docker Compose Deploy on the Contabo VPS under `/opt/r2nette`, with an existing Coolify reverse proxy. MochaHost handles DNS and email, not the application. No Docker image `:latest` and no server-side Node builds on MochaHost. The deploy guard checks the current main SHA to skip obsolete queued rolls.

1. Read `AGENTS.md`, `WORKLOG.md`, five continuity files, open PRs/issues, and actual main SHA before changes.
2. Make a reviewable branch and run GitHub CI: migrations from scratch, TypeScript, Vitest/invariants, container build/start and security safeguards.
3. Merge only green PR. Confirm matching main CI and exact-SHA Deploy log, **including** an executed `Roll the VPS to that image` step, `/healthz ok`, `/readyz ok`, and `Deploy verified for commit <sha>`. A green skipped deployment is not a release.
4. Verify public TLS, actual operation/worker evidence and customer smoke before declaring business acceptance. Track previous known-good SHA for rollback; read the runbook before destructive or recovery commands.

## Latest verified handoff closure

The docs closure commit `1a8de4abe8bf24dc0e5742070590d1fd974efe9b` also passed [CI #38855018334](https://github.com/takatakca/r2neet/actions/runs/38855018334) and **non-skipped** [Deploy #38855160513](https://github.com/takatakca/r2neet/actions/runs/38855160513), including `/healthz ok`, `/readyz ok` and exact SHA log. This is the latest proven running image before the streaming-upload PR.

Pending branch `chatgpt/s3-stream-upload-20261016`: two-pass streaming SHA-256 + signed S3 PUT removes full dump allocation and guards >5 GiB single PUT requests. PR CI, merge and non-skipped VPS roll are still required; never call provider backups operational based only on unit tests.

## Known missing production configuration

The newest deploy still warns: Stripe cards and signed webhook, Twilio Voice/SMS, Maps, dispatch origin, off-host S3 backup and alert webhook have no protected production configuration. Source code defaults to safe degraded behavior. Real S3 restore and alert receipt NOT verified. Real Stripe payment, OTP, authenticated customer/crew workflows NOT verified. Issue [#25](https://github.com/takatakca/r2neet/issues/25) owns acceptance. Keep TAKATAK event synchronization **disabled** while receiver PR #175 remains unverified. Protected secrets must not enter source, logs, or chat.

## Disaster recovery

A local PostgreSQL dump is not off-host disaster recovery. Schedule off-host upload, check remote size and streamed SHA-256, then restore to scratch DB and validate booking data, operator MFA and matching `FIELD_ENCRYPTION_KEY`. Preserve retired keys during rotation. Run controlled alert delivery and inspect worker-run records. Do not claim the synthetic CI restore drill proves a production off-host restore. Rollback scripts are described in `docs/deployment/contabo-runbook.md` and `scripts/deploy/`.
