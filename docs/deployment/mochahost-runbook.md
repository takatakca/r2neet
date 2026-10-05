# MochaHost production runbook

This is the operational guide for running R2NETTE on a MochaHost Ubuntu VPS.
Nothing in this repository has been deployed. Do not point DNS at a host, enter
secrets, or start the stack until the owner-only gates at the bottom are done.

The future release command, after that one-time setup, is a push to `main`.
The deploy workflow runs only after the existing CI workflow succeeds on that
push. It builds one image, tags it with the full git commit SHA, and rolls the
VPS to that image. It does not deploy a working tree from a laptop.

## What is already in the repo

| Piece | Where |
|---|---|
| Production image | `Dockerfile` |
| Stack | `docker-compose.production.yml` |
| Proxy | `deploy/Caddyfile` |
| Variable names | `.env.production.example` |
| Startup gate | `scripts/deploy/validate-production-env.ts` |
| Health check | `scripts/deploy/healthcheck.sh` |
| Rollback | `scripts/deploy/rollback.sh` |
| VPS bootstrap | `scripts/deploy/bootstrap-ubuntu.sh` |
| Deploy workflow | `.github/workflows/deploy.yml` |

Services are `postgres`, `migrate`, `web`, `billing`, `scheduler`, `backup`, and `caddy`.
`migrate` runs `prisma migrate deploy` and must exit successfully before web or
the workers start. PostgreSQL has no published port. The host publishes 80 and
443 only.

`GET /healthz` is liveness and does not touch the database. `GET /readyz` is
readiness and pings the database. The web container is healthy only when both
succeed. A failed verification starts the previously recorded image again.
Database migrations are not reversed automatically.

## Phase 5 — bootstrap the VPS

Run as root, once, after SSH works:

```bash
bash scripts/deploy/bootstrap-ubuntu.sh
```

The script is safe to re-run. It installs Docker Engine from Docker's Ubuntu
repository, installs the Compose plugin, creates the `r2nette` user in the
`docker` group, creates `/opt/r2nette`, configures Docker json-file log
rotation when `/etc/docker/daemon.json` is absent, and enables unattended
security updates without automatic reboots.

It does not disable SSH password login. `deploy/sshd-hardening.conf.example`
is the later file. Install it only after a key login works from a second
terminal.

It stages UFW for SSH, HTTP, and HTTPS, and leaves the firewall disabled.
After that second SSH session works:

```bash
touch /etc/r2nette/second-ssh-confirmed
R2NETTE_CONFIRM_FIREWALL=yes bash scripts/deploy/bootstrap-ubuntu.sh
```

Copy the deploy files for the commit you intend to run into `/opt/r2nette`.
Create `/opt/r2nette/.env` from `.env.production.example` on the server.
Leave that file mode `0600` and owned by `r2nette`. Do not commit it.

## Phase 6 — domain and HTTPS

Ask the owner for the production domain. Do not invent one.

DNS, when the owner is ready:

- One `A` record from that domain to the MochaHost VPS public IPv4.
- No other record is required for the first site.

Then set these names in `/opt/r2nette/.env`:

```text
PRODUCTION_DOMAIN=
PUBLIC_URL=
NODE_ENV=production
TRUST_PROXY=true
REQUIRE_HTTPS=true
ACME_EMAIL=
```

`PUBLIC_URL` is `https://` plus the same domain. Caddy requests a certificate
for `PRODUCTION_DOMAIN` and proxies to the web container.

Port 80 behavior:

- `GET` and `HEAD` receive `308` to the HTTPS URL.
- Any other method receives `403` with `HTTPS_REQUIRED`. The body is not redirected.

The application keeps the same rule when it sees an insecure request. Do not
turn `REQUIRE_HTTPS` off to work around a certificate failure.

Check, after DNS and the first boot:

```bash
curl -sI "http://PRODUCTION_DOMAIN/healthz"
curl -sI -X POST "http://PRODUCTION_DOMAIN/api/v1/auth/phone/send"
curl -s "https://PRODUCTION_DOMAIN/healthz"
curl -s "https://PRODUCTION_DOMAIN/readyz"
```

The POST must stay on HTTP and return 403. The GET must advertise the HTTPS URL.

## Phase 7 — database

PostgreSQL 16 stores its data in the `pgdata` volume. The only migration
command in production is:

```bash
docker compose -f docker-compose.production.yml run --rm migrate
```

Never run `prisma migrate dev` or `prisma db push` against this database.

Before the first public request, take a backup and copy it off the host:

```bash
docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > "/opt/r2nette/state/r2nette-initial.dump"
```

Run that from a shell that already has the variables. Do not echo them.
Confirm the off-host object exists with the backup worker's storage account
after `BACKUP_S3_*` is set. A local dump alone does not count.

Restore drill, only into a throwaway database, never into production:

```bash
createdb r2nette_restore_drill
pg_restore --dbname "postgresql://RESTORE_USER@127.0.0.1/r2nette_restore_drill" \
  --no-owner --exit-on-error /opt/r2nette/state/r2nette-initial.dump
```

Drop the throwaway database when the drill is done. `FIELD_ENCRYPTION_KEY`
must be the same key that encrypted the dump's two-factor secrets, and it
lives outside the database.

