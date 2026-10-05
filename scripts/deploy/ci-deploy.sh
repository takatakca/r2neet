#!/usr/bin/env bash
# GitHub Actions entrypoint. Copies this commit's deploy files to the VPS
# and runs the remote script. Never prints secret values.
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
require CONTABO_SSH_HOST
require CONTABO_SSH_USER
require CONTABO_SSH_KEY
require CONTABO_SSH_KNOWN_HOSTS
require GHCR_PULL_USER
require GHCR_PULL_TOKEN

if [[ ! "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "GIT_SHA must be a full 40-character commit id." >&2
  exit 1
fi

port="${CONTABO_SSH_PORT:-22}"
owner="$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?}" | tr '[:upper:]' '[:lower:]')"
repo_name="$(printf '%s' "${GITHUB_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]')"

key_file="$(mktemp)"
known_hosts="$(mktemp)"
cleanup() {
  rm -f "$key_file" "$known_hosts"
}
trap cleanup EXIT
printf '%s\n' "$CONTABO_SSH_KEY" > "$key_file"
printf '%s\n' "$CONTABO_SSH_KNOWN_HOSTS" > "$known_hosts"
chmod 600 "$key_file" "$known_hosts"

ssh_base=(
  ssh
  -i "$key_file"
  -p "$port"
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$known_hosts"
  "${CONTABO_SSH_USER}@${CONTABO_SSH_HOST}"
)

"${ssh_base[@]}" "install -d -m 0750 /opt/r2nette"

tar -czf - \
  docker-compose.production.yml \
  deploy/Caddyfile \
  scripts/deploy \
  | "${ssh_base[@]}" "tar -xzf - -C /opt/r2nette"

# Registry login on the VPS uses stdin so the token is not part of the remote command.
printf '%s' "$GHCR_PULL_TOKEN" \
  | "${ssh_base[@]}" "docker login ghcr.io -u '${GHCR_PULL_USER}' --password-stdin >/dev/null"

"${ssh_base[@]}" \
  "IMAGE_SHA='${GIT_SHA}' IMAGE_OWNER='${owner}' IMAGE_NAME='${repo_name}' bash /opt/r2nette/scripts/deploy/remote-deploy.sh"
