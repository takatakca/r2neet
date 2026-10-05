# Deploying to Contabo, with the domain and email at MochaHost

Once this is set up, **every push to `main` deploys itself**: from Cursor, from
GitHub, from anywhere. CI runs first. If CI passes, GitHub Actions logs into the
Contabo server over SSH, pulls the commit, runs database migrations, and
restarts the app. Caddy handles HTTPS automatically.

```
 Cursor ──push──▶ GitHub ──CI passes──▶ Deploy workflow ──SSH──▶ Contabo VPS
                                                                 ├─ caddy     (HTTPS, :80/:443)
 MochaHost DNS: A record ─────────────────────────────────────▶  ├─ web       (:3000, loopback only)
 MochaHost email: unchanged (MX stays at MochaHost)              ├─ billing / scheduler / backup
                                                                 └─ postgres
```

You do the one-time setup below yourself. It takes about 30 minutes. **Never
paste passwords, private keys or API keys into a chat, Cursor prompt or
ChatGPT.** They go only into the server's `.env` file and into GitHub Secrets.

---

## 1. Contabo: get a server

A **Cloud VPS** with 4 GB RAM or more, running **Ubuntu 24.04**. Note its
**IPv4 address** from the Contabo control panel. Below it's written as `SERVER_IP`.

## 2. Bootstrap the server (once)

From your computer's terminal (on Windows: PowerShell):

```bash
ssh root@SERVER_IP
curl -fsSL https://raw.githubusercontent.com/takatakca/r2neet/main/deploy/server-setup.sh -o setup.sh
bash setup.sh
```

> If the repo is **private**, the `curl` and `git clone` will fail. Instead run
> `git clone https://<github-user>:<fine-grained-token>@github.com/takatakca/r2neet.git /opt/r2nette`
> first. Use a read-only token scoped to this repo. Then run `bash /opt/r2nette/deploy/server-setup.sh`.

The script installs Docker, turns on a firewall (SSH/80/443 only), creates a
`deploy` user, clones the repo to `/opt/r2nette`, and creates `.env` with a
random database password and encryption key.

Then edit the settings:

```bash
nano /opt/r2nette/.env
```

Set at least:

| Variable | Value |
|---|---|
| `DOMAIN` | your domain, e.g. `r2nette.ca` (no `https://`, no `www`) |
| `ACME_EMAIL` | your email, for Let's Encrypt expiry notices |
| `PUBLIC_URL` | `https://your-domain` |

Stripe, Twilio, Google keys etc. can be added later. Each integration
shows NOT_CONFIGURED until its keys are set. **Copy `FIELD_ENCRYPTION_KEY`
somewhere safe** (a password manager). Without it, a database restore locks
out every 2FA account.

## 3. Let GitHub log in to the server

On **your computer** (not the server), make a key used only for deploys:

```bash
ssh-keygen -t ed25519 -f r2nette_deploy -N "" -C "github-actions-deploy"
```

This creates two files:

- `r2nette_deploy.pub` (public key): put it on the server:
  ```bash
  ssh root@SERVER_IP "cat >> /home/deploy/.ssh/authorized_keys" < r2nette_deploy.pub
  ```
- `r2nette_deploy` (private key): put it in GitHub. Go to the repo, then
  **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `CONTABO_HOST` | `SERVER_IP` |
| `CONTABO_SSH_KEY` | full contents of the `r2nette_deploy` file, including the `BEGIN`/`END` lines |
| `CONTABO_USER` | *(optional)* defaults to `deploy` |
| `CONTABO_APP_DIR` | *(optional)* defaults to `/opt/r2nette` |

Then delete the local private key file.

## 4. MochaHost: point the domain at Contabo (keep email where it is)

In MochaHost **cPanel → Zone Editor** (or *DNS Zone Editor*) for your domain:

| Type | Name | Value | Action |
|---|---|---|---|
| A | `@` (your domain) | `SERVER_IP` | **edit** the existing A record |
| A | `www` | `SERVER_IP` | edit, or replace a `www` CNAME |
| AAAA | `@` / `www` | — | **delete** if present (it would point at MochaHost) |

**Do not touch** the `MX`, `mail`, `autodiscover`, SPF (`TXT v=spf1…`), DKIM or
DMARC records. Those keep your email working at MochaHost.

> If your domain's nameservers are **not** MochaHost's (check
> **Domains → Nameservers**), make these edits wherever the nameservers point.

DNS takes from a few minutes up to a few hours to update. Check with `nslookup your-domain`. It
should return `SERVER_IP`.

## 5. First start

```bash
ssh root@SERVER_IP
su - deploy
cd /opt/r2nette
docker compose up -d --build    # .env sets COMPOSE_FILE, so this includes Caddy/HTTPS
docker compose logs -f migrate web caddy     # Ctrl+C to stop watching
```

Once DNS resolves, Caddy fetches the certificate by itself. Then create the
owner login:

```bash
docker compose exec web npm run staff:create -- --email you@your-domain --name "Your Name" --role OWNER
```

Open `https://your-domain/admin`, sign in, change the password, and turn on 2FA.

## 6. From now on: just push

Push or merge to `main` from Cursor. The **Deploy** workflow (Actions tab)
runs after CI passes. To redeploy without a code change, use **Actions → Deploy →
Run workflow**.

---

## Email: MochaHost mailboxes plus an app-sending service

Your **mailboxes** (`info@your-domain` etc.) stay at MochaHost. Nothing above
changes them.

The **app** sends booking confirmations and reminders through an HTTP email
API, not SMTP. The request it sends (`Authorization: Bearer`, JSON with
`from`/`to`/`subject`/`text`) matches **Resend** as-is:

1. Sign up at resend.com and add your domain. Resend gives you DNS records
   (a DKIM `TXT` and an SPF entry for a `send` subdomain). Add them in
   MochaHost's Zone Editor **alongside** the existing records. Do not
   replace your MX.
2. In `/opt/r2nette/.env`:
   ```
   EMAIL_API_URL=https://api.resend.com/emails
   EMAIL_API_KEY=re_...
   EMAIL_FROM=R2NETTE <bookings@your-domain>
   ```
3. Redeploy (Actions → Deploy → Run workflow), or run `cd /opt/r2nette && docker compose up -d` on the server.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails at "Check secrets" | Add `CONTABO_HOST` / `CONTABO_SSH_KEY` (step 3). |
| `Permission denied (publickey)` | The public key isn't in `/home/deploy/.ssh/authorized_keys`. |
| Site shows a certificate error | DNS doesn't point at the server yet, or an old AAAA record still exists. `docker compose logs caddy`. |
| `web` keeps restarting | `docker compose logs web`. The app refuses to start on unsafe config and prints the reason. |
| Need to edit settings | `nano /opt/r2nette/.env`, then `cd /opt/r2nette && docker compose up -d`. |

Backups: set the `BACKUP_S3_*` variables (Backblaze B2 or Cloudflare R2 work
well) so backups leave the server. See `docs/reservation-system/disaster-recovery.md`.
