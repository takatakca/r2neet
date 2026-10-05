#!/usr/bin/env bash
# Shared SSH plumbing for the GitHub Actions deploy scripts. Source it; do
# not run it. Never prints a secret.
#
# Inputs (environment):
#   CONTABO_SSH_HOST         server IP or hostname (required)
#   CONTABO_SSH_PORT         default 22
#   CONTABO_SSH_KEY          deploy key for the r2nette user (optional)
#   CONTABO_SSH_USER         user for CONTABO_SSH_KEY, default r2nette
#   CONTABO_ROOT_SSH_KEY     root's private key (optional)
#   CONTABO_ROOT_PASSWORD    root's password, used through sshpass (optional)
#   CONTABO_SSH_KNOWN_HOSTS  pinned host key line(s) (optional; otherwise
#                            deploy/known_hosts in the repo is used)
#   SSH_REQUIRE_ROOT=1       refuse the r2nette key; setup needs root
#   SSH_ALLOW_FIRST_CONTACT=1  with no pinned key, trust the key the server
#                            presents now (first setup only) and print it
#
# Provides: ssh_remote <command>, SSH_LOGIN_USER, ssh_cleanup.

set -euo pipefail
umask 077

if [[ -z "${CONTABO_SSH_HOST:-}" ]]; then
  echo "Missing required secret name: CONTABO_SSH_HOST" >&2
  exit 1
fi
SSH_PORT="${CONTABO_SSH_PORT:-22}"
if [[ ! "$SSH_PORT" =~ ^[0-9]{1,5}$ ]]; then
  echo "CONTABO_SSH_PORT must be a number." >&2
  exit 1
fi

_ssh_dir="$(mktemp -d)"
ssh_cleanup() { rm -rf "$_ssh_dir"; }
trap ssh_cleanup EXIT

_known_hosts="${_ssh_dir}/known_hosts"
_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# deploy/known_hosts pins the server's public host keys. Its lines use the
# host pattern "*" because the server address is a secret, masked in logs;
# ssh still refuses any server that does not present one of these keys.
_pinned_file="${_repo_root}/deploy/known_hosts"

if [[ -n "${CONTABO_SSH_KNOWN_HOSTS:-}" ]]; then
  printf '%s\n' "$CONTABO_SSH_KNOWN_HOSTS" > "$_known_hosts"
elif [[ -f "$_pinned_file" ]] && grep -qvE '^\s*(#|$)' "$_pinned_file"; then
  grep -vE '^\s*(#|$)' "$_pinned_file" > "$_known_hosts"
elif [[ "${SSH_ALLOW_FIRST_CONTACT:-}" == "1" ]]; then
  ssh-keyscan -p "$SSH_PORT" -t ed25519,ecdsa,rsa "$CONTABO_SSH_HOST" 2>/dev/null \
    | awk '!/^#/ && NF >= 3 { $1 = "*"; print }' > "$_known_hosts" || true
  if [[ ! -s "$_known_hosts" ]]; then
    echo "Could not reach the server on port ${SSH_PORT} over SSH." >&2
    exit 1
  fi
  echo "First contact with the server. Its public host keys, to pin in deploy/known_hosts:"
  sed 's/^/  /' "$_known_hosts"
else
  echo "No pinned host key. Run the 'Server setup' workflow, then copy the host key line(s) it prints into a secret named CONTABO_SSH_KNOWN_HOSTS (or commit them to deploy/known_hosts)." >&2
  exit 1
fi

_ssh_opts=(
  -p "$SSH_PORT"
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$_known_hosts"
  -o ConnectTimeout=20
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=10
)
_ssh_prefix=()

if [[ -n "${CONTABO_SSH_KEY:-}" && "${SSH_REQUIRE_ROOT:-}" != "1" ]]; then
  SSH_LOGIN_USER="${CONTABO_SSH_USER:-r2nette}"
  printf '%s\n' "$CONTABO_SSH_KEY" > "${_ssh_dir}/key"
  chmod 600 "${_ssh_dir}/key"
  _ssh_opts+=(-i "${_ssh_dir}/key" -o BatchMode=yes -o IdentitiesOnly=yes)
elif [[ -n "${CONTABO_ROOT_SSH_KEY:-}" ]]; then
  SSH_LOGIN_USER=root
  printf '%s\n' "$CONTABO_ROOT_SSH_KEY" > "${_ssh_dir}/key"
  chmod 600 "${_ssh_dir}/key"
  _ssh_opts+=(-i "${_ssh_dir}/key" -o BatchMode=yes -o IdentitiesOnly=yes)
elif [[ -n "${CONTABO_ROOT_PASSWORD:-}" ]]; then
  SSH_LOGIN_USER=root
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "sshpass is needed for password login." >&2
    exit 1
  fi
  # sshpass -e reads SSHPASS from the environment, never from argv.
  export SSHPASS="$CONTABO_ROOT_PASSWORD"
  _ssh_prefix=(sshpass -e)
  # shellcheck disable=SC2054 # the comma is inside one ssh option value
  _ssh_opts+=(
    -o PreferredAuthentications=password,keyboard-interactive
    -o PubkeyAuthentication=no
    -o NumberOfPasswordPrompts=1
  )
else
  if [[ "${SSH_REQUIRE_ROOT:-}" == "1" ]]; then
    echo "Missing required secret name: CONTABO_ROOT_PASSWORD (or CONTABO_ROOT_SSH_KEY)" >&2
  else
    echo "Missing required secret name: CONTABO_ROOT_PASSWORD (or CONTABO_ROOT_SSH_KEY, or CONTABO_SSH_KEY)" >&2
  fi
  exit 1
fi
export SSH_LOGIN_USER

# Run a command on the server. stdin is passed through.
ssh_remote() {
  "${_ssh_prefix[@]}" ssh "${_ssh_opts[@]}" "${SSH_LOGIN_USER}@${CONTABO_SSH_HOST}" "$@"
}

# The host keys this connection trusts, for pinning.
ssh_known_hosts_lines() {
  cat "$_known_hosts"
}
