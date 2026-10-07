#!/usr/bin/env bash
# Run on the VPS, from the files checked out for one commit.
# Replaces the running image only after health and revision checks pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SHA="${IMAGE_SHA:-${1:-}}"
if [[ "${1:-}" == "--preflight" ]]; then
  SHA="${IMAGE_SHA:-${2:-}}"
fi

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Refusing to deploy without a full 40-character git commit SHA." >&2
  exit 1
fi

image_owner="${IMAGE_OWNER:-}"
image_name="${IMAGE_NAME:-}"
if [[ -z "$image_owner" || -z "$image_name" ]]; then
  echo "IMAGE_OWNER and IMAGE_NAME are required." >&2
  exit 1
fi
image="ghcr.io/${image_owner}/${image_name}:${SHA}"

if [[ "${1:-}" == "--preflight" ]]; then
  [[ -f docker-compose.production.yml ]]
  [[ -f deploy/Caddyfile ]]
  [[ -f scripts/deploy/healthcheck.sh ]]
  [[ -f scripts/deploy/rollback.sh ]]
  [[ -f scripts/deploy/check-production-env.ts ]]
  [[ -f docker-compose.coolify.yml ]]
  [[ -f scripts/deploy/detect-proxy.sh ]]
  echo "preflight ok for ${SHA}"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed on this machine." >&2
  exit 1
fi

mkdir -p state logs
chmod 700 state logs
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="logs/deploy-${stamp}.log"
exec > >(bash scripts/deploy/redact-stream.sh | tee -a "$log") 2>&1

echo "Deploying commit ${SHA}"

export R2NETTE_IMAGE="$image"

# Settings written before the database got its unique name point the app at
# "postgres", which on a Coolify server can reach Coolify's own database.
# Rewrite only the host part; the values are never printed.
if [[ -f .env ]] && grep -qE '^(DATABASE_URL|PRISMA_DATABASE_URL)=[^@]*@postgres:5432/' .env; then
  sed -i -E 's#^((DATABASE_URL|PRISMA_DATABASE_URL)=[^@]*@)postgres:5432/#\1r2nette-db:5432/#' .env
  echo "Pointed the database address in .env at r2nette-db."
fi

# Coolify already runs a proxy on 80/443: sit behind it rather than start a
# second one. Recorded so compose.sh, rollback and manual commands agree.
proxy_mode="$(bash scripts/deploy/detect-proxy.sh)"
if [[ "$proxy_mode" == "coolify" ]]; then
  echo "Coolify's proxy runs on this server: the site is served through it."
fi
printf '%s\n' "$proxy_mode" > state/proxy-mode
chmod 600 state/proxy-mode
export R2NETTE_PROXY_MODE="$proxy_mode"
compose=(bash scripts/deploy/compose.sh)
deploy_started=0
rolled_back=0

finish() {
  local status=$?
  if [[ "$status" -ne 0 && "$deploy_started" -eq 1 && "$rolled_back" -eq 0 ]]; then
    rolled_back=1
    echo "Verification failed. Starting automatic rollback."
    if ! bash scripts/deploy/rollback.sh; then
      echo "Rollback failed. The previous image ref, when one existed, is in state/previous-image-ref."
    fi
  fi
  exit "$status"
}
trap finish EXIT

pull_attempt=1
until "${compose[@]}" pull; do
  if [[ "$pull_attempt" -ge 3 ]]; then
    echo "Image pull failed after ${pull_attempt} attempts." >&2
    exit 1
  fi
  delay=$((pull_attempt * 5))
  echo "Image pull failed; retrying in ${delay}s (${pull_attempt}/3)."
  sleep "$delay"
  pull_attempt=$((pull_attempt + 1))
done
# The one-off check container gets no proxy routing labels (own mode), so
# Coolify's proxy never sends visitors to it.
R2NETTE_PROXY_MODE=own "${compose[@]}" run --rm --no-deps \
  -v "${ROOT}/docker-compose.production.yml:/compose.yml:ro" \
  --entrypoint ./node_modules/vite-node/vite-node.mjs \
  web scripts/deploy/check-production-env.ts /compose.yml

# Caddy bind-mounts the single file deploy/Caddyfile. Unpacking a new one
# replaces the file, but a running container keeps reading the old one, and
# `up -d` leaves caddy alone because its compose config did not change. So
# recreate caddy whenever the file differs from the one last deployed, after
# checking that the new file is valid.
caddyfile_hash="$(sha256sum deploy/Caddyfile | cut -d ' ' -f 1)"
caddyfile_applied="$(cat state/caddyfile.sha256 2>/dev/null || true)"
caddy_changed=0
if [[ "$proxy_mode" == "own" && "$caddyfile_hash" != "$caddyfile_applied" ]]; then
  caddy_changed=1
  "${compose[@]}" run --rm --no-deps caddy \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi

# Rotate the rollback target only when the image changes. Redeploying the
# same commit (for example after editing .env) keeps the real previous release.
current="$(cat state/current-image-ref 2>/dev/null || true)"
if [[ -n "$current" && "$current" != "$image" ]]; then
  printf '%s\n' "$current" > state/previous-image-ref
  chmod 600 state/previous-image-ref
fi

deploy_started=1
"${compose[@]}" up -d
if [[ "$caddy_changed" -eq 1 ]]; then
  echo "deploy/Caddyfile changed. Recreating caddy so it reads the new file."
  "${compose[@]}" up -d --force-recreate --no-deps caddy
fi
bash scripts/deploy/healthcheck.sh

cid="$("${compose[@]}" ps -q web)"
actual="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$cid")"
if [[ "$actual" != "$SHA" ]]; then
  echo "Running revision does not match the commit that was requested."
  exit 1
fi

printf '%s\n' "$image" > state/current-image-ref
chmod 600 state/current-image-ref
printf '%s\n' "$caddyfile_hash" > state/caddyfile.sha256
chmod 600 state/caddyfile.sha256
echo "Deploy verified for commit ${SHA}."

# Every deploy pulls a new SHA-tagged image. Keep the running one and the
# rollback target; remove older ones so the disk does not fill up.
keep_previous="$(cat state/previous-image-ref 2>/dev/null || true)"
docker image ls --format '{{.Repository}}:{{.Tag}}' "ghcr.io/${image_owner}/${image_name}" \
  | while read -r old; do
      if [[ "$old" != "$image" && "$old" != "$keep_previous" ]]; then
        docker image rm "$old" >/dev/null 2>&1 || true
      fi
    done