The nightly `backup` service runs `npm run loop:backup`. Without
`BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, and
`BACKUP_S3_SECRET_ACCESS_KEY`, backups stay on the VPS volume and the
production gate warns. `BACKUP_S3_ENDPOINT` is optional and is how a
non-AWS S3 API is selected.

## Phase 8 — first owner

After `/healthz` and `/readyz` succeed, create the owner from an interactive
SSH session. Do not put this command in GitHub Actions. The command prints a
temporary password once. Do not copy that password into chat, tickets, or logs.

```bash
docker compose -f docker-compose.production.yml exec -T \
  -e STAFF_PASSWORD \
  web npm run staff:create -- \
  --email "OWNER_EMAIL" \
  --name "Owner Name" \
  --role OWNER
```

Omit `STAFF_PASSWORD` to let the command generate one. The owner then:

1. Signs in at `/admin`.
2. Changes the temporary password.
3. Enables TOTP.
4. Stores the recovery codes somewhere durable, outside the server.

## Phase 9 — provider callbacks

Use the final `https://PRODUCTION_DOMAIN`. Do not mark an integration
connected until the provider accepts the URL and a real callback is verified.
Do not invent webhook secrets.

| Provider | URL | Notes |
|---|---|---|
| Stripe | `https://PRODUCTION_DOMAIN/api/v1/stripe/webhook` | Required before any live secret key. Events are signed with `STRIPE_WEBHOOK_SECRET`. |
| Twilio Voice, staff leg | `https://PRODUCTION_DOMAIN/api/v1/voice/staff/{callbackId}` | The dialler builds this URL. |
| Twilio Voice, customer leg | `https://PRODUCTION_DOMAIN/api/v1/voice/customer/{callbackId}` | The dialler builds this URL. |
| Twilio Verify | none | The app calls Twilio. Verify does not post back to this app. |

Google customer sign-in is not implemented. Google Business Profile reviews
use a refresh token minted outside this app. There is no OAuth redirect route
to register here. If a Google Cloud client is created later, its redirect
belongs to that consent flow, not to a path this repository serves.

Voice TwiML paths are referenced by `src/callbacks/callback-service.ts`. This
runbook does not add handlers for them.

Unset Twilio, Stripe, Google Maps, backup storage, and the alert webhook are
warnings. The process still starts. Phone verification, card payment, address
lookup, off-host backup, and paging stay unavailable until those names are set.
A Stripe secret without `STRIPE_WEBHOOK_SECRET` is refused.

## Phase 10 — acceptance checklist

Do this against the live HTTPS domain after the owner gates are complete.
Do not send a real charge or a mass SMS.

- [ ] Homepage loads over HTTPS.
- [ ] `/auth` and `/login` show Login and Sign-up.
- [ ] An unknown login number shows the sign-up guidance.
- [ ] Sign-up for an existing completed account shows the login guidance.
- [ ] OTP request reaches the configured Verify service, then `/verify` accepts it.
- [ ] Completing registration creates the customer and a session.
- [ ] Signed-out requests to `/account`, `/admin`, and `/crew` do not show private data.
- [ ] `GET /healthz` returns alive and does not require the database.
- [ ] `GET /readyz` returns ready.
- [ ] `prisma migrate deploy` has applied every migration, including the registration migrations.
- [ ] `billing`, `scheduler`, and `backup` containers are running.
- [ ] HTTP GET redirects to HTTPS. HTTP POST returns 403 and is not redirected.
- [ ] Security headers are present, including a script CSP without `unsafe-inline`.
- [ ] Browser bundles, container logs, and git history contain no secrets.
- [ ] `state/current-image-ref` is the SHA that CI built.
- [ ] A backup object exists off the host, or the missing backup warning is an accepted owner decision.

## Deploy and roll back

GitHub Actions secrets, stored on the `production` environment:

- `MOCHAHOST_SSH_HOST`
- `MOCHAHOST_SSH_USER`
- `MOCHAHOST_SSH_KEY`
- `MOCHAHOST_SSH_KNOWN_HOSTS` (the pinned `ssh-keyscan` line)
- `MOCHAHOST_SSH_PORT` (optional, default 22)

The workflow checks out `workflow_run.head_sha`, builds
`ghcr.io/<owner>/<repo>:<sha>`, pushes that tag, copies the compose file and
deploy scripts to `/opt/r2nette`, runs the environment gate, starts the stack,
checks `/healthz` and `/readyz`, and checks the running image revision. Logs
go to `/opt/r2nette/logs/` through a redaction filter.

Manual rollback on the VPS:

```bash
bash /opt/r2nette/scripts/deploy/rollback.sh
```

That uses `state/previous-image-ref`. It does not restore an older database.

## Owner-only gates

These are not in this repository and were not performed:

1. Confirm the MochaHost plan is a VPS with root SSH.
2. Sign in to MochaHost.
3. Complete MFA or the host's security confirmation.
4. Choose the production domain.
5. Enter production credentials in protected fields only: PostgreSQL, Twilio, Stripe, Google Maps, backup storage, and the alert webhook.
6. Create the GitHub `production` environment and the SSH secrets above.
7. Create `/opt/r2nette/.env` on the server.
8. Publish the DNS `A` record when the VPS address is known.
9. Create the first owner interactively and keep the temporary password out of logs.
