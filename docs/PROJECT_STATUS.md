# R2NETTE — Project status

Verified snapshot: **2026-10-15**. GitHub verified that `152ddf16016038339af1d265f6c8d29b1960a19a` passed CI #38613223891 and production Deploy #38614841577 on 2026-10-14; both `/healthz` and `/readyz` were verified. Latest verified *code merge* SHA: `39e10d165357c3882ed16f9e59b8ded986411719` (PR #26, CI green); matching deployment for the earlier release is verified. Repository: `takatakca/r2neet`; default publication branch: `main`. **This is not a 100%-complete production acceptance.**

## Verified existing platform

- RFC 5545 calendar exports now fold Unicode content lines at 75 UTF-8 octets; [PR #26](https://github.com/takatakca/r2neet/pull/26) passed its CI and merged to `main`.
- Customer booking flow, account portal, staff roles/admin/crew, backend pricing engine and quotes, PostgreSQL/Prisma, slot holds and scheduling, recurring visits, payment and notification integrations in code.
- Deployment uses GitHub Actions `CI` → `Deploy`, immutable SHA-tagged image, Docker Compose on Contabo at `/opt/r2nette`, health/readiness checks and rollback. The VPS uses the existing Coolify proxy when present.
- **Latest verified production release:** `152ddf16016038339af1d265f6c8d29b1960a19a`, [CI #38613223891](https://github.com/takatakca/r2neet/actions/runs/38613223891), [Deploy #38614841577](https://github.com/takatakca/r2neet/actions/runs/38614841577) confirmed `/healthz ok`, `/readyz ok` and the exact SHA.
- The domain/web DNS and email configuration remain administered through MochaHost; the actual app runs on Contabo. The deploy evidence does **not** prove each customer flow, provider, or external integration is enabled.

## Latest independent code changes

PR #27 has removed address identifiers and street-address summaries from persisted browser drafts and prevents stale booking/confirmation state from being restored. The current follow-up branch hardens malformed API responses. These changes need their own exact-SHA production rollout checks.

## Latest delivery blocker

Deploy [#38775849037](https://github.com/takatakca/r2neet/actions/runs/38775849037) for PR #27's merged SHA `c7a47233` failed at Docker `RUN npm ci` because the npm registry connection reset (`ECONNRESET`), not because the application tests failed. A bounded Docker dependency-fetch retry is now being developed. After this initial failure, the successful non-skipped [Deploy #38776393992](https://github.com/takatakca/r2neet/actions/runs/38776393992) released `ce8eb68dbb49d67fd9c7949c700fd25261d66380` and passed both probes. Newer Docker retry PR #29 is merged but its release needs separate verification.

## Proxy identity and rate limiting

The active hardening work replaces use of the untrusted leftmost `X-Forwarded-For` value as a limiter key with Express's trusted one-hop `req.ip` (or socket fallback). Tests must prove that forged forwarded prefixes cannot bypass SMS rate limits.

## Known production gaps

The verified deploy log warned of missing configuration for **Stripe** card payments, **Twilio Voice/SMS**, **Google Maps**, business dispatch origin coordinates, **off-host S3 backups**, and **alert webhooks**. Phone/Google sign-in and all workflows still require controlled end-to-end confirmation. See [issue #25](https://github.com/takatakca/r2neet/issues/25).

R2NETTE's TAKATAK event outbox and signed sender exist, but syncing must stay **disabled** until the receiver [TAKATAK PR #175](https://github.com/takatakca/takatak-v1/pull/175) is green, approved, merged, deployed and independently verified. This PR was still open on 2026-10-15. Never use a cross-tenant shortcut.

## Risks and acceptance

- Missing verified off-host restore and alert routing means the project cannot be classified operationally complete.
- Live billing must never be enabled with incomplete Stripe webhook configuration; no fabricated pricing or simulated successful charges.
- Completion requires valid provider credentials in approved secret stores, worker health, signature handling, real customer and staff flows, recovery drill and evidence of the deployed SHA.

## Canonical references

`AGENTS.md`, `WORKLOG.md`, `RUN.md`, `BRAND.md`, `docs/TAKATAK_INTEGRATION.md`, `docs/reservation-system/`, and `docs/deployment/contabo-runbook.md`. See also `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DECISIONS.md` and `docs/DEPLOYMENT.md`.

