#!/usr/bin/env bash
# GitHub Actions entrypoint. Copies this commit's deploy files to the VPS
# and runs the remote script. Never prints secret values.
#
# Logs in with the r2nette deploy key (CONTABO_SSH_KEY) when one is set,
# otherwise as root (CONTABO_ROOT_SSH_KEY or CONTABO_ROOT_PASSWORD) and then
# runs every step as the r2nette user. Either way the containers run as
# r2nette, which owns /opt/r2nette.
set -euo pipefail
umask 077

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required secret name: ${name}" >&2
    exit 1
  fi
}

require GIT_SHA
require GHCR_PULL_USER
require GHCR_PULL_TOKEN

if [[ ! "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "GIT_SHA must be a full 40-character commit id." >&2
  exit 1
fi
if [[ ! "$GHCR_PULL_USER" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "GHCR_PULL_USER is not a GitHub user name." >&2
  exit 1
fi

# shellcheck source=scripts/deploy/ssh-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ssh-common.sh"

owner="$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?}" | tr '[:upper:]' '[:lower:]')"
repo_name="$(printf '%s' "${GITHUB_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]')"

if [[ "$SSH_LOGIN_USER" == "root" ]]; then
  # Run as r2nette with its own HOME, so the registry login lands in its
  # ~/.docker and every file the deploy writes is owned by it.
  as_app="runuser -u r2nette -- env HOME=/home/r2nette"
  ssh_remote "id r2nette >/dev/null 2>&1 || { echo 'The r2nette user does not exist. Run the Server setup workflow first.' >&2; exit 1; }"
  ssh_remote "install -d -m 0750 -o r2nette -g r2nette /opt/r2nette"
  tar -czf - docker-compose.production.yml deploy/Caddyfile scripts/deploy \
    | ssh_remote "${as_app} tar -xzf - --no-same-owner -C /opt/r2nette"
else
  as_app=""
  ssh_remote "install -d -m 0750 /opt/r2nette"
  tar -czf - docker-compose.production.yml deploy/Caddyfile scripts/deploy \
    | ssh_remote "tar -xzf - -C /opt/r2nette"
fi

ssh_remote "test -f /opt/r2nette/.env || { echo '/opt/r2nette/.env is missing. Run the Server setup workflow first.' >&2; exit 1; }"

# Registry login on the VPS uses stdin so the token is not part of the remote command.
printf '%s' "$GHCR_PULL_TOKEN" \
  | ssh_remote "${as_app} docker login ghcr.io -u '${GHCR_PULL_USER}' --password-stdin >/dev/null"

ssh_remote \
  "${as_app} env IMAGE_SHA='${GIT_SHA}' IMAGE_OWNER='${owner}' IMAGE_NAME='${repo_name}' bash /opt/r2nette/scripts/deploy/remote-deploy.sh"
