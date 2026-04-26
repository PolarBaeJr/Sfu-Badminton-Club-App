#!/usr/bin/env bash
# prod-to-dev-snapshot.sh
#
# Online dump of prod Supabase Postgres into the dev Supabase Postgres,
# no prod downtime. pg_dump uses MVCC; concurrent writes during the
# snapshot are tolerated.
#
# Runs entirely through `docker exec`, so the Pi host doesn't need
# postgresql-client installed.
#
# Scope:
#   - public schema (full clean+recreate)  — all app data
#   - auth.users + auth.identities         — keeps player.user_id FKs valid
# Skipped: prod auth sessions / refresh_tokens / etc — staging gets
# fresh sessions.
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

PROD_CONTAINER="supabase_db_badminton"
DEV_CONTAINER="supabase_db_badminton_dev"
OUT_DIR="${HOME}/ssd/Deploy/badminton-snapshots"
TS=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$OUT_DIR"

PUBLIC_DUMP="$OUT_DIR/public-$TS.sql.gz"
AUTH_DUMP="$OUT_DIR/auth-$TS.sql.gz"

# Verify both containers are up
for c in "$PROD_CONTAINER" "$DEV_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "FATAL: container $c is not running" >&2
    exit 1
  fi
done

echo "[$(date -u +%FT%TZ)] dumping prod public schema..."
docker exec "$PROD_CONTAINER" pg_dump -U postgres -d postgres \
  --schema=public --clean --if-exists \
  --quote-all-identifiers --no-owner --no-acl \
  | gzip > "$PUBLIC_DUMP"

echo "[$(date -u +%FT%TZ)] dumping prod auth users/identities..."
docker exec "$PROD_CONTAINER" pg_dump -U postgres -d postgres \
  --table=auth.users --table=auth.identities \
  --data-only --column-inserts \
  --no-owner --no-acl \
  | gzip > "$AUTH_DUMP"

echo "[$(date -u +%FT%TZ)] truncating dev auth users (cascades to identities and to public via FKs)..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE auth.identities CASCADE;
TRUNCATE auth.users CASCADE;
SQL

echo "[$(date -u +%FT%TZ)] restoring auth users into dev..."
gunzip -c "$AUTH_DUMP" | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

echo "[$(date -u +%FT%TZ)] restoring public schema into dev..."
gunzip -c "$PUBLIC_DUMP" | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

# pg_dump --clean drops and recreates the public schema. The recreate
# strips Supabase's default GRANTs to anon/authenticated/service_role,
# which makes every read fail with "permission denied for schema public".
# Re-apply them so the staging app can read its own data.
echo "[$(date -u +%FT%TZ)] re-granting Supabase roles on dev public schema..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL

# Retain 14 days of snapshots
find "$OUT_DIR" -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] snapshot $TS complete."
echo "  public: $(ls -lh "$PUBLIC_DUMP" 2>/dev/null | awk '{print $5}')"
echo "  auth:   $(ls -lh "$AUTH_DUMP"   2>/dev/null | awk '{print $5}')"
