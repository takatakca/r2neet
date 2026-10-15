# R2NETTE — Deployment state and runbook

Snapshot: 2026-10-15. Detailed canonical procedure: [Contabo runbook](deployment/contabo-runbook.md). **Do not mistake MochaHost DNS/mail for the app host.**

## Verified environment
- Repository: `takatakca/r2neet`, publication branch `main`.
- App: Contabo VPS, Docker Compose project at `/opt/r2nette`, Coolify proxy when detected; public domain `https://r2nette.ca`.
- Domain DNS/email: MochaHost. Preserve MX, SPF, DKIM, `mail` host and existing cPanel mail.
- GitHub Actions: `CI` must pass on the pushed `main` SHA; `Deploy` builds/pushes a tagged image and rolls the VPS, performs health/readiness and rollback checks. Its workflow skips superseded commits before build and again before the server roll.
- Last verified production deployment: `152ddf16016038339af1d265f6c8d29b1960a19a`, [CI #38613223891](https://github.com/takatakca/r2neet/actions/runs/38613223891), [Deploy #38614841577](https://github.com/takatakca/r2neet/actions/runs/38614841577), successful non-skipped VPS roll. Log: `/healthz ok`, `/readyz ok`, `Deploy verified for commit 152ddf16...`.

## Deployment failure to recover

[Deploy #38775849037](https://github.com/takatakca/r2neet/actions/runs/38775849037) for `c7a47233` failed at Docker build dependency installation (`npm error network read ECONNRESET`); it did not reach VPS roll. A single retry built the image but correctly skipped the obsolete VPS roll after main advanced. The branch `chatgpt/docker-npm-network-recovery-20261015` introduces bounded retries for `npm ci`; do not claim the new code is deployed until its **exact** SHA has a successful non-skipped Deploy with both probes.

## Most recent successful rollout

[Deploy #38776393992](https://github.com/takatakca/r2neet/actions/runs/38776393992) successfully rolled `ce8eb68dbb49d67fd9c7949c700fd25261d66380` and logged `/healthz ok`, `/readyz ok`, and the exact SHA. Docker retry PR #29 (`6a7f192e`) subsequently merged; do not assume its own production rollout until the matching deploy is checked.

## Next publication

The code for the privacy-safe browser draft is on branch `chatgpt/privacy-safe-booking-draft-20261015` pending PR CI and merge. Do not treat that change as deployed until its own matching SHA has a successful non-skipped Deploy log.

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

