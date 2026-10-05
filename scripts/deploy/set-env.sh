#!/usr/bin/env bash
# Set values in the server's .env from KEY=VALUE lines on stdin.
#
#   printf 'STRIPE_SECRET_KEY=%s\n' "$value" | sudo bash set-env.sh /opt/r2nette/.env
#
# Values arrive on stdin so they never appear in a command line or a process
# list. Only the names below may be set; generated secrets (database
# password, FIELD_ENCRYPTION_KEY) are never overwritten from here. Prints
# names only.
set -euo pipefail
umask 077

target="${1:-/opt/r2nette/.env}"
if [[ ! -f "$target" ]]; then
  echo "${target} does not exist. Run make-env.sh first." >&2
  exit 1
fi

# The program goes in -c so that stdin stays free for the KEY=VALUE lines.
program="$(cat <<'PY'
import os, re, sys, tempfile

ALLOWED = {
    "PRODUCTION_DOMAIN", "PUBLIC_URL", "ACME_EMAIL",
    "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID",
    "TWILIO_VOICE_NUMBER", "TWILIO_SMS_NUMBER",
    "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET",
    "GOOGLE_MAPS_API_KEY", "BUSINESS_ORIGIN_LAT", "BUSINESS_ORIGIN_LNG",
    "GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET",
    "GOOGLE_BUSINESS_REFRESH_TOKEN", "GOOGLE_BUSINESS_ACCOUNT_ID", "GOOGLE_BUSINESS_LOCATION_ID",
    "EMAIL_API_URL", "EMAIL_API_KEY", "EMAIL_FROM",
    "BACKUP_S3_BUCKET", "BACKUP_S3_REGION", "BACKUP_S3_ACCESS_KEY_ID",
    "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_S3_ENDPOINT", "BACKUP_S3_FORCE_PATH_STYLE", "BACKUP_S3_PREFIX",
    "ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_SECRET",
    "AI_PROVIDER", "AI_MODEL", "AI_API_KEY", "AI_PROVIDER_API_KEY",
}
PLAIN = re.compile(r"^[A-Za-z0-9_./:@+=,%-]*$")

def encode(name, value):
    if PLAIN.match(value):
        return value
    if "'" in value:
        sys.exit(f"{name}: the value contains a single quote, which a .env file cannot hold safely.")
    # Single quotes: docker compose reads the value literally.
    return f"'{value}'"

updates = {}
for raw in sys.stdin.read().splitlines():
    if not raw.strip():
        continue
    name, sep, value = raw.partition("=")
    name = name.strip()
    if not sep or name not in ALLOWED:
        sys.exit(f"Refusing to set {name or '(blank)'}: not an allowed setting.")
    updates[name] = encode(name, value.strip())

if not updates:
    print("No settings to change.")
    sys.exit(0)

target = sys.argv[1]
with open(target, encoding="utf-8") as f:
    lines = f.read().splitlines()

seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        if key in seen:
            continue  # drop duplicates of a key we are setting
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
for key in updates:
    if key not in seen:
        out.append(f"{key}={updates[key]}")

st = os.stat(target)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".env.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
os.chmod(tmp, 0o600)
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, target)
print("Updated: " + ", ".join(sorted(updates)))
PY
)"
python3 -c "$program" "$target"
