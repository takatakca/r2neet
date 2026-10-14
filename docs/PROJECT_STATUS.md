# R2NETTE — Project status

Verified snapshot: **2026-10-14**. Latest verified *code merge* SHA: `39e10d165357c3882ed16f9e59b8ded986411719` (PR #26, CI green); release still requires a matching production deploy check. Repository: `takatakca/r2neet`; default publication branch: `main`. **This is not a 100%-complete production acceptance.**

## Verified existing platform

- RFC 5545 calendar exports now fold Unicode content lines at 75 UTF-8 octets; [PR #26](https://github.com/takatakca/r2neet/pull/26) passed its CI and merged to `main`.
- Customer booking flow, account portal, staff roles/admin/crew, backend pricing engine and quotes, PostgreSQL/Prisma, slot holds and scheduling, recurring visits, payment and notification integrations in code.
- Deployment uses GitHub Actions `CI` → `Deploy`, immutable SHA-tagged image, Docker Compose on Contabo at `/opt/r2nette`, health/readiness checks and rollback. The VPS uses the existing Coolify proxy when present.
- **Production release evidence:** `fea51644ecee9e8ed600a72915dfb72425daae66` passed [CI #38611375959](https://github.com/takatakca/r2neet/actions/runs/38611375959) and [Deploy #38611624915](https://github.com/takatakca/r2neet/actions/runs/38611624915). The latter logged `/healthz ok`, `/readyz ok`, and a verified SHA.
- The domain/web DNS and email configuration remain administered through MochaHost; the actual app runs on Contabo. The deploy evidence does **not** prove each customer flow, provider, or external integration is enabled.

## Known production gaps

The verified deploy log warned of missing configuration for **Stripe** card payments, **Twilio Voice/SMS**, **Google Maps**, business dispatch origin coordinates, **off-host S3 backups**, and **alert webhooks**. Phone/Google sign-in and all workflows still require controlled end-to-end confirmation. See [issue #25](https://github.com/takatakca/r2neet/issues/25).

R2NETTE's TAKATAK event outbox and signed sender exist, but syncing must stay **disabled** until the receiver [TAKATAK PR #175](https://github.com/takatakca/takatak-v1/pull/175) is green, approved, merged, deployed and independently verified. This PR was still open on 2026-10-14. Never use a cross-tenant shortcut.

## Risks and acceptance

- Missing verified off-host restore and alert routing means the project cannot be classified operationally complete.
- Live billing must never be enabled with incomplete Stripe webhook configuration; no fabricated pricing or simulated successful charges.
- Completion requires valid provider credentials in approved secret stores, worker health, signature handling, real customer and staff flows, recovery drill and evidence of the deployed SHA.

## Canonical references

`AGENTS.md`, `WORKLOG.md`, `RUN.md`, `BRAND.md`, `docs/TAKATAK_INTEGRATION.md`, `docs/reservation-system/`, and `docs/deployment/contabo-runbook.md`. See also `docs/TASK_QUEUE.md`, `docs/AGENT_HANDOFF.md`, `docs/DECISIONS.md` and `docs/DEPLOYMENT.md`.

