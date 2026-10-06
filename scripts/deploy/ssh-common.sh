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
# Provides: ssh_remote <command>, ssh_check_login, SSH_LOGIN_USER,
# SSH_HOST_KEY_SOURCE (secret, repo or first-contact), ssh_cleanup.

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
  SSH_HOST_KEY_SOURCE=secret
elif [[ -f "$_pinned_file" ]] && grep -qvE '^\s*(#|$)' "$_pinned_file"; then
  grep -vE '^\s*(#|$)' "$_pinned_file" > "$_known_hosts"
  SSH_HOST_KEY_SOURCE=repo
elif [[ "${SSH_ALLOW_FIRST_CONTACT:-}" == "1" ]]; then
  SSH_HOST_KEY_SOURCE=first-contact
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

# Write the private key held in the secret named $1 to $2, repaired from
# common copy-and-paste damage, and make sure ssh can read it. Prints what
# is wrong with it, never the key itself.
_key_secret=""
_write_key() {
  local name="$1" dest="$2" err
  _key_secret="$name"
  printf '%s\n' "${!name}" > "$dest"
  chmod 600 "$dest"
  python3 "${_repo_root}/scripts/deploy/repair-ssh-key.py" "$dest" "$name" || exit 1
  if ! err="$(ssh-keygen -y -P '' -f "$dest" 2>&1 >/dev/null)"; then
    if [[ "$err" == *passphrase* ]]; then
      echo "${name} is protected by a passphrase; the workflows need a key without one." >&2
    else
      echo "${name} still cannot be read as a private key: part of it is probably missing. Copy it again, the whole block from -----BEGIN to -----END." >&2
    fi
    exit 1
  fi
}

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
  _write_key CONTABO_SSH_KEY "${_ssh_dir}/key"
  _ssh_opts+=(-i "${_ssh_dir}/key" -o BatchMode=yes -o IdentitiesOnly=yes)
elif [[ -n "${CONTABO_ROOT_SSH_KEY:-}" ]]; then
  SSH_LOGIN_USER=root
  _write_key CONTABO_ROOT_SSH_KEY "${_ssh_dir}/key"
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
export SSH_LOGIN_USER SSH_HOST_KEY_SOURCE

# Run a command on the server. stdin is passed through.
ssh_remote() {
  "${_ssh_prefix[@]}" ssh "${_ssh_opts[@]}" "${SSH_LOGIN_USER}@${CONTABO_SSH_HOST}" "$@"
}

# Log in once and explain the common failures in plain words.
ssh_check_login() {
  local err
  if err="$(ssh_remote true </dev/null 2>&1)"; then
    return 0
  fi
  printf '%s\n' "$err" >&2
  if [[ "$err" == *"REMOTE HOST IDENTIFICATION HAS CHANGED"* || "$err" == *"Host key verification failed"* ]]; then
    echo "The server's identity key does not match the pinned one (deploy/known_hosts or CONTABO_SSH_KNOWN_HOSTS). If the server was reinstalled, update the pin; otherwise do not continue." >&2
  elif [[ "$err" == *"Permission denied (publickey)"* && -n "$_key_secret" ]]; then
    # The fingerprint identifies the public half of the key; it is safe to
    # print and lets the owner compare it with the server's authorized_keys.
    echo "The server did not accept the key in ${_key_secret} for ${SSH_LOGIN_USER}. Its public fingerprint is:" >&2
    ssh-keygen -l -f "${_ssh_dir}/key" | awk '{print "  " $2 " " $NF}' >&2
    echo "Compare it with the server's: ssh-keygen -lf /root/.ssh/authorized_keys (e.g. in Coolify's Terminal for this server)." >&2
  elif [[ "$err" == *"Permission denied (publickey)"* ]]; then
    echo "The server accepts SSH keys only. Put a private key that the server's root account accepts into the CONTABO_ROOT_SSH_KEY secret (on a Coolify server: Keys & Tokens > Private Keys > localhost's key)." >&2
  elif [[ "$err" == *"Permission denied"* ]]; then
    echo "The server refused the login. Check the CONTABO_ROOT_SSH_KEY / CONTABO_ROOT_PASSWORD / CONTABO_SSH_KEY secret." >&2
  fi
  return 1
}

# The host keys this connection trusts, for pinning.
ssh_known_hosts_lines() {
  cat "$_known_hosts"
}
