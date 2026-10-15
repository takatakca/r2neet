# R2NETTE — Deployment state and runbook

Snapshot: 2026-10-15. Detailed canonical procedure: [Contabo runbook](deployment/contabo-runbook.md). **Do not mistake MochaHost DNS/mail for the app host.**

## Verified environment

- `takatakca/r2neet` deploys `main` to the Contabo VPS through CI-gated SHA-tagged Docker Compose in `/opt/r2nette`; Coolify hosts the reverse proxy as documented. DNS and email stay with MochaHost.
- Successful non-skipped release [#38776393992](https://github.com/takatakca/r2neet/actions/runs/38776393992): `ce8eb68dbb49d67fd9c7949c700fd25261d66380`, `/healthz ok`, `/readyz ok`.
- **Last verified production:** successful non-skipped release [#38777515485](https://github.com/takatakca/r2neet/actions/runs/38777515485): `a46849b5e29619a7ee8fd14469e2a98d70b6b28c`, `/healthz ok`, `/readyz ok`, exact SHA confirmed.
- Latest functional merge `a46849b5e29619a7ee8fd14469e2a98d70b6b28c` passed [CI #38777285346](https://github.com/takatakca/r2neet/actions/runs/38777285346) and [Deploy #38777515485](https://github.com/takatakca/r2neet/actions/runs/38777515485), including health/readiness and exact-SHA checks.

## Incidents and recovery

Deploy [#38775849037](https://github.com/takatakca/r2neet/actions/runs/38775849037) initially failed on npm registry `ECONNRESET`. Its single retry published the image but deliberately **skipped** a now-stale VPS roll. Bounded install retries entered production with `6a7f192e`. Never equate a green job that skipped rolling the VPS with a deployed release.

## Next publication

Feature `a46849b5` has verified CI and deployment. The handoff documentation branch is NOT a published release until it passes its own PR/main CI and a **non-skipped** Deploy matching the resulting merge SHA.

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

