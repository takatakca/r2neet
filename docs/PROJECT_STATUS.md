# R2NETTE — Project status

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

The TAKATAK central identity receiver [PR #175](https://github.com/takatakca/takatak-v1/pull/175) is present in `takatak-v1` `main` (`574766b7`, 2026-10-16) but its production deployment and secrets are unverified; keep `TAKATAK_R2NETTE_SYNC_ENABLED=false` until deployed HMAC/tenant testing passes. R2NETTE keeps independent UI and tenant boundaries.

**Customer phone login (2026-10-17, branch `claude/hopeful-clarke-xvwac3`, not yet merged):** the login page rejected an eleven-digit typo with "needs 10 digits" and offered no formatting; the branch formats and validates ten national digits before any request, adds a live probe of the shared TAKATAK Supabase project (phone sign-in enabled, SMS provider, auto-confirm) to `/admin#integrations`, and logs the GoTrue error code when an SMS is refused. OTP delivery itself depends on the Phone provider and Twilio being enabled on the TAKATAK Supabase project (takatak-v1 #141), which R2NETTE cannot configure; a real handset test is still required before "phone login works" may be claimed.

## Canonical next step

Provision provider credentials **only through protected production environment** (no secrets in GitHub source, issues or chat), verify an actual off-host backup and restored PostgreSQL/MFA data in a scratch environment, confirm alert receipt, then Stripe signed webhook and genuine customer/crew/payment flows. See `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DEPLOYMENT.md` and `docs/DECISIONS.md`.
