#!/usr/bin/env bash
# prod-to-dev-snapshot.sh
#
# Online dump of prod Supabase Postgres (54322) into the dev Supabase
# Postgres (64322), no prod downtime. pg_dump uses MVCC; concurrent
# writes during the snapshot are tolerated.
#
# Scope:
#   - public schema (full clean+recreate)  — all app data
#   - auth.users + auth.identities         — keeps player.user_id FKs valid
# Skipped: prod auth sessions/refresh_tokens/etc — staging gets fresh sessions.
#
# Idempotent. Safe to re-run. Existing dev DB rows in those scopes are wiped.
#
# Usage:
#   ./prod-to-dev-snapshot.sh
#
# Cron (4am daily):
#   0 4 * * * /home/polarbaejr/ssd/Deploy/badminton/scripts/prod-to-dev-snapshot.sh \
#     >> /home/polarbaejr/ssd/Deploy/badminton-snapshots/cron.log 2>&1
set -euo pipefail

PROD_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
DEV_DB="postgresql://postgres:postgres@127.0.0.1:64322/postgres"
OUT_DIR="${HOME}/ssd/Deploy/badminton-snapshots"
TS=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$OUT_DIR"

PUBLIC_DUMP="$OUT_DIR/public-$TS.sql.gz"
AUTH_DUMP="$OUT_DIR/auth-$TS.sql.gz"

echo "[$(date -u +%FT%TZ)] dumping prod public..."
pg_dump "$PROD_DB" \
  --schema=public \
  --clean --if-exists \
  --quote-all-identifiers \
  --no-owner --no-acl \
  | gzip > "$PUBLIC_DUMP"

echo "[$(date -u +%FT%TZ)] dumping prod auth users/identities..."
pg_dump "$PROD_DB" \
  --table=auth.users \
  --table=auth.identities \
  --data-only --column-inserts \
  --no-owner --no-acl \
  | gzip > "$AUTH_DUMP"

echo "[$(date -u +%FT%TZ)] truncating dev auth users (cascades to identities and to public via FKs)..."
psql "$DEV_DB" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE auth.identities CASCADE;
TRUNCATE auth.users CASCADE;
SQL

echo "[$(date -u +%FT%TZ)] restoring auth users into dev..."
gunzip -c "$AUTH_DUMP" | psql "$DEV_DB" -v ON_ERROR_STOP=1 -q

echo "[$(date -u +%FT%TZ)] restoring public schema into dev..."
gunzip -c "$PUBLIC_DUMP" | psql "$DEV_DB" -v ON_ERROR_STOP=1 -q

# Retain 14 days of snapshots
find "$OUT_DIR" -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] snapshot $TS complete."
echo "  public: $(ls -lh "$PUBLIC_DUMP" | awk '{print $5}')"
echo "  auth:   $(ls -lh "$AUTH_DUMP"   | awk '{print $5}')"
