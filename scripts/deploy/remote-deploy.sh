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

if [[ -f state/current-image-ref ]]; then
  cp state/current-image-ref state/previous-image-ref
  chmod 600 state/previous-image-ref
fi

export R2NETTE_IMAGE="$image"
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

docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml run --rm --no-deps \
  -v "${ROOT}/docker-compose.production.yml:/compose.yml:ro" \
  --entrypoint ./node_modules/vite-node/vite-node.mjs \
  web scripts/deploy/validate-production-env.ts /compose.yml

deploy_started=1
docker compose -f docker-compose.production.yml up -d
bash scripts/deploy/healthcheck.sh

cid="$(docker compose -f docker-compose.production.yml ps -q web)"
actual="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$cid")"
if [[ "$actual" != "$SHA" ]]; then
  echo "Running revision does not match the commit that was requested."
  exit 1
fi

printf '%s\n' "$image" > state/current-image-ref
chmod 600 state/current-image-ref
echo "Deploy verified for commit ${SHA}."
