# Production runbook: Contabo server, MochaHost domain and email

R2NETTE runs on a **Contabo VPS** with Docker. The **domain and mailboxes stay at
MochaHost**. Only the domain's web records change, and email is not touched.

After the one-time setup below, **every push to `main` deploys itself**. You can
push from Cursor, from GitHub, or from anywhere else. CI runs first, and the
deploy only starts if CI passes on that exact commit. The deploy builds one
image tagged with the commit SHA, rolls the server to it, checks health, and
rolls back automatically if the checks fail.

```
 push to main ─▶ CI ─▶ Deploy workflow ─▶ ghcr.io image :<sha> ─▶ Contabo VPS (/opt/r2nette)
                                                                  caddy  :80/:443  (HTTPS)
 MochaHost DNS: A @ and www ─────────────────────────────────────▶ web, billing, scheduler, backup
 MochaHost email: unchanged (MX stays at MochaHost)                postgres (no public port)
```

Never paste passwords, private keys or API keys into chat, tickets, Cursor or
ChatGPT. They go only into the server's `.env` file and into GitHub secrets.

## What is in the repo

| Piece | Where |
|---|---|
| Production image | `Dockerfile` |
| Stack | `docker-compose.production.yml` |
| HTTPS proxy | `deploy/Caddyfile` |
| Server bootstrap | `scripts/deploy/bootstrap-ubuntu.sh` |
| `.env` generator | `scripts/deploy/make-env.sh` |
| Production gate | `scripts/deploy/check-production-env.ts` (rules in `validate-production-env.ts`) |
| Compose wrapper for manual commands | `scripts/deploy/compose.sh` |
| Health check / rollback | `scripts/deploy/healthcheck.sh`, `scripts/deploy/rollback.sh` |
| Deploy workflow | `.github/workflows/deploy.yml` |

The services are `postgres`, `migrate`, `web`, `billing`, `scheduler`, `backup` and `caddy`.
`migrate` runs `prisma migrate deploy` and must finish before `web` or any
worker starts. PostgreSQL has no published port, and the host publishes only 80
and 443. `GET /healthz` checks liveness without touching the database. `GET /readyz`
checks readiness and pings the database.

---

## 1. Order the server (Contabo)

In the Contabo customer panel, order a **Cloud VPS**:

- 4 GB RAM or more, any region close to your customers.
- Image: **Ubuntu 24.04**.
- Under "Login", add your own SSH public key if the order form offers it.
  Otherwise set a strong root password; you will switch to keys below.

Write down the server's **public IPv4 address**. This guide calls it `SERVER_IP`.

## 2. Bootstrap the server

From your computer's terminal (PowerShell on Windows):

```bash
ssh root@SERVER_IP
git clone https://github.com/takatakca/r2neet.git /root/r2neet
bash /root/r2neet/scripts/deploy/bootstrap-ubuntu.sh
```

If the repository is private, `git clone` asks for credentials. Use your
GitHub username and a **fine-grained personal access token** that has read-only
access to this one repository. The clone is only needed for these setup scripts.
Deploys copy their own files.

The script is safe to run again. It installs Docker and the Compose plugin,
creates the `r2nette` deploy user, creates `/opt/r2nette`, sets up log
rotation, and turns on automatic security updates without automatic reboots.
It **stages** the firewall for SSH, HTTP and HTTPS but leaves it off until a
second SSH login is confirmed. Step 4 does that.

## 3. Create the server settings (`.env`)

Still as root on the server. Replace the domain and email with yours:

```bash
bash /root/r2neet/scripts/deploy/make-env.sh yourdomain.com you@yourdomain.com
```

This writes `/opt/r2nette/.env` with mode `0600`, owned by `r2nette`. It contains:

- a generated PostgreSQL password, plus database URLs pointing at the `postgres` container;
- a generated `FIELD_ENCRYPTION_KEY`;
- `PRODUCTION_DOMAIN`, `PUBLIC_URL=https://yourdomain.com` and `ACME_EMAIL` for the certificate;
- empty slots for Twilio, Stripe, Google Maps, email, backups and alerts.

**Copy `FIELD_ENCRYPTION_KEY` into your password manager now:**

```bash
grep FIELD_ENCRYPTION_KEY /opt/r2nette/.env
```

Without that key, a restored database locks out every staff account that uses
two-step verification. The script refuses to overwrite an existing `.env`, so
the key is never replaced by accident.

Add the other services later by editing the file (`nano /opt/r2nette/.env`),
then redeploy (step 8). Until a service is set, the app runs without it and the
deploy log names what is missing.

## 4. Let GitHub log in to the server

On **your computer**, not the server, create a key used only for deploys:

```bash
ssh-keygen -t ed25519 -f r2nette_deploy -N "" -C "github-actions-deploy"
ssh-keyscan -t ed25519 SERVER_IP > r2nette_known_hosts
```

Install the public key for the `r2nette` user:

