# R2NETTE — Project status

Verified snapshot: **2026-10-15**. Repo `takatakca/r2neet` branch `main`; latest merged functional SHA `a46849b5e29619a7ee8fd14469e2a98d70b6b28c`, main CI #38777285346 passed. Last **verified non-skipped production** SHA: `6a7f192e0ffb46deecde97a6e836ba88fc59e93a` ([Deploy #38776842943](https://github.com/takatakca/r2neet/actions/runs/38776842943), probes healthy). [Deploy #38777515485](https://github.com/takatakca/r2neet/actions/runs/38777515485) for a46849b5 requires separate verification. This project is **not yet 100% production-accepted**.

## Completed new code (GitHub-verified)

- PR #27: browser storage now excludes saved street address, address identifiers, contact information and held slots; sanitizes historical drafts and refuses to resurrect confirmed bookings.
- PR #28: safe structured API errors for HTML proxy failures/corrupt JSON; preserves valid pricing/reprice errors. Deployed in `ce8eb68d` (Deploy #38776393992).
- PR #29: bounded npm install retry on transient Docker registry errors, without masking broken dependency installs. Deployed in `6a7f192e` (Deploy #38776842943).
- PR #30: rate-limit client IP is derived from Express's immediate trusted proxy, not untrusted raw X-Forwarded-For; spoofed-prefix regression tests. Merged `a46849b5`, CI green, deploy requires verification.

## Verified existing platform

- RFC 5545 calendar exports now fold Unicode content lines at 75 UTF-8 octets; [PR #26](https://github.com/takatakca/r2neet/pull/26) passed its CI and merged to `main`.
- Customer booking flow, account portal, staff roles/admin/crew, backend pricing engine and quotes, PostgreSQL/Prisma, slot holds and scheduling, recurring visits, payment and notification integrations in code.
- Deployment uses GitHub Actions `CI` → `Deploy`, immutable SHA-tagged image, Docker Compose on Contabo at `/opt/r2nette`, health/readiness checks and rollback. The VPS uses the existing Coolify proxy when present.
- **Verified current production baseline:** `6a7f192e0ffb46deecde97a6e836ba88fc59e93a`, [CI #38776617739](https://github.com/takatakca/r2neet/actions/runs/38776617739) and [Deploy #38776842943](https://github.com/takatakca/r2neet/actions/runs/38776842943) confirmed exact SHA, liveness and readiness.
- The domain/web DNS and email configuration remain administered through MochaHost; the actual app runs on Contabo. The deploy evidence does **not** prove each customer flow, provider, or external integration is enabled.

## Known production gaps

The verified deploy log warned of missing configuration for **Stripe** card payments, **Twilio Voice/SMS**, **Google Maps**, business dispatch origin coordinates, **off-host S3 backups**, and **alert webhooks**. Phone/Google sign-in and all workflows still require controlled end-to-end confirmation. See [issue #25](https://github.com/takatakca/r2neet/issues/25).

R2NETTE's TAKATAK event outbox and signed sender exist, but syncing must stay **disabled** until the receiver [TAKATAK PR #175](https://github.com/takatakca/takatak-v1/pull/175) is green, approved, merged, deployed and independently verified. This PR was still open on 2026-10-15. Never use a cross-tenant shortcut.

## Risks and acceptance

- Missing verified off-host restore and alert routing means the project cannot be classified operationally complete.
- Live billing must never be enabled with incomplete Stripe webhook configuration; no fabricated pricing or simulated successful charges.
- Completion requires valid provider credentials in approved secret stores, worker health, signature handling, real customer and staff flows, recovery drill and evidence of the deployed SHA.

## Canonical references

`AGENTS.md`, `WORKLOG.md`, `RUN.md`, `BRAND.md`, `docs/TAKATAK_INTEGRATION.md`, `docs/reservation-system/`, and `docs/deployment/contabo-runbook.md`. See also `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DECISIONS.md` and `docs/DEPLOYMENT.md`.

