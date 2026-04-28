#!/usr/bin/env bash
# Push env vars from ../../player/.env.local to admin's Vercel project for all 3 environments.
# Skips PostHog (player-only), URL vars (set after first deploy), and Vercel-managed vars.
# Run from apps/admin/. Run once. Re-running will fail on existing vars — use `vercel env rm` first if you need to overwrite.

set -euo pipefail

SOURCE_ENV="../player/.env.local"
[[ -f "$SOURCE_ENV" ]] || { echo "missing $SOURCE_ENV"; exit 1; }

# Vars admin should NOT inherit (PostHog is player-only; URLs need post-deploy values; OIDC is Vercel-managed)
SKIP=(
  NEXT_PUBLIC_POSTHOG_KEY
  NEXT_PUBLIC_POSTHOG_HOST
  NEXT_PUBLIC_APP_URL
  NEXT_PUBLIC_PLAYER_URL
  NEXT_PUBLIC_ADMIN_URL
  VERCEL_OIDC_TOKEN
)

is_skipped() {
  local k="$1"
  for s in "${SKIP[@]}"; do [[ "$k" == "$s" ]] && return 0; done
  return 1
}

while IFS= read -r line || [[ -n "$line" ]]; do
  # strip comments and blanks
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  # split KEY=VALUE on first =
  key="${line%%=*}"
  val="${line#*=}"
  key="${key// }"  # trim spaces
  is_skipped "$key" && { echo "skip $key"; continue; }
  for env in production preview development; do
    echo "+ $key  ($env)"
    printf '%s' "$val" | vercel env add "$key" "$env" >/dev/null 2>&1 \
      && echo "  ok" \
      || echo "  FAILED (already exists? check: vercel env ls $env)"
  done
done < "$SOURCE_ENV"

echo
echo "Done. Verify with: vercel env ls production"
echo "Next: deploy with 'vercel --prod', then come back to set NEXT_PUBLIC_*_URL with the new admin URL."