```bash
ssh root@SERVER_IP "install -d -m 700 -o r2nette -g r2nette /home/r2nette/.ssh && cat >> /home/r2nette/.ssh/authorized_keys && chown r2nette:r2nette /home/r2nette/.ssh/authorized_keys && chmod 600 /home/r2nette/.ssh/authorized_keys" < r2nette_deploy.pub
```

Check that it works from a **second** terminal. It should print `ok` without asking for a password:

```bash
ssh -i r2nette_deploy r2nette@SERVER_IP 'docker ps >/dev/null && echo ok'
```

Now that a second login is confirmed, turn the firewall on (as root on the server):

```bash
touch /etc/r2nette/second-ssh-confirmed
R2NETTE_CONFIRM_FIREWALL=yes bash /root/r2neet/scripts/deploy/bootstrap-ubuntu.sh
```

In GitHub, open the repository, then **Settings → Environments → New environment** and name it `production`.
Add these **environment secrets**:

| Secret | Value |
|---|---|
| `CONTABO_SSH_HOST` | `SERVER_IP` |
| `CONTABO_SSH_USER` | `r2nette` |
| `CONTABO_SSH_KEY` | the full contents of `r2nette_deploy`, including the `BEGIN` and `END` lines |
| `CONTABO_SSH_KNOWN_HOSTS` | the full contents of `r2nette_known_hosts` |
| `CONTABO_SSH_PORT` | optional; only if SSH is not on port 22 |

The known-hosts line pins the server's identity, so a deploy can never be
redirected to another machine. Afterwards, delete `r2nette_deploy` from your
computer, or keep it in a password manager.

## 5. Point the domain at the server (MochaHost)

In MochaHost **cPanel → Zone Editor**, choose **Manage** on your domain:

| Type | Name | Value | Action |
|---|---|---|---|
| `A` | `yourdomain.com.` | `SERVER_IP` | **Edit** the existing record |
| `A` | `www.yourdomain.com.` | `SERVER_IP` | Edit, or replace a `www` `CNAME` with this `A` record |
| `AAAA` | `yourdomain.com.` / `www` | (none) | **Delete** if present; it would still point at MochaHost |

**Do not touch** `MX`, `mail`, `autodiscover`, `autoconfig`, `webmail`, `cpanel`,
or the `TXT` records for SPF (`v=spf1`), DKIM (`default._domainkey`) and DMARC.
They keep your mailboxes working at MochaHost.

If **Domains → Nameservers** shows that the domain does not use MochaHost's
nameservers, make the same edits at the provider those nameservers belong to.

DNS changes take minutes to a few hours. To check, run `nslookup yourdomain.com`;
it should answer with `SERVER_IP`.

## 6. Merge, and the first deploy runs

Merge the pull request into `main`. CI runs, and when it passes the **Deploy**
workflow (Actions tab) starts. It:

1. builds `ghcr.io/takatakca/r2neet:<sha>` and pushes it;
2. copies the compose file, Caddyfile and deploy scripts to `/opt/r2nette`;
3. runs the production gate against `/opt/r2nette/.env`, refusing weak or missing settings;
4. starts the stack. `migrate` applies the database migrations first;
5. checks `/healthz` and `/readyz` and the running image's revision;
6. rolls back automatically if any check fails.

If the secrets were not in place when the merge happened, add them, then use
**Actions → Deploy → Run workflow** on `main`.

Once DNS points at the server, Caddy obtains the HTTPS certificates by itself.
Check:

```bash
curl -sI http://yourdomain.com/healthz                     # 308 to https
curl -sI -X POST http://yourdomain.com/api/v1/auth/phone/send   # 403, never redirected
curl -s  https://yourdomain.com/healthz                    # {"status":"alive",...}
curl -s  https://yourdomain.com/readyz                     # {"status":"ready"}
curl -sI https://www.yourdomain.com/                       # 308 to https://yourdomain.com/
```

## 7. Create the owner account

From an SSH session as `r2nette` (`ssh -i r2nette_deploy r2nette@SERVER_IP`):

```bash
cd /opt/r2nette
bash scripts/deploy/compose.sh exec web npm run staff:create -- \
  --email "you@yourdomain.com" --name "Your Name" --role OWNER
```

It prints a temporary password **once**. Do not paste it anywhere. Then:

1. Sign in at `https://yourdomain.com/admin`.
2. Change the password.
3. Turn on two-step verification at `/admin#security`.
4. Store the recovery codes somewhere durable, off the server.

Run any other manual `docker compose` command through `scripts/deploy/compose.sh`.
The compose file refuses to start without the deployed image name, and the
wrapper supplies it.

```bash
bash scripts/deploy/compose.sh ps
bash scripts/deploy/compose.sh logs -f web
```

## 8. Everyday use

- **Release:** push or merge to `main`. That is the whole release process.
- **Redeploy without a code change**, for example after editing `.env`:
  use **Actions → Deploy → Run workflow** on `main`.
- **Roll back** to the previous release (the database is not rolled back):

  ```bash
  bash /opt/r2nette/scripts/deploy/rollback.sh
  ```

