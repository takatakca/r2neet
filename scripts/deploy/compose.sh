#!/usr/bin/env bash
# Run docker compose against the production stack with the image that is
# actually deployed. The compose file refuses to start without R2NETTE_IMAGE,
# so plain `docker compose exec ...` fails on the server; use this instead:
#
#   bash scripts/deploy/compose.sh ps
#   bash scripts/deploy/compose.sh logs -f web
#   bash scripts/deploy/compose.sh exec web npm run staff:create -- ...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${R2NETTE_IMAGE:-}" ]]; then
  R2NETTE_IMAGE="$(cat state/current-image-ref 2>/dev/null || true)"
fi
if [[ -z "$R2NETTE_IMAGE" ]]; then
  echo "No deployed image is recorded in state/current-image-ref yet. Deploy once first." >&2
  exit 1
fi
export R2NETTE_IMAGE

# Which proxy serves the site: Coolify's (when Coolify runs on this server)
# or the bundled Caddy. remote-deploy.sh records the choice in
# state/proxy-mode; R2NETTE_PROXY_MODE overrides it.
mode="${R2NETTE_PROXY_MODE:-$(cat state/proxy-mode 2>/dev/null || true)}"
if [[ -z "$mode" ]]; then
  mode="$(bash scripts/deploy/detect-proxy.sh)"
fi

files=(-f docker-compose.production.yml)
if [[ "$mode" == "coolify" ]]; then
  files+=(-f docker-compose.coolify.yml)
else
  export COMPOSE_PROFILES=own-proxy
fi

exec docker compose "${files[@]}" "$@"
