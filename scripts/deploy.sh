#!/usr/bin/env bash
# Deploy a single app (admin | player) from the monorepo root.
# Switches the active Vercel project link, then runs `vercel --prod`
# from the repo root so the full workspace is uploaded.
set -euo pipefail

APP="${1:-}"
case "$APP" in
  admin|player) ;;
  *)
    echo "usage: scripts/deploy.sh <admin|player> [extra vercel args...]"
    exit 1
    ;;
esac
shift || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.vercel/projects/$APP.json"
DST="$ROOT/.vercel/project.json"

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC — run 'vercel link' for $APP and copy .vercel/project.json into .vercel/projects/$APP.json"
  exit 1
fi

cp "$SRC" "$DST"
cd "$ROOT"
exec vercel --prod "$@"
