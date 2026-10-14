# R2NETTE — Recorded architectural and release decisions

Snapshot: 2026-10-14. This documents existing repository policy and decisions, not new approval to activate providers.

1. **Preserve the product:** R2NETTE remains a separate cleaning/reservation application with its own UI, branding and operational booking database. TAKATAK master identity is integrated only through approved tenant-scoped contracts; never place R2NETTE workflows inside the generic TAKATAK dashboard.
2. **Money:** The backend is the authority for service options, quote totals, GST/QST, discounts, products, frequency and payment state. Browser fields transmit user selections only. Stripe webhook receipts are validated server-side and live cards require complete provider configuration.
3. **Tenancy and personal data:** Customer and staff permissions are verified server-side, with individual staff sessions and least-privilege roles. Do not upload passwords, OTPs, card data, access/door codes or private notes into the TAKATAK bridge.
4. **TAKATAK sync:** Durable PostgreSQL outbox and signed delivery code is present in R2NETTE `main`. The remote receiver is gated by takatak-v1 PR #175 (open at snapshot). Until recipient is approved, released and signature-verified, `TAKATAK_R2NETTE_SYNC_ENABLED=false`.
5. **Publishing:** `main` CI must pass before GitHub Actions deploys SHA-tagged immutable images to Contabo. Deployer skips obsolete releases and verifies live health and readiness. DNS/email stay with MochaHost. No bypass of branch protections.
6. **Operator resilience:** Off-host backups, retention, encryption-key custody, tested restores and functional paging are launch criteria, not optional paperwork. Existing code may degrade safely when a provider is absent, but an unconfigured integration is never represented as live.
7. **Calendar exports:** Generate from a persisted booking, not from an unconfirmed hold; escape RFC 5545 TEXT values and fold long lines at 75 **UTF-8 octets** per physical line, without splitting multi-byte characters.
8. **Agent continuity:** Keep `AGENTS.md`, `WORKLOG.md` and the five `docs/` status files current; never claim a deployment or test without SHA-linked evidence. Avoid force-pushes and conflicting work.

References: `BRAND.md`, `RUN.md`, `docs/TAKATAK_INTEGRATION.md`, `docs/reservation-system/`, `docs/deployment/contabo-runbook.md`, [production readiness issue #25](https://github.com/takatakca/r2neet/issues/25).

