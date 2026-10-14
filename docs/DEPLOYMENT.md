# R2NETTE — Deployment state and runbook

Snapshot: 2026-10-14. Detailed canonical procedure: [Contabo runbook](deployment/contabo-runbook.md). **Do not mistake MochaHost DNS/mail for the app host.**

## Verified environment
- Repository: `takatakca/r2neet`, publication branch `main`.
- App: Contabo VPS, Docker Compose project at `/opt/r2nette`, Coolify proxy when detected; public domain `https://r2nette.ca`.
- Domain DNS/email: MochaHost. Preserve MX, SPF, DKIM, `mail` host and existing cPanel mail.
- GitHub Actions: `CI` must pass on the pushed `main` SHA; `Deploy` builds/pushes a tagged image and rolls the VPS, performs health/readiness and rollback checks. Its workflow skips superseded commits before build and again before the server roll.
- Last verified production deployment (before the new release): `fea51644ecee9e8ed600a72915dfb72425daae66`, [run #38611624915](https://github.com/takatakca/r2neet/actions/runs/38611624915), status success. Deployment log: `/healthz ok`, `/readyz ok`, `Deploy verified for commit fea51644...`.

## Next publication

Feature [PR #26](https://github.com/takatakca/r2neet/pull/26) is merged as `39e10d165357c3882ed16f9e59b8ded986411719` and its PR CI was green. The independent `main` CI and corresponding deployment must still be checked for this and the subsequent documentation maintenance commit. A merged SHA is **not** a verified deployed SHA.

## Operational steps
1. Review `AGENTS.md`, recent PRs/issues and `WORKLOG.md`; ensure no conflicting ongoing task.
2. Change code on a reviewable branch. Run `npm ci`, `npx prisma generate`, `npm run ci`, targeted regression tests, and check schema migrations from scratch when modified. Let GitHub CI validate.
3. Merge a green PR, or push to `main` only within approved branch policy. Never force-push or skip required checks.
4. Inspect the **matching SHA** in Actions `CI` and `Deploy`. Check `Deploy verified for commit <sha>` and both probes, not just a green shell command. A green job can legitimately skip an obsolete deployment.
5. Confirm public `https://r2nette.ca` DNS/TLS and a controlled booking smoke, and preserve the last known good SHA for rollback.
6. Update `docs/AGENT_HANDOFF.md` and `WORKLOG.md` with the **observed** SHA, checks and blockers.

## Service configuration (no values here)
Use the protected `production` GitHub environment and `server-setup.yml`/documented server setup to configure Stripe (+ mandatory webhook), Twilio, TAKATAK Supabase Auth, Google Maps, S3 off-host backups and alert webhook. Run deployment after setup and verify again. Do not enable TAKATAK sync while its receiving PR #175 is unmerged/unreleased.

## Known warning state
As of the verified deploy log: Stripe card payments unavailable; Twilio Voice/SMS, Google Maps, dispatch origin, off-host backup and alert webhook were not configured. They are tracked in issue #25. These are **operational blockers**, not successful live integrations.

## Rollback and recovery
Existing `scripts/deploy/rollback.sh` and `scripts/deploy/healthcheck.sh` perform the guarded rollback/check steps. Review `docs/reservation-system/disaster-recovery.md` before restoring data: off-host dump **and** `FIELD_ENCRYPTION_KEY` are needed. Restore to a scratch DB, prove MFA and booking data integrity, then consider production restoration. Never run destructive migrations or test restores on the live DB.

