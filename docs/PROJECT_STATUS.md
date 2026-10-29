# R2NETTE — Project status

## 2026-10-29 — Codex — assistant OpenAI : parcours premium (branche, non déployé)

PR **46** `feat/email-first-premium-20261029` : connexion courriel avec preuve distincte du téléphone, SMS après paiement positif serveur, dialogue de réservation, paiement scoped/confirmation webhook, commercial avec file opérateur, consentement facultatif, calendrier client et GPS. Audit et blocages : [rapport de reprise](experience/2026-10-29-premium-audit.md). Ne pas confondre la branche et la production ni déclarer photos/signatures/transfert/forfaits/IA tous livrés.

Validation initiale : CI 40843380976 sur 5bb6460, 764 tests passés, migration PostgreSQL et conteneur vérifiés. Audit Chromium simulé mobile/ordinateur, consentement/retrait et corrections de facture documentés dans le rapport ; vérifier la CI du suivi final avant release.

Dernière production revérifiée : `74434524f6b8f9348240be9e13d158d0060566c5`, Deploy 40450497185, job 122011814392, Roll exécuté, probes OK, SHA exact. Le log du 27 octobre signalait encore les fournisseurs non configurés. Nouvelle inscription à activer uniquement après preuve SMTP/Supabase et opt-in protégé ; CI complète et réel parcours requis avant release. PR43 CRM reste distincte. Dépôt non renommé (administration indisponible).


**Verified 2026-10-16** — `takatakca/r2neet`, release branch `main`. The application is running, **but the project is not 100% production-accepted**.

## P0 incident — Contabo disk full

PR #37 (`7d03a38522d82a45760aeb69e584d468128fad52`) passed main CI #38950346352, but Deploy #38950594071 FAILED: no space left on device while extracting a containerd image layer. The most recent verified deployed image remains `1a8de4abe8bf24dc0e5742070590d1fd974efe9b` (CI #38855018334, Deploy #38855160513, probes OK). PR #39 contains targeted pre-pull recovery: remove only obsolete R2NETTE immutable image tags while protecting current, rollback and target, other tenants and volumes. PR #38 PGDMP validation passed PR CI but remains open until disk recovery. Do not report the unverified SHA as live.

## Last verified production

- Exact deployed SHA: `56cde1b6ddd98be1cb146c9d33fff3d91ca6d51d`.
- [Main CI #38854383066](https://github.com/takatakca/r2neet/actions/runs/38854383066): passed (typecheck/build, tests, safety and container).
- [Non-skipped Contabo Deploy #38854525800](https://github.com/takatakca/r2neet/actions/runs/38854525800): actual VPS roll, `/healthz ok`, `/readyz ok`, `Deploy verified for commit 56cde1b6ddd98be1cb146c9d33fff3d91ca6d51d`. This is the last verified live image until a newer matching release proves otherwise.
- Runtime: Docker Compose at `/opt/r2nette` on Contabo, reverse-proxied by existing Coolify infrastructure; MochaHost retains DNS and email. No fresh functional customer browser smoke was run this session.

## Verified code changes this session

- [PR #34](https://github.com/takatakca/r2neet/pull/34): signed streamed S3 GET verifies actual SHA-256/size against the dump, rejecting equal-length corruption, truncated objects and failed GET. Initial CI failed on a historical HEAD-only test fixture; corrected, PR CI #38853224241 and main CI #38853348818 passed. **[Deploy #38853464615](https://github.com/takatakca/r2neet/actions/runs/38853464615)** verified merge SHA `02b0653cfc33b6472879f7ac38268b3aa4efedb2`.
- [PR #35](https://github.com/takatakca/r2neet/pull/35): local backup retention after successful fresh pg_dump but before S3 failures, with validated 1–365-day setting, no symlink or unrelated-file deletion. PR CI #38853550724, main CI #38853881854 passed; **[Deploy #38853994829](https://github.com/takatakca/r2neet/actions/runs/38853994829)** verified `46fa61d32d1ff8b973d2910f597c5cacd992948a`.
- [PR #36](https://github.com/takatakca/r2neet/pull/36): alert webhooks have a bounded 10-second deadline; hung receivers cannot block failure reporting indefinitely. PR CI #38854212430 and main CI #38854383066 passed; **Deploy #38854525800** verified `56cde1b6`.
- Earlier: PR #26 Unicode-safe ICS; #27 private draft storage; #28 HTTP error hardening; #29 Docker npm recovery; #30 rate-limiter trusted proxy; #32 backup fail-closed and once/day attempts; #33 pg_dump argv password protection. Preserve all prior work.

## Current branch (NOT deployed)

`chatgpt/s3-stream-upload-20261016` replaces the in-memory `readFileSync` backup upload with SHA-256 hashing in a bounded read stream followed by a signed stream PUT; files above the S3 5 GiB single-operation limit fail safely. New `tests/object-storage-stream.test.ts` covers request signature equivalence, streamed bytes, upload errors, and oversized file rejection. This is pending PR CI, merge, and release verification. No real off-host destination has been configured by the change.

The last verified main release is **`1a8de4abe8bf24dc0e5742070590d1fd974efe9b`**, supported by [CI #38855018334](https://github.com/takatakca/r2neet/actions/runs/38855018334) and [non-skipped Deploy #38855160513](https://github.com/takatakca/r2neet/actions/runs/38855160513) with both health probes and exact SHA proof.

## Operational blockers — no false successes

[Issue #25](https://github.com/takatakca/r2neet/issues/25) remains open. Latest deployment still explicitly warns that Stripe live keys and signed webhook, Twilio Voice/SMS, Google Maps, dispatch origin, S3 off-host storage, and signed alert webhook are NOT configured. Phone/Google login, real card payments, off-host restore with matching encryption key, worker receipt monitoring, alert delivery and full customer/staff booking acceptance remain unproven. Integrations present in code are not evidence of activation.

The TAKATAK central identity receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) was open at last check; keep `TAKATAK_R2NETTE_SYNC_ENABLED=false` until deployed HMAC/tenant testing passes. R2NETTE keeps independent UI and tenant boundaries.

## Canonical next step

Provision provider credentials **only through protected production environment** (no secrets in GitHub source, issues or chat), verify an actual off-host backup and restored PostgreSQL/MFA data in a scratch environment, confirm alert receipt, then Stripe signed webhook and genuine customer/crew/payment flows. See `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md` and `docs/DECISIONS.md`.
