#!/usr/bin/env bash
# GitHub Actions entrypoint for the 'Server admin' workflow.
#
#   TASK=status        containers, health, and the running revision
#   TASK=restart-proxy make the proxy request certificates now (after DNS)
#   TASK=create-owner  create the OWNER staff login. The password comes from
#                      the OWNER_INITIAL_PASSWORD secret over stdin and is
#                      never printed; change it at first sign-in.
#
# The repository is public, so its Actions logs are public: nothing here
# prints a secret, an application log line, or customer data.
set -euo pipefail
umask 077

TASK="${TASK:?TASK is required}"

# shellcheck source=scripts/deploy/ssh-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ssh-common.sh"
ssh_check_login

if [[ "$SSH_LOGIN_USER" == "root" ]]; then
  as_app="runuser -u r2nette -- env HOME=/home/r2nette"
else
  as_app=""
fi

case "$TASK" in
  restart-proxy)
    # The proxy backs off after failed certificate attempts (e.g. before DNS
    # pointed here). Bundled Caddy: restart it. Coolify: recreate only the
    # web container, which makes Coolify's proxy retry for this site without
    # touching the other apps it serves.
    ssh_remote "cd /opt/r2nette && mode=\$(cat state/proxy-mode 2>/dev/null || echo own) \
      && if [ \"\$mode\" = coolify ]; then \
           ${as_app} bash scripts/deploy/compose.sh up -d --force-recreate --no-deps web \
           && echo 'Web container recreated; Coolify proxy will request the HTTPS certificate now.'; \
         else \
           ${as_app} bash scripts/deploy/compose.sh restart caddy \
           && echo 'Caddy restarted; it will request the HTTPS certificates now.'; \
         fi"
    ;;
  status)
    ssh_remote "cd /opt/r2nette && ${as_app} bash scripts/deploy/compose.sh ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' \
      && ${as_app} bash scripts/deploy/healthcheck.sh \
      && echo \"Running image: \$(cat state/current-image-ref 2>/dev/null || echo none)\" \
      && echo \"Proxy: \$(cat state/proxy-mode 2>/dev/null || echo unknown)\""
    ;;
  create-owner)
    OWNER_EMAIL="${OWNER_EMAIL:-}"
    OWNER_NAME="${OWNER_NAME:-}"
    if [[ ! "$OWNER_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
      echo "owner_email is not an email address." >&2
      exit 1
    fi
    if [[ ! "$OWNER_NAME" =~ ^[[:alnum:]\ .\'-]{1,80}$ || "$OWNER_NAME" == *"'"* ]]; then
      echo "owner_name must be letters, spaces, dots or hyphens." >&2
      exit 1
    fi
    if [[ -z "${OWNER_INITIAL_PASSWORD:-}" ]]; then
      echo "Missing required secret name: OWNER_INITIAL_PASSWORD" >&2
      exit 1
    fi
    # The password travels on stdin, then only in the environment (runuser
    # keeps exported variables), never in a command line another account
    # could read with ps. create-staff prints it only when it generated one.
    printf '%s\n' "$OWNER_INITIAL_PASSWORD" | ssh_remote "cd /opt/r2nette && IFS= read -r STAFF_PASSWORD && export STAFF_PASSWORD \
      && ${as_app} bash scripts/deploy/compose.sh exec -T -e STAFF_PASSWORD web \
         npm run --silent staff:create -- --email '${OWNER_EMAIL}' --name '${OWNER_NAME}' --role OWNER"
    echo "Sign in at /admin with ${OWNER_EMAIL} and the password you saved as OWNER_INITIAL_PASSWORD, then change it and turn on two-step verification."
    ;;
  *)
    echo "Unknown task: ${TASK}" >&2
    exit 1
    ;;
esac
