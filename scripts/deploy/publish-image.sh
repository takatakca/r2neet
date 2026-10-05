#!/usr/bin/env bash
# Build the production image and push it tagged with the full git commit SHA.
# Does not tag :latest and does not log in by printing a token.
set -euo pipefail
umask 077

SHA="${GIT_SHA:?GIT_SHA is required}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "GIT_SHA must be a full 40-character commit id." >&2
  exit 1
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is not set. Refusing to push an image." >&2
  exit 1
fi
if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${GITHUB_ACTOR:-}" ]]; then
  echo "GITHUB_REPOSITORY and GITHUB_ACTOR are required." >&2
  exit 1
fi

owner="$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?}" | tr '[:upper:]' '[:lower:]')"
repo_name="$(printf '%s' "${GITHUB_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]')"
image="ghcr.io/${owner}/${repo_name}"

printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin >/dev/null
docker build \
  --build-arg "GIT_SHA=${SHA}" \
  --label "org.opencontainers.image.revision=${SHA}" \
  -t "${image}:${SHA}" \
  .
docker push "${image}:${SHA}"
echo "Pushed ${image}:${SHA}"
