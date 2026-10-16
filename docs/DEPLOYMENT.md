# R2NETTE — Deployment status

Snapshot: **2026-10-16**. Canonical instructions: [Contabo runbook](deployment/contabo-runbook.md) and [disaster recovery](reservation-system/disaster-recovery.md).

## Last verified production image

- SHA `1c140ac19682d238c2eef068370b9a8405d43a2d` — [CI #38849296051](https://github.com/takatakca/r2neet/actions/runs/38849296051) passed and [Deploy #38849434426](https://github.com/takatakca/r2neet/actions/runs/38849434426) performed a real Contabo roll.
- VPS rollout log: `/healthz ok`, `/readyz ok`, `Deploy verified for commit 1c140ac19682d238c2eef068370b9a8405d43a2d`.
- This does not verify payments, OTP, maps, alarms, backup restore or business workflows.

## Hosting and deployment contract

GitHub Actions `CI` on `main` must pass; `Deploy` builds an immutable Git SHA image and deploys Docker Compose to the Contabo VPS (`/opt/r2nette`), behind the documented existing Coolify proxy. MochaHost operates DNS/email, not the Node app. Workflow checks main again before rolling an image; jobs that skip obsolete SHAs are NOT deployment evidence.

1. Work on a branch and open PR; allow CI to run TypeScript, Vite, Vitest, migrations, safety and container checks. On failure inspect job logs and correct on that branch.
2. Merge only passing PR to `main`, using expected head SHA if supported; never force push.
3. Check main CI then non-skipped Deploy run matching the main commit. Inspect actual roll step and exact `Deploy verified for commit <sha>` marker plus both probes.
4. Confirm public TLS and controlled customer/worker checks, then document exact release and known unresolved warnings.
5. Roll back with `scripts/deploy/rollback.sh` when needed after reading the runbook; never restore to a production database without a scratch restore and key matching.

## Verified hardening releases

- PR #32: scheduler backup fail-closed changes merged as `aa51fd30d8ef3eff44130b806f15029cdf8bb568` and deployed [#38849030331](https://github.com/takatakca/r2neet/actions/runs/38849030331) with probes OK.
- PR #33: scrub PostgreSQL password from `pg_dump` arguments, merged `1c140ac19682d238c2eef068370b9a8405d43a2d` and deployed [#38849434426](https://github.com/takatakca/r2neet/actions/runs/38849434426) with probes OK.
- Documentation-only handoff commits following this section are pending their own matching CI/deploy verification; do not mistake prior verified production SHA for current main HEAD.

## Environment and disaster recovery

The 1c140ac1 deploy warned that Stripe card keys and signed webhook, Twilio Voice/SMS, Google Maps, dispatch coordinates, S3 off-host credentials and signed alert webhook are not configured. They must be set via approved protected production environment and an operator must verify receipts. [Production issue #25](https://github.com/takatakca/r2neet/issues/25) owns the acceptance checklist. TAKATAK integration stays disabled while receiver PR #175 is unmerged or unverified.

Local PostgreSQL dump does **not** prove disaster recovery. Verify off-host checksum/HEAD, retention, scratch restore, booking/MFA data, correct `FIELD_ENCRYPTION_KEY` (and any retired keys), alarm delivery, and worker history. Never claim a recovery drill on the real off-host object based only on the CI synthetic restore drill.
