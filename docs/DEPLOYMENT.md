# R2NETTE — Deployment status

Snapshot: **2026-10-15**. Canonical instructions: [Contabo runbook](deployment/contabo-runbook.md) and [disaster recovery](reservation-system/disaster-recovery.md).

## Last verified production image

- SHA `10d11e89cfc496c58b4773735e60a43efab279ec` — [CI #38792313100](https://github.com/takatakca/r2neet/actions/runs/38792313100) passed and [Deploy #38792567205](https://github.com/takatakca/r2neet/actions/runs/38792567205) performed a real Contabo roll.
- VPS rollout log: `/healthz ok`, `/readyz ok`, `Deploy verified for commit 10d11e89cfc496c58b4773735e60a43efab279ec`.
- This does not verify payments, OTP, maps, alarms, backup restore or business workflows.

## Hosting and deployment contract

GitHub Actions `CI` on `main` must pass; `Deploy` builds an immutable Git SHA image and deploys Docker Compose to the Contabo VPS (`/opt/r2nette`), behind the documented existing Coolify proxy. MochaHost operates DNS/email, not the Node app. Workflow checks main again before rolling an image; jobs that skip obsolete SHAs are NOT deployment evidence.

1. Work on a branch and open PR; allow CI to run TypeScript, Vite, Vitest, migrations, safety and container checks. On failure inspect job logs and correct on that branch.
2. Merge only passing PR to `main`, using expected head SHA if supported; never force push.
3. Check main CI then non-skipped Deploy run matching the main commit. Inspect actual roll step and exact `Deploy verified for commit <sha>` marker plus both probes.
4. Confirm public TLS and controlled customer/worker checks, then document exact release and known unresolved warnings.
5. Roll back with `scripts/deploy/rollback.sh` when needed after reading the runbook; never restore to a production database without a scratch restore and key matching.

## Pending hardening release

Branch `chatgpt/backup-daily-failure-hardening-20261015` prevents per-minute retry of failed daily backup jobs and prevents local-only dumps reporting SUCCESS. Keep this marked pending until PR CI and actual image rollout verify it.

## Environment and disaster recovery

The 10d11e89 deploy warned that Stripe card keys and signed webhook, Twilio Voice/SMS, Google Maps, dispatch coordinates, S3 off-host credentials and signed alert webhook are not configured. They must be set via approved protected production environment and an operator must verify receipts. [Production issue #25](https://github.com/takatakca/r2neet/issues/25) owns the acceptance checklist. TAKATAK integration stays disabled while receiver PR #175 is unmerged or unverified.

Local PostgreSQL dump does **not** prove disaster recovery. Verify off-host checksum/HEAD, retention, scratch restore, booking/MFA data, correct `FIELD_ENCRYPTION_KEY` (and any retired keys), alarm delivery, and worker history. Never claim a recovery drill on the real off-host object based only on the CI synthetic restore drill.