- **Logs:** each deploy writes a redacted log to `/opt/r2nette/logs/`. For the
  app's logs, run `bash scripts/deploy/compose.sh logs --tail 200 web`.

---

## Email: mailboxes at MochaHost, app email through Resend

Your mailboxes, such as `info@yourdomain.com`, stay at MochaHost. Nothing above changes them.

The app sends booking confirmations and reminders through an **HTTP email
API**, not SMTP. It sends a `POST` with `Authorization: Bearer <key>` and a JSON
body `{from, to, subject, text}`
(`src/notifications/notification-service.ts`). That is exactly the request
Resend accepts:

1. Create a Resend account and **add your domain**. Resend shows a few DNS
   records: a DKIM `TXT` record, plus `MX` and SPF `TXT` records on a `send`
   subdomain. Add them in the MochaHost Zone Editor **alongside** the existing
   records. They live on their own names, so your domain's own `MX` stays as it is.
2. When Resend shows the domain as verified, set these in `/opt/r2nette/.env`:

   ```
   EMAIL_API_URL=https://api.resend.com/emails
   EMAIL_API_KEY=re_...
   EMAIL_FROM=R2NETTE <bookings@yourdomain.com>
   ```

3. Redeploy (section 8).

Until these are set, email notifications are recorded as `SUPPRESSED` and are
never reported as sent.

## Provider callbacks

Use the final `https://yourdomain.com`. Do not mark an integration connected
until the provider accepts the URL and a real callback has been verified.

| Provider | URL | Notes |
|---|---|---|
| Stripe | `https://yourdomain.com/api/v1/stripe/webhook` | Required before any live secret key. Put the signing secret in `STRIPE_WEBHOOK_SECRET`; a Stripe key without it is refused. |
| Twilio Voice, staff leg | `https://yourdomain.com/api/v1/voice/staff/{callbackId}` | The dialler builds this URL. |
| Twilio Voice, customer leg | `https://yourdomain.com/api/v1/voice/customer/{callbackId}` | The dialler builds this URL. |
| Twilio Verify | none | The app calls Twilio; Verify does not call back. |

Customer sign-in needs **Twilio Verify** (`TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`). Without it, nobody can
receive a code, so set it up before you announce the site.

## Database and backups

PostgreSQL 16 keeps its data in the `pgdata` Docker volume. In production,
migrations run only through `migrate` during a deploy. Never run `prisma migrate dev`
or `prisma db push` against this database.

Take a dump before the first public request and copy it off the server:

```bash
cd /opt/r2nette
bash scripts/deploy/compose.sh exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > state/r2nette-initial.dump
```

The `backup` service dumps nightly at `BACKUP_AT`. Set `BACKUP_S3_BUCKET`,
`BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY`
so those dumps leave the server. Any S3-compatible storage works (Backblaze B2,
Cloudflare R2, Wasabi), and `BACKUP_S3_ENDPOINT` selects a non-AWS provider.
Without them, backups stay on the same disk as the database. A restore needs both
the dump and `FIELD_ENCRYPTION_KEY`; see `docs/reservation-system/disaster-recovery.md`.

## Later: SSH hardening

After the key login in step 4 works from a second terminal, you can turn off
password logins with `deploy/sshd-hardening.conf.example`. Only do this once a
key login is confirmed, or you can lock yourself out.

## Acceptance checklist

Run this against the live HTTPS domain. Do not send a real charge or a mass SMS.

- [ ] The homepage loads over HTTPS, and `www.` redirects to the bare domain.
- [ ] `/login` shows Login and Sign-up.
- [ ] Sending a code says the same thing whether or not the number has an account.
- [ ] After the code, an unknown number on Login gets the sign-up guidance, and an existing number on Sign-up gets the login guidance.
- [ ] Completing sign-up creates the customer and signs them in.
- [ ] Signed-out requests to `/account`, `/admin` and `/crew` show no private data.
- [ ] `/healthz` returns alive and `/readyz` returns ready.
- [ ] `billing`, `scheduler` and `backup` are running (`bash scripts/deploy/compose.sh ps`).
- [ ] HTTP GET redirects to HTTPS, and HTTP POST returns 403 without a redirect.
- [ ] Security headers are present, including a script CSP without `unsafe-inline`.
- [ ] `state/current-image-ref` holds the SHA that CI built.
- [ ] A backup exists off the server, or keeping backups on the server is an accepted decision.

## Things only the owner can do

These need your accounts. They are not in this repository and nobody has done them yet:

1. Order the Contabo VPS (step 1).
2. Run the bootstrap and create `.env` on the server (steps 2–3).
3. Create the deploy key, the `production` environment and its secrets in GitHub (step 4).
4. Change the `A` records in MochaHost's Zone Editor (step 5).
5. Create the owner account interactively (step 7).
6. Enter provider credentials (Twilio, Stripe, Google Maps, Resend, backup storage) in `/opt/r2nette/.env`.
