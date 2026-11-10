#!/usr/bin/env bash
# Copy the built login page into the already-running web container.
# This does not pull an image. The full deploy cannot, because the Contabo
# disk has no room for another image layer. Only these three files change:
#   /app/dist/auth.html
#   /app/dist/assets/auth-phone-format.js
#   /app/dist/assets/auth-phone-format.css
# /login is not cached by the service worker, and the script name is new, so
# browsers fetch the formatter instead of a cached copy of the old file.
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [[ ! -f dist/auth.html ]]; then
  echo "dist/auth.html is missing. Run npm run build first." >&2
  exit 1
fi

js=""
css=""
for candidate in dist/assets/auth-*.js; do
  [[ -f "${candidate}" && "${candidate}" != *auth-phone-format.js ]] || continue
  js="${candidate}"
  break
done
for candidate in dist/assets/auth-*.css; do
  [[ -f "${candidate}" && "${candidate}" != *auth-phone-format.css ]] || continue
  css="${candidate}"
  break
done
if [[ -z "${js}" || -z "${css}" ]]; then
  echo "The login build did not produce an auth script and stylesheet." >&2
  exit 1
fi
if ! grep -q '825-2825' "${js}"; then
  echo "The built login script does not contain the Canadian phone format." >&2
  exit 1
fi

stage="$(mktemp -d)"
mkdir -p "${stage}/assets"
cp "${js}" "${stage}/assets/auth-phone-format.js"
cp "${css}" "${stage}/assets/auth-phone-format.css"
python3 - "${stage}" <<'PY'
import re, sys
from pathlib import Path
stage = Path(sys.argv[1])
html = Path("dist/auth.html").read_text(encoding="utf-8")
html = re.sub(r"/assets/auth-[^\"']+\.js", "/assets/auth-phone-format.js", html)
html = re.sub(r"/assets/auth-[^\"']+\.css", "/assets/auth-phone-format.css", html)
if "auth-phone-format.js" not in html or "auth-phone-format.css" not in html:
    raise SystemExit("Could not point auth.html at the phone-format assets.")
(stage / "auth.html").write_text(html, encoding="utf-8")
PY
# The web process is not root. A private file copied into the container
# makes /login return 500, so these must be world-readable.
chmod 644 "${stage}/auth.html" "${stage}/assets/auth-phone-format.js" "${stage}/assets/auth-phone-format.css"

# shellcheck source=scripts/deploy/ssh-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ssh-common.sh"
ssh_check_login

if [[ "$SSH_AS_ROOT" == "1" ]]; then
  as_app="runuser -u r2nette -- env HOME=/home/r2nette"
else
  as_app=""
fi

ssh_remote "${as_app} mkdir -p /tmp/r2nette-login-format"
tar -czf - -C "${stage}" auth.html assets \
  | ssh_remote "${as_app} tar -xzf - -C /tmp/r2nette-login-format"

remote='set -eu
ids=$(docker ps -q --filter label=com.docker.compose.project=r2nette --filter label=com.docker.compose.service=web)
if [ -z "$ids" ]; then
  echo "No running r2nette web container." >&2
  exit 1
fi
for cid in $ids; do
  docker cp /tmp/r2nette-login-format/auth.html "$cid:/app/dist/auth.html"
  docker cp /tmp/r2nette-login-format/assets/auth-phone-format.js "$cid:/app/dist/assets/auth-phone-format.js"
  docker cp /tmp/r2nette-login-format/assets/auth-phone-format.css "$cid:/app/dist/assets/auth-phone-format.css"
  docker exec -u 0 "$cid" chmod 644 \
    /app/dist/auth.html \
    /app/dist/assets/auth-phone-format.js \
    /app/dist/assets/auth-phone-format.css
done
rm -rf /tmp/r2nette-login-format
echo "Login phone format copied into the running web container."'

ssh_remote "${as_app} bash -c $(_sh_quote "$remote")"

if ! curl -fsS -H 'Cache-Control: no-cache' https://r2nette.ca/login | grep -q 'auth-phone-format.js'; then
  echo "The public login page is not serving the new script yet." >&2
  exit 1
fi
if ! curl -fsS -H 'Cache-Control: no-cache' https://r2nette.ca/assets/auth-phone-format.js | grep -q '825-2825'; then
  echo "The public login script does not contain the phone format." >&2
  exit 1
fi
echo "https://r2nette.ca/login is serving the formatted phone field."
