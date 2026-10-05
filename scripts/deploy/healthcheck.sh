#!/usr/bin/env bash
# Confirm the running web container answers liveness and readiness.
# Prints status codes only. Does not print response bodies or environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed on this machine." >&2
  exit 1
fi

# compose.sh supplies R2NETTE_IMAGE from state/ when the caller has not.
cid="$(bash scripts/deploy/compose.sh ps -q web)"
if [[ -z "$cid" ]]; then
  echo "web container is not running." >&2
  exit 1
fi

docker exec "$cid" node --input-type=module -e '
const port = process.env.PORT || "3000";
for (const path of ["/healthz", "/readyz"]) {
  let res;
  try {
    res = await fetch("http://127.0.0.1:" + port + path);
  } catch {
    console.error(path + " failed");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(path + " returned " + res.status);
    process.exit(1);
  }
  console.log(path + " ok");
}
'
