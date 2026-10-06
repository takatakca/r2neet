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
# Runs unattended over SSH too (the Server setup workflow): wait for a fresh
# server's own apt run to release the lock instead of failing, and keep
# existing config files instead of stopping at a dpkg prompt.
apt_opts=(-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# A server that already runs Coolify hosts other apps: leave its packages,
# Docker and firewall as Coolify set them. A full upgrade could restart
# Docker (and every app on it), and the firewall must keep Coolify's own
# ports open.
coolify_host=0
if [[ -d /data/coolify ]] \
   || { command -v docker >/dev/null 2>&1 && docker network inspect coolify >/dev/null 2>&1; }; then
  coolify_host=1
  echo "Coolify runs on this server: skipping the package upgrade and the firewall."
fi

apt-get "${apt_opts[@]}" update
if [[ "$coolify_host" -eq 0 ]]; then
  apt-get "${apt_opts[@]}" upgrade -y
  apt-get "${apt_opts[@]}" install -y ca-certificates curl gnupg unattended-upgrades ufw
else
  apt-get "${apt_opts[@]}" install -y --no-upgrade ca-certificates curl gnupg unattended-upgrades
fi

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get "${apt_opts[@]}" update
  apt-get "${apt_opts[@]}" install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
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

if [[ "$coolify_host" -eq 1 ]]; then
  echo "Firewall left unchanged (Coolify server)."
else
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
fi

echo "SSH password login was left unchanged."
echo "A later hardening file is deploy/sshd-hardening.conf.example. Do not install it until key login works from a second session."
echo "Bootstrap finished. Docker: $(docker --version). Compose: $(docker compose version)."
