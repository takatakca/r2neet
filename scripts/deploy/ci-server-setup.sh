#!/usr/bin/env bash
# GitHub Actions entrypoint for the 'Server setup' workflow.
#
# Logs in to the VPS as root (password or key from GitHub secrets), runs the
# bootstrap, creates /opt/r2nette/.env with generated secrets, and copies any
# provider settings present in the GitHub environment into that .env.
# Safe to run again. Prints names, never values.
set -euo pipefail
umask 077

DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%/}"; DOMAIN="${DOMAIN#www.}"
if [[ ! "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "The domain input is not a domain name." >&2
  exit 1
fi
if [[ ! "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "The email input is not an email address." >&2
  exit 1
fi

SSH_REQUIRE_ROOT=1
SSH_ALLOW_FIRST_CONTACT=1
# shellcheck source=scripts/deploy/ssh-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ssh-common.sh"

echo "Connecting to ${CONTABO_SSH_HOST}:${SSH_PORT} as ${SSH_LOGIN_USER}."
ssh_remote "install -d -m 0700 /root/r2nette-setup && rm -rf /root/r2nette-setup/scripts"
tar -czf - scripts/deploy | ssh_remote "tar -xzf - --no-same-owner -C /root/r2nette-setup"

ssh_remote "DOMAIN='${DOMAIN}' ACME_EMAIL='${ACME_EMAIL}' SSH_PORT='${SSH_PORT}' bash /root/r2nette-setup/scripts/deploy/server-setup-remote.sh"

# Provider settings: copy whichever are set in the GitHub environment.
settings=(
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_VERIFY_SERVICE_SID TWILIO_VOICE_NUMBER TWILIO_SMS_NUMBER
  STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET
  GOOGLE_MAPS_API_KEY BUSINESS_ORIGIN_LAT BUSINESS_ORIGIN_LNG
  GOOGLE_BUSINESS_CLIENT_ID GOOGLE_BUSINESS_CLIENT_SECRET GOOGLE_BUSINESS_REFRESH_TOKEN
  GOOGLE_BUSINESS_ACCOUNT_ID GOOGLE_BUSINESS_LOCATION_ID
  EMAIL_API_URL EMAIL_API_KEY EMAIL_FROM
  BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
  BACKUP_S3_ENDPOINT BACKUP_S3_FORCE_PATH_STYLE BACKUP_S3_PREFIX
  ALERT_WEBHOOK_URL ALERT_WEBHOOK_SECRET
  AI_PROVIDER AI_MODEL AI_API_KEY
)
payload=""
present=()
for name in "${settings[@]}"; do
  value="${!name:-}"
  if [[ -n "$value" ]]; then
    if [[ "$value" == *[[:cntrl:]]* ]]; then
      echo "${name} contains a line break or another control character; skipped. Re-enter that secret." >&2
      continue
    fi
    payload+="${name}=${value}"$'\n'
    present+=("$name")
  fi
done
if [[ ${#present[@]} -gt 0 ]]; then
  echo "Copying provider settings to the server: ${present[*]}"
  printf '%s' "$payload" | ssh_remote "bash /root/r2nette-setup/scripts/deploy/set-env.sh /opt/r2nette/.env"
else
  echo "No provider settings in the GitHub environment yet (Twilio, Stripe, email, ...). The app runs without them."
fi

echo
echo "Server host key (public, safe to share). Deploy and Server admin need it pinned:"
echo "copy the line(s) below into a secret named CONTABO_SSH_KNOWN_HOSTS, or commit them to deploy/known_hosts."
ssh_known_hosts_lines
echo
echo "Server setup complete. Next: pin the host key as above, then run the Deploy workflow."
