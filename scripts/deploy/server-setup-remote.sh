#!/usr/bin/env bash
# Runs ON the server, as root, from the files the 'Server setup' workflow
# copied to /root/r2nette-setup. Safe to run again.
#
#   DOMAIN=r2nette.ca ACME_EMAIL=you@r2nette.ca SSH_PORT=22 bash server-setup-remote.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DOMAIN:?DOMAIN is required}"
: "${ACME_EMAIL:?ACME_EMAIL is required}"
SSH_PORT="${SSH_PORT:-22}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

# This script is running over SSH right now, so a second working login is
# proven: let the bootstrap turn the firewall on. Allow the SSH port in use
# first if it is not the standard one.
install -d -m 0750 /etc/r2nette
touch /etc/r2nette/second-ssh-confirmed
if [[ "$SSH_PORT" != "22" ]] && command -v ufw >/dev/null 2>&1; then
  ufw allow "${SSH_PORT}/tcp" >/dev/null
fi
R2NETTE_CONFIRM_FIREWALL=yes bash "${here}/bootstrap-ubuntu.sh"
if [[ "$SSH_PORT" != "22" ]] && command -v ufw >/dev/null 2>&1; then
  ufw allow "${SSH_PORT}/tcp" >/dev/null
fi

if [[ ! -f /opt/r2nette/.env ]]; then
  bash "${here}/make-env.sh" "$DOMAIN" "$ACME_EMAIL"
else
  echo "/opt/r2nette/.env already exists; keeping its generated secrets."
  printf 'PRODUCTION_DOMAIN=%s\nPUBLIC_URL=https://%s\nACME_EMAIL=%s\n' "$DOMAIN" "$DOMAIN" "$ACME_EMAIL" \
    | bash "${here}/set-env.sh" /opt/r2nette/.env
fi

echo "Server setup finished for ${DOMAIN}."
