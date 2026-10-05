# Production runbook: Contabo server, MochaHost domain and email

R2NETTE runs on a **Contabo VPS** with Docker. The **domain and mailboxes stay at
MochaHost**. The website's DNS records move to the VPS. Email stays at MochaHost,
but on a standard cPanel zone it shares the website's address, so step 6 first
gives email an address of its own. Otherwise your mail would move with the website.

After the one-time setup below, **every push to `main` deploys itself**. You can
push from Cursor, from GitHub, or from anywhere else. CI runs first, and the
deploy only starts if CI passes on that exact commit. The deploy builds one
image tagged with the commit SHA, rolls the server to it, checks health, and
rolls back automatically if the checks fail.

```
 push to main ─▶ CI ─▶ Deploy workflow ─▶ ghcr.io image :<sha> ─▶ Contabo VPS (/opt/r2nette)
                                                                  caddy  :80/:443  (HTTPS)
 MochaHost DNS: A @ and www ─────────────────────────────────────▶ web, billing, scheduler, backup
 MochaHost email: MX ─▶ mail.yourdomain.com (stays at MochaHost)   postgres (no public port)
```

Never paste passwords, private keys or API keys into chat, tickets, Cursor or
ChatGPT. They go only into the server's `.env` file and into GitHub secrets.

The commands below work in the macOS Terminal, on Linux, and in **PowerShell on
Windows**. Windows 10 and 11 include `ssh`, `scp` and `ssh-keygen`; if PowerShell
says `ssh` is not recognized, add **OpenSSH Client** under **Settings → Apps →
Optional features**. Replace `SERVER_IP`, `MOCHAHOST_IP` and `yourdomain.com`
with your own values every time. A block that says **on the server** runs inside
an `ssh` session; everything else runs on your own computer.

## Fastest path: let GitHub Actions do it

You never need to SSH in. Add a few **secrets** in GitHub, then run three
workflows from **Actions** (or ask Claude to run them). The workflows do steps
3–8 below for you.

**1. Add secrets.** In the repository, go to **Settings → Secrets and
variables → Actions → New repository secret**. Add one per name:

