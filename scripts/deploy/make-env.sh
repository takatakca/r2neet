#!/usr/bin/env bash
# Create /opt/r2nette/.env on the server, once, with generated secrets.
#
#   sudo bash scripts/deploy/make-env.sh r2nette.ca you@r2nette.ca
#
# Generates the PostgreSQL password and FIELD_ENCRYPTION_KEY, writes every
# value the production gate requires, and never prints a secret. Refuses to
# overwrite an existing file: the encryption key in it protects two-factor
# secrets and must never be replaced by accident.
set -euo pipefail
umask 077

domain="${1:-}"
email="${2:-}"
target="${ENV_FILE:-/opt/r2nette/.env}"

if [[ -z "$domain" || -z "$email" ]]; then
  echo "Usage: bash scripts/deploy/make-env.sh <domain> <email for certificate notices>" >&2
  echo "Example: bash scripts/deploy/make-env.sh r2nette.ca you@r2nette.ca" >&2
  exit 1
fi
domain="${domain#https://}"
domain="${domain#http://}"
domain="${domain%/}"
domain="${domain#www.}"
if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "That does not look like a domain name: ${domain}" >&2
  exit 1
fi
if [[ ! "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "That does not look like an email address." >&2
  exit 1
fi
if [[ -e "$target" ]]; then
  echo "${target} already exists. Edit it instead; it holds the encryption key." >&2
  exit 1
fi

# URL-safe, no characters that need quoting in a .env file or a URL.
pg_password="$(openssl rand -hex 24)"
encryption_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"

cat > "$target" <<EOF
# R2NETTE production settings. Created by scripts/deploy/make-env.sh.
# Never commit this file or paste its values anywhere.

PRODUCTION_DOMAIN=${domain}
PUBLIC_URL=https://${domain}
ACME_EMAIL=${email}

NODE_ENV=production
TRUST_PROXY=true
REQUIRE_HTTPS=true

POSTGRES_USER=r2nette
POSTGRES_PASSWORD=${pg_password}
POSTGRES_DB=r2nette
DATABASE_URL=postgresql://r2nette:${pg_password}@postgres:5432/r2nette
PRISMA_DATABASE_URL=postgresql://r2nette:${pg_password}@postgres:5432/r2nette

# Encrypts two-factor secrets. Back this up somewhere safe, apart from the
# database backups: without it a restored database locks out every 2FA user.
FIELD_ENCRYPTION_KEY=${encryption_key}

BACKUP_DIR=backups
BACKUP_AT=03:00
BACKUP_KEEP_DAYS=7

# Fill these in as each service is set up (see docs/deployment/contabo-runbook.md).
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_VERIFY_SERVICE_SID=
TWILIO_VOICE_NUMBER=
TWILIO_SMS_NUMBER=
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
GOOGLE_MAPS_API_KEY=
BUSINESS_ORIGIN_LAT=
BUSINESS_ORIGIN_LNG=
EMAIL_API_URL=
EMAIL_API_KEY=
EMAIL_FROM=
BACKUP_S3_BUCKET=
BACKUP_S3_REGION=
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
BACKUP_S3_ENDPOINT=
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_SECRET=
EOF

if id r2nette >/dev/null 2>&1; then
  chown r2nette:r2nette "$target"
fi
chmod 600 "$target"
echo "Wrote ${target} for ${domain}."
echo "Next: copy FIELD_ENCRYPTION_KEY from that file into your password manager."
