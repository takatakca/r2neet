#!/usr/bin/env bash
# Reclaim disk used by obsolete R2NETTE-only images, not by other Coolify apps.
# Safe to run before a pull (while the current release is still serving) or
# after a successful deploy. Do NOT use docker system prune / --volumes.
set -euo pipefail

owner="${1:?GitHub image owner required}"
name="${2:?GitHub image name required}"
target="${3:?Target immutable image required}"
state_dir="${4:-state}"
repo="ghcr.io/${owner}/${name}"

if [[ ! "$owner" =~ ^[a-z0-9._-]+$ || ! "$name" =~ ^[a-z0-9._-]+$ ||
  "${target%:*}" != "$repo" || ! "${target##*:}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Refusing R2NETTE image cleanup with an invalid immutable target." >&2
  exit 1
fi

current="$(cat "$state_dir/current-image-ref" 2>/dev/null || true)"
previous="$(cat "$state_dir/previous-image-ref" 2>/dev/null || true)"
if [[ "${current%:*}" != "$repo" || ! "${current##*:}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "No verified current R2NETTE image ref; skipping image cleanup."
  exit 0
fi
if [[ -n "$previous" && ("${previous%:*}" != "$repo" || ! "${previous##*:}" =~ ^[0-9a-f]{40}$) ]]; then
  echo "Invalid previous image ref; refusing to remove rollback candidates." >&2
  exit 1
fi

echo "Reclaiming old R2NETTE images only (preserving current and rollback)."
removed=0
while IFS= read -r ref; do
  if [[ "${ref%:*}" != "$repo" || ! "${ref##*:}" =~ ^[0-9a-f]{40}$ ]]; then
    continue
  fi
  if [[ "$ref" == "$current" || "$ref" == "$previous" || "$ref" == "$target" ]]; then
    continue
  fi
  # No --force: refuse removal while any container references an image.
  if docker image rm "$ref" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "$repo")
echo "Removed $removed unused old R2NETTE image tags; protected active/rollback and shared images."
