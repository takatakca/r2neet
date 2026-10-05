#!/usr/bin/env bash
# Start the previously recorded immutable image again.
# Does not roll database migrations backward.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

previous="$(cat state/previous-image-ref 2>/dev/null || true)"
if [[ -z "$previous" ]]; then
  echo "No previous image is recorded. Refusing to guess a rollback target." >&2
  exit 1
fi
if [[ ! "$previous" =~ ^ghcr\.io/[a-z0-9._/-]+:[0-9a-f]{40}$ ]]; then
  echo "Previous image ref is not an immutable registry tag. Refusing to roll back." >&2
  exit 1
fi

echo "Rolling back to ${previous}"
export R2NETTE_IMAGE="$previous"
# The deploy job's registry login expires when the job ends, so a manual
# rollback cannot count on pulling. Pull only when the image is not on disk.
if ! docker image inspect "$previous" >/dev/null 2>&1; then
  docker compose -f docker-compose.production.yml pull
fi
docker compose -f docker-compose.production.yml up -d
bash scripts/deploy/healthcheck.sh
mkdir -p state
chmod 700 state
printf '%s\n' "$previous" > state/current-image-ref
chmod 600 state/current-image-ref
echo "Rollback complete."
