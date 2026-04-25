#!/usr/bin/env bash
# Build and (re)start the staging stack on the Pi.
# Run from the repo root: ./deploy-staging.sh
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env.staging ]]; then
  echo "error: .env.staging not found. Copy .env.staging.example and fill it in." >&2
  exit 1
fi

# Pull latest code if this is a git checkout. Skip cleanly otherwise.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
fi

docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build

echo
docker compose -f docker-compose.staging.yml --env-file .env.staging ps
echo
echo "Staging up. Probe: curl -sI https://test.polardev.org/"
