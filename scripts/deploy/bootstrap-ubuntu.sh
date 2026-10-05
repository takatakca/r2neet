#!/usr/bin/env bash
# Idempotent Ubuntu bootstrap for the Contabo VPS.
#
# Installs Docker Engine from Docker's repository, creates a non-root deploy
# user, prepares /opt/r2nette, turns on unattended security updates, and
# stages a firewall. It does not disable SSH passwords and it does not enable
# UFW unless a second working SSH session has already been confirmed.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg unattended-upgrades ufw

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

if ! id r2nette >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups docker r2nette
else
  usermod -aG docker r2nette
fi

install -d -o r2nette -g r2nette -m 0750 /opt/r2nette
install -d -o r2nette -g r2nette -m 0700 \
  /opt/r2nette/state \
  /opt/r2nette/logs \
  /opt/r2nette/deploy
install -d -o r2nette -g r2nette -m 0750 /etc/r2nette

if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  }
}
EOF
  if [[ -z "$(docker ps -q)" ]]; then
    systemctl restart docker
  else
    echo "Docker log rotation file was written. Restart Docker when no deploy is in progress so it takes effect."
  fi
else
  echo "Leaving the existing /etc/docker/daemon.json in place."
fi

dpkg-reconfigure -f noninteractive unattended-upgrades
cat > /etc/apt/apt.conf.d/52r2nette-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

# Stage firewall rules without enabling them. Enabling UFW before a second
# SSH session is confirmed can disconnect the only working login.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp

if [[ "${R2NETTE_CONFIRM_FIREWALL:-}" == "yes" && -f /etc/r2nette/second-ssh-confirmed ]]; then
  ufw --force enable
  echo "UFW is enabled for SSH, HTTP, and HTTPS."
else
  echo "UFW rules are staged and the firewall is not enabled."
  echo "After a second SSH session works: touch /etc/r2nette/second-ssh-confirmed"
  echo "Then re-run with R2NETTE_CONFIRM_FIREWALL=yes."
fi

echo "SSH password login was left unchanged."
echo "A later hardening file is deploy/sshd-hardening.conf.example. Do not install it until key login works from a second session."
echo "Bootstrap finished. Docker: $(docker --version). Compose: $(docker compose version)."
