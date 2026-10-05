#!/usr/bin/env bash
# One-time bootstrap for a fresh Contabo VPS (Ubuntu 22.04/24.04 or Debian 12).
#
#   ssh root@YOUR_SERVER_IP
#   curl -fsSL https://raw.githubusercontent.com/takatakca/r2neet/main/deploy/server-setup.sh -o setup.sh
#   bash setup.sh
#
# Installs Docker, opens only SSH/HTTP/HTTPS, creates a `deploy` user that the
# GitHub Actions deploy workflow logs in as, and clones the repo to
# /opt/r2nette. Safe to re-run.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/takatakca/r2neet.git}"
APP_DIR="${APP_DIR:-/opt/r2nette}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

echo "==> Updating packages"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw fail2ban

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "==> Deploy user: ${DEPLOY_USER}"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
touch "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh/authorized_keys"

echo "==> Cloning ${REPO_URL} to ${APP_DIR}"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  PGPASS="$(openssl rand -hex 24)"
  FEK="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  {
    echo ""
    echo "# --- Added by deploy/server-setup.sh ---"
    echo "DOMAIN=CHANGE_ME.example"
    echo "ACME_EMAIL="
    echo "POSTGRES_USER=r2nette"
    echo "POSTGRES_PASSWORD=${PGPASS}"
    echo "POSTGRES_DB=r2nette"
    echo "# Makes plain \`docker compose\` include the HTTPS overlay."
    echo "COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml"
  } >> "$APP_DIR/.env"
  # Point the app at the compose Postgres service.
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://r2nette:${PGPASS}@postgres:5432/r2nette#" "$APP_DIR/.env"
  sed -i "s#^PRISMA_DATABASE_URL=.*#PRISMA_DATABASE_URL=postgresql://r2nette:${PGPASS}@postgres:5432/r2nette#" "$APP_DIR/.env"
  sed -i "s#^FIELD_ENCRYPTION_KEY=.*#FIELD_ENCRYPTION_KEY=${FEK}#" "$APP_DIR/.env"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    Created $APP_DIR/.env with a generated database password and encryption key."
  echo "    BACK UP FIELD_ENCRYPTION_KEY somewhere safe: losing it locks out every 2FA account."
fi

cat <<EOF

Done. Next:
  1. Edit $APP_DIR/.env: set DOMAIN and ACME_EMAIL (and Stripe/Twilio keys when ready).
  2. Add the GitHub Actions public key to /home/${DEPLOY_USER}/.ssh/authorized_keys
     (see docs/DEPLOY-CONTABO.md, step 3).
  3. First start:
       su - ${DEPLOY_USER} -c "cd $APP_DIR && docker compose up -d --build"
EOF
