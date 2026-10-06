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

# A container that has just started may need a few seconds before the
# database answers; wait up to HEALTH_WAIT_SECONDS (default 90) for both
# probes. Prints status words only (e.g. "not_ready (database)").
docker exec -e HEALTH_WAIT_MS="$(( ${HEALTH_WAIT_SECONDS:-90} * 1000 ))" "$cid" node --input-type=module -e '
const port = process.env.PORT || "3000";
const deadline = Date.now() + Number(process.env.HEALTH_WAIT_MS || 90000);
const probe = async (path) => {
  try {
    const res = await fetch("http://127.0.0.1:" + port + path);
    let word = "";
    try {
      const body = await res.json();
      word = [body.status, body.reason].filter((v) => typeof v === "string").join(" ");
    } catch {}
    return { ok: res.ok, detail: res.status + (word ? " (" + word + ")" : "") };
  } catch {
    return { ok: false, detail: "no answer" };
  }
};
for (const path of ["/healthz", "/readyz"]) {
  let result = await probe(path);
  while (!result.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await probe(path);
  }
  if (!result.ok) {
    console.error(path + " returned " + result.detail);
    process.exit(1);
  }
  console.log(path + " ok");
}
'
