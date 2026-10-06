#!/usr/bin/env bash
# Print which proxy should serve the site on this server:
#   coolify  Coolify's proxy (container coolify-proxy) is running; the web
#            container joins its network (docker-compose.coolify.yml)
#   own      nothing else is on 80/443; start the bundled Caddy
set -euo pipefail

if docker network inspect coolify >/dev/null 2>&1 \
   && [[ "$(docker inspect -f '{{.State.Running}}' coolify-proxy 2>/dev/null)" == "true" ]]; then
  echo coolify
else
  echo own
fi