| Secret | Value | Needed for |
|---|---|---|
| `CONTABO_SSH_HOST` | The VPS IPv4 address, from the Contabo panel | everything |
| `CONTABO_ROOT_PASSWORD` | The VPS root password, from Contabo's welcome email (or set `CONTABO_ROOT_SSH_KEY` to a root private key instead) | everything |
| `OWNER_INITIAL_PASSWORD` | The password for your first `/admin` login (12+ characters). You change it at first sign-in | creating the owner |
| `MOCHAHOST_CPANEL_HOST` | Your cPanel address without `https://` or `:2083`, e.g. `server123.mochahost.com` (it appears in cPanel's address bar) | DNS |
| `MOCHAHOST_CPANEL_USER` | Your cPanel username | DNS |
| `MOCHAHOST_CPANEL_TOKEN` | cPanel → **Security → Manage API Tokens → Create**. Name it `r2nette-dns` and copy the token it shows once | DNS |
| `CONTABO_SSH_PORT` | Only if SSH is not on port 22 | optional |

Provider keys can be added the same way whenever you have them. **Server setup**
copies each one it finds into the server's `.env`: `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `STRIPE_SECRET_KEY`,
`STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_MAPS_API_KEY`,
`EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`, `BACKUP_S3_*`, `ALERT_WEBHOOK_*`.
Run **Server setup** again after adding one, then **Deploy**.

**2. Run the workflows**, each from **Actions → (workflow) → Run workflow**, in this order:

1. **Server setup**, with your domain and an email address for certificate
   notices. It installs Docker, turns on the firewall, writes `/opt/r2nette/.env`
   with generated secrets, and prints the server's public host key. That key
   gets committed to `deploy/known_hosts`, so later runs refuse any other machine.
2. **Deploy**. It builds, starts and health-checks the app.
3. **DNS (MochaHost)**: first `plan`, which is read-only and shows every change.
   Then `email`, which gives mail its own records so it stays at MochaHost.
   Then, ideally after the TTL shown in the plan, `web`, which points the
   domain and `www` at the VPS. HTTPS starts working minutes after `web`.
4. **Server admin** → `create-owner`, with your email and name. Then sign in at
   `https://yourdomain.com/admin` with `OWNER_INITIAL_PASSWORD`, change it, and
   turn on two-step verification. **Server admin** → `status` shows health at any time.

The repository is public, so these logs are public. The workflows print names,
public DNS records and host keys, never a secret value. The server's
`FIELD_ENCRYPTION_KEY` is generated on the server and never leaves it. To keep
a copy for disaster recovery, see step 4.

The manual steps below do the same things by hand, and explain each one.

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
| Setup / admin / DNS workflows | `.github/workflows/server-setup.yml`, `server-admin.yml`, `dns-mochahost.yml` |
| DNS automation (cPanel API) | `scripts/deploy/mochahost-dns.py` |

The services are `postgres`, `migrate`, `web`, `billing`, `scheduler`, `backup` and `caddy`.
`migrate` runs `prisma migrate deploy` and must finish before `web` or any
worker starts. PostgreSQL has no published port, and the host publishes only 80
and 443. `GET /healthz` checks liveness without touching the database. `GET /readyz`
checks readiness and pings the database.

---

## 1. Merge the deployment pull request

The setup scripts used in steps 3 and 4 reach `main` with the deployment pull
request (the one that adds this runbook), so merge it first: on GitHub, open the
pull request and choose **Merge pull request**.

Merging starts CI, and when CI passes the **Deploy** workflow starts by itself.
That first run **fails, and that is expected**: the step "Roll the VPS to that
image" stops with `Missing required secret name: CONTABO_SSH_HOST`, because the
server and its secrets do not exist yet. It changes nothing on any server.
Step 7 runs the deploy again with **Actions → Deploy → Run workflow** once the
server is ready. Ignore any email from GitHub about the failed run.

## 2. Order the server (Contabo)

First make sure you have **your own SSH key**. It is how you log in to the
server; GitHub gets a separate key in step 5. Check for one:

```bash
cat $HOME/.ssh/id_ed25519.pub
```

If it prints a line starting with `ssh-ed25519`, you have one. If it reports that
the file does not exist (or "No such file or directory"), create the key, then
run the `cat` command again:

```bash
ssh-keygen -t ed25519 -C "r2nette-admin"
```

Press Enter to accept the suggested file, then type a passphrase twice. The
passphrase protects the key if your computer is lost; you type it when you log in.

In the Contabo customer panel, order a **Cloud VPS**:

- 4 GB RAM or more, any region close to your customers.
- Image: **Ubuntu 24.04**.
- Set a strong root password and keep it in your password manager. You need it
  once in step 3, and the server's console in the Contabo panel accepts it if
  SSH ever stops working.
- If the order form lets you add an SSH key, paste the whole `ssh-ed25519 ...`
  line from above. If it does not, step 3 adds the key.

Write down the server's **public IPv4 address**. This guide calls it `SERVER_IP`.

## 3. Bootstrap the server

Log in as root:

```bash
ssh root@SERVER_IP
```

The first time, `ssh` asks whether to trust the server; type `yes`. If it then
logs you in (perhaps after asking for your key's passphrase), your key works:
skip to "On the server" below.

If it asks for **`root@SERVER_IP's password`** instead, your key is not on the
server yet. Press Ctrl+C to cancel, then add the key from your computer. Each of
these two commands asks for the root password:

```bash
scp $HOME/.ssh/id_ed25519.pub root@SERVER_IP:/tmp/admin.pub
ssh root@SERVER_IP "install -d -m 700 /root/.ssh && cat /tmp/admin.pub >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && rm /tmp/admin.pub"
```

(On macOS or Linux, `ssh-copy-id root@SERVER_IP` does the same in one command.)
Log in again with `ssh root@SERVER_IP`. This time it must not ask for the root
password. The SSH hardening at the end of this guide turns root passwords off,
so from now on this key is your way in.

**On the server**, as root:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/takatakca/r2neet.git /root/r2neet
bash /root/r2neet/scripts/deploy/bootstrap-ubuntu.sh
```

The script is safe to run again. It installs Docker and the Compose plugin,
creates the `r2nette` deploy user, creates `/opt/r2nette`, sets up log
rotation, and turns on automatic security updates without automatic reboots.
It **stages** the firewall for SSH, HTTP and HTTPS but leaves it off until a
second SSH login is confirmed. Step 5 does that.

## 4. Create the server settings (`.env`)

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
then redeploy (step 9). Until a service is set, the app runs without it and the
deploy log names what is missing.

Type `exit` to leave the server.

## 5. Let GitHub log in to the server

On **your computer**, create a key used only for deploys. The first command
moves to your home folder, where the key files are saved; run the rest of this
step from the same window:

```bash
cd $HOME
ssh-keygen -t ed25519 -f r2nette_deploy -C github-actions-deploy
```

When it asks for a passphrase, **press Enter twice** without typing anything.
GitHub uses this key with nobody present, so it must not have a passphrase.
You now have two files: `r2nette_deploy` (private) and `r2nette_deploy.pub` (public).

Install the public key for the `r2nette` user. The first command copies it to
the server, the second adds it to the user's allowed keys:

```bash
scp r2nette_deploy.pub root@SERVER_IP:/tmp/r2nette_deploy.pub
ssh root@SERVER_IP "install -d -m 700 -o r2nette -g r2nette /home/r2nette/.ssh && cat /tmp/r2nette_deploy.pub >> /home/r2nette/.ssh/authorized_keys && chown r2nette:r2nette /home/r2nette/.ssh/authorized_keys && chmod 600 /home/r2nette/.ssh/authorized_keys && rm /tmp/r2nette_deploy.pub"
```

Check that it works. It should print `ok` without asking for a password:

```bash
ssh -i r2nette_deploy r2nette@SERVER_IP "docker ps >/dev/null && echo ok"
```

That is the second working login the firewall waits for. Log in as root
(`ssh root@SERVER_IP`) and turn the firewall on, **on the server**:

```bash
touch /etc/r2nette/second-ssh-confirmed
R2NETTE_CONFIRM_FIREWALL=yes bash /root/r2neet/scripts/deploy/bootstrap-ubuntu.sh
```

Type `exit` to leave the server. Back on your computer, read the server's
identity for GitHub:

```bash
ssh-keyscan -t ed25519 SERVER_IP
```

It prints a line that starts with `SERVER_IP ssh-ed25519 AAAA`. Lines starting
with `#` are only comments. Then print the private key:

```bash
cat r2nette_deploy
```

(On Windows, `notepad r2nette_deploy` opens it in Notepad if copying from the
terminal is awkward.)

In GitHub, open the repository, then **Settings → Environments**. The failed run
from step 1 already created an environment named `production`; open it. If it is
not listed, choose **New environment** and name it `production`.
Add these **environment secrets**:

| Secret | Value |
|---|---|
| `CONTABO_SSH_HOST` | `SERVER_IP` |
| `CONTABO_SSH_USER` | `r2nette` |
| `CONTABO_SSH_KEY` | everything `cat r2nette_deploy` printed, from the `-----BEGIN OPENSSH PRIVATE KEY-----` line through the `-----END OPENSSH PRIVATE KEY-----` line |
| `CONTABO_SSH_KNOWN_HOSTS` | the `SERVER_IP ssh-ed25519 AAAA...` line that `ssh-keyscan` printed |
| `CONTABO_SSH_PORT` | optional; only if SSH is not on port 22 |

The known-hosts line pins the server's identity, so a deploy can never be
redirected to another machine.

GitHub now keeps the private key as the `CONTABO_SSH_KEY` secret and will never
show it again. Save a copy of the `r2nette_deploy` file's text in your password
manager, in case the secret ever has to be entered again. Then delete both files
from your computer:

```bash
rm r2nette_deploy
rm r2nette_deploy.pub
```

You log in with your own key from now on; this key is only for GitHub.

## 6. Point the domain at the server (MochaHost)

On MochaHost's standard cPanel zone, email shares the website's address: the
`MX` record (where other servers deliver your mail) names `yourdomain.com`
itself, and `mail` is a `CNAME` (an alias) for `yourdomain.com`. If you only
moved the website's `A` record, incoming mail and your mail apps would follow it
to the VPS, which does not handle email. So give email its own record first, and
move the website last.

In MochaHost **cPanel → Zone Editor**, choose **Manage** on your domain. The
filter buttons above the list (`A`, `CNAME`, `MX`, `TXT`) help you find each record.

**a. Write down MochaHost's address.** Find the `A` record named
`yourdomain.com.`. Its value is MochaHost's server IP. Write it down; this guide
calls it `MOCHAHOST_IP`. **Do not edit it yet.**

**b. Give email its own record**, in this order:

1. **`mail`**: if it is a `CNAME` to `yourdomain.com`, delete it. Then, unless an
   `A` record named `mail` with the value `MOCHAHOST_IP` already exists, add one.
2. **Other mail and cPanel names**: look at `webmail`, `cpanel`, `webdisk`,
   `ftp`, `autodiscover` and `autoconfig`. Any of them that is a `CNAME` to
   `yourdomain.com` gets the same treatment: delete the `CNAME`, add an `A`
   record with the same name and the value `MOCHAHOST_IP`. The rule: every
   `CNAME` that points at `yourdomain.com`, **except `www`**, becomes an `A`
   record to `MOCHAHOST_IP`.
3. **`MX`**: if its destination is `yourdomain.com`, edit it to
   `mail.yourdomain.com` and keep its priority. If it already names
   `mail.yourdomain.com`, leave it.
4. In **cPanel → Email → Email Routing**, select **Local Mail Exchanger** and
   choose **Change**. This keeps MochaHost delivering your mail itself now that
   the `MX` record names `mail.yourdomain.com`.

**c. Check SPF.** Find the `TXT` record that starts with `v=spf1`. If it contains
the word `a` on its own (written `a` or `+a`) and does not already contain
`ip4:MOCHAHOST_IP`, edit it and add `+ip4:MOCHAHOST_IP` just before the final
`~all` or `-all`. For example, `v=spf1 +a +mx ~all` becomes
`v=spf1 +a +mx +ip4:MOCHAHOST_IP ~all`. The `a` means "the website's server may
send our mail", and after this step that server is the VPS. `mx` needs no change,
because the `MX` record now names `mail.yourdomain.com`. Leave DKIM
(`default._domainkey`) and DMARC (`_dmarc`) as they are.

**d. Let the email changes settle.** If you can, wait a few hours before part e.
Other mail servers may remember the old `MX` record for as long as its TTL, shown
in the Zone Editor (often 14400 seconds, which is 4 hours). Mail sent during a
short overlap is delayed, not lost; senders retry. To check the new records:

```bash
nslookup -type=mx yourdomain.com
nslookup mail.yourdomain.com
```

The first should name `mail.yourdomain.com`, the second should answer
`MOCHAHOST_IP`. If they still show the old values, wait and try again.

**e. Now move the website:**

| Type | Name | Value | Action |
|---|---|---|---|
| `A` | `yourdomain.com.` | `SERVER_IP` | **Edit** the existing record |
| `A` | `www.yourdomain.com.` | `SERVER_IP` | Edit, or delete a `www` `CNAME` and add this `A` record |
| `AAAA` | `yourdomain.com.` / `www` | (none) | **Delete** if present; it would still point at MochaHost |

Apart from the changes in parts b and c, **leave** `MX`, `mail`, `webmail`,
`cpanel`, `webdisk`, `ftp`, `autodiscover`, `autoconfig` and the SPF, DKIM and
DMARC `TXT` records alone. They keep your mailboxes working at MochaHost.

If **Domains → Nameservers** shows that the domain does not use MochaHost's
nameservers, make the same edits at the provider those nameservers belong to.

DNS changes take minutes to a few hours. To check, run `nslookup yourdomain.com`;
it should answer with `SERVER_IP`. Then:

- **Test email both ways.** From another account (Gmail, for example) send a
  message to one of your mailboxes, then reply to it from that mailbox. Both
  must arrive; check the spam folder too.
- **Mail apps and webmail.** If a mail app on your phone or computer uses
  `yourdomain.com` itself as its incoming or outgoing server, change it to
  `mail.yourdomain.com`. Open webmail at `https://webmail.yourdomain.com` and
  cPanel at `https://cpanel.yourdomain.com` (or from MochaHost's client area);
  `yourdomain.com/webmail` and `yourdomain.com:2083` now reach the VPS instead.
- cPanel may email you that **AutoSSL** could not renew a certificate for
  `yourdomain.com` and `www`. That is expected, because those names now point
  at the VPS, where Caddy issues their certificates.

## 7. Run the first deploy

In GitHub, open **Actions → Deploy → Run workflow**, keep the branch `main`,
and choose **Run workflow**. It:

1. checks that CI passed on `main`'s latest commit, and stops if it has not
   (if CI is still running, wait for its green check and run it again);
2. builds `ghcr.io/takatakca/r2neet:<sha>` and pushes it;
3. copies the compose file, Caddyfile and deploy scripts to `/opt/r2nette`;
4. runs the production gate against `/opt/r2nette/.env`, refusing weak or missing settings;
5. starts the stack. `migrate` applies the database migrations first;
6. checks `/healthz` and `/readyz` and the running image's revision;
7. rolls back automatically if any check fails.

From now on, every merge to `main` runs the same deploy by itself once CI passes.

Once DNS points at the server, Caddy obtains the HTTPS certificates by itself.
Check from your computer. **On Windows, type `curl.exe` instead of `curl`**:

```bash
curl -sI http://yourdomain.com/healthz                     # 308 to https
curl -sI -X POST http://yourdomain.com/api/v1/auth/phone/send   # 403, never redirected
curl -s  https://yourdomain.com/healthz                    # {"status":"alive",...}
curl -s  https://yourdomain.com/readyz                     # {"status":"ready"}
curl -sI https://www.yourdomain.com/                       # 308 to https://yourdomain.com/
```

## 8. Create the owner account

Log in with your own key (`ssh root@SERVER_IP`), then **on the server** switch to
the deploy user. Running manual commands as `r2nette` keeps the files in
`/opt/r2nette` owned by it:

```bash
su - r2nette
```

Then, still on the server:

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

Run any other manual `docker compose` command through `scripts/deploy/compose.sh`,
as `r2nette` in `/opt/r2nette`. The compose file refuses to start without the
deployed image name, and the wrapper supplies it.

```bash
bash scripts/deploy/compose.sh ps
bash scripts/deploy/compose.sh logs -f web
```

Type `exit` twice to leave: once for `r2nette`, once for the server.

## 9. Everyday use

- **Release:** push or merge to `main`. That is the whole release process.
- **Redeploy without a code change**, for example after editing `.env`:
  use **Actions → Deploy → Run workflow** on `main`. It redeploys the same
  image and keeps the release before it as the rollback target.
- **Roll back** to the previous release (the database is not rolled back). As
  `r2nette` on the server (`ssh root@SERVER_IP`, then `su - r2nette`):

  ```bash
  bash /opt/r2nette/scripts/deploy/rollback.sh
  ```

- **Logs:** each deploy writes a redacted log to `/opt/r2nette/logs/`. For the
  app's logs, run `bash scripts/deploy/compose.sh logs --tail 200 web` as
  `r2nette` in `/opt/r2nette`.

---

## Email: mailboxes at MochaHost, app email through Resend

Your mailboxes, such as `info@yourdomain.com`, stay at MochaHost. Step 6 keeps
them working by giving them their own `mail.yourdomain.com` record.

The app sends booking confirmations and reminders through an **HTTP email
API**, not SMTP. It sends a `POST` with `Authorization: Bearer <key>` and a JSON
body `{from, to, subject, text}`
(`src/notifications/notification-service.ts`). That is exactly the request
Resend accepts:

1. Create a Resend account and **add your domain**. Resend shows a few DNS
   records: a DKIM `TXT` record, plus `MX` and SPF `TXT` records on a `send`
   subdomain. Add them in the MochaHost Zone Editor **alongside** the existing
   records. They live on their own names, so they do not change your domain's
   own `MX` record or its SPF record.
2. When Resend shows the domain as verified, set these in `/opt/r2nette/.env`:

   ```
   EMAIL_API_URL=https://api.resend.com/emails
   EMAIL_API_KEY=re_...
   EMAIL_FROM=R2NETTE <bookings@yourdomain.com>
   ```

3. Redeploy (step 9).

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

Take a dump before the first public request. As `r2nette` on the server:

```bash
cd /opt/r2nette
bash scripts/deploy/compose.sh exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > state/r2nette-initial.dump
```

Then copy it off the server, from your computer:

```bash
scp root@SERVER_IP:/opt/r2nette/state/r2nette-initial.dump .
```

The `backup` service dumps nightly at `BACKUP_AT`. Set `BACKUP_S3_BUCKET`,
`BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY`
so those dumps leave the server. Any S3-compatible storage works (Backblaze B2,
Cloudflare R2, Wasabi), and `BACKUP_S3_ENDPOINT` selects a non-AWS provider.
Without them, backups stay on the same disk as the database. A restore needs both
the dump and `FIELD_ENCRYPTION_KEY`; see `docs/reservation-system/disaster-recovery.md`.

## Later: SSH hardening

Once your own key logs you in as root (step 3) and the deploy key works
(step 5), you can turn off password logins with
`deploy/sshd-hardening.conf.example`. It keeps root login **with a key**
(`PermitRootLogin prohibit-password`), so your own key keeps working; only
passwords stop working. Done before your key works, it can lock you out.

1. Log in as root (`ssh root@SERVER_IP`) and **keep that window open** until the
   end. If something goes wrong, you fix it from there.
2. In a **second** terminal window on your computer, confirm your key logs you in
   with passwords ruled out for the test. It must print `ok` (it may ask for your
   key's passphrase first):

   ```bash
   ssh -o PreferredAuthentications=publickey root@SERVER_IP "echo ok"
   ```

3. In the first window, **on the server**, install the file and restart SSH. The
   `00-` prefix makes it win over a cloud image's own settings file. `sshd -t`
   checks the configuration, and nothing is restarted if it fails:

   ```bash
   git -C /root/r2neet pull
   cp /root/r2neet/deploy/sshd-hardening.conf.example /etc/ssh/sshd_config.d/00-r2nette-hardening.conf
   sshd -t && systemctl restart ssh
   ```

4. In the second window, run the test from item 2 again. Close the first window
   only when it prints `ok`. If it fails, undo the change from the first window:

   ```bash
   rm /etc/ssh/sshd_config.d/00-r2nette-hardening.conf && systemctl restart ssh
   ```

   The next deploy also proves GitHub's key still works; to check right away,
   use **Actions → Deploy → Run workflow**.

## Acceptance checklist

Run this against the live HTTPS domain. Do not send a real charge or a mass SMS.

- [ ] The homepage loads over HTTPS, and `www.` redirects to the bare domain.
- [ ] `/login` shows Login and Sign-up.
- [ ] A real phone receives a sign-in code, so Twilio Verify is set up.
- [ ] Sending a code says the same thing whether or not the number has an account.
- [ ] After the code, an unknown number on Login gets the sign-up guidance, and an existing number on Sign-up gets the login guidance.
- [ ] Completing sign-up creates the customer and signs them in.
- [ ] `/terms` and `/privacy` show the published Terms of Service and Privacy Policy, matching version `2026-09-16`.
- [ ] Signed-out requests to `/account`, `/admin` and `/crew` show no private data.
- [ ] `/healthz` returns alive and `/readyz` returns ready.
- [ ] `billing`, `scheduler` and `backup` are running (`bash scripts/deploy/compose.sh ps`).
- [ ] HTTP GET redirects to HTTPS, and HTTP POST returns 403 without a redirect.
- [ ] Security headers are present, including a script CSP without `unsafe-inline`.
- [ ] `state/current-image-ref` holds the SHA that CI built.
- [ ] A backup exists off the server, or keeping backups on the server is an accepted decision.
- [ ] Email sent to a MochaHost mailbox arrives, and a reply from it arrives too (step 6).

## Things only the owner can do

These need your accounts. They are not in this repository and nobody has done them yet:

1. Merge the deployment pull request (step 1).
2. Order the Contabo VPS and log in with your own SSH key (steps 2–3).
3. Run the bootstrap and create `.env` on the server (steps 3–4).
4. Create the deploy key, the `production` environment and its secrets in GitHub (step 5).
5. Change the DNS records in MochaHost's Zone Editor, email records first (step 6).
6. Create the owner account interactively (step 8).
7. Set up **Twilio Verify** and enter `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
   `TWILIO_VERIFY_SERVICE_SID` in `/opt/r2nette/.env`. Sign-in codes need it;
   without it nobody can sign in.
8. Publish the **Terms of Service and Privacy Policy** at `/terms` and `/privacy`
   before launch. The sign-up form links to both pages and records that each
   customer accepted version `2026-09-16` of them, but those pages are not in this
   repository yet. Provide the text and have the pages added. If the published
   version is dated differently, the recorded version (`TERMS_VERSION` and
   `PRIVACY_VERSION` in `src/api/app.ts`) must be changed to match.
9. Enter the other provider credentials (Stripe, Google Maps, Resend, backup storage) in `/opt/r2nette/.env`.
