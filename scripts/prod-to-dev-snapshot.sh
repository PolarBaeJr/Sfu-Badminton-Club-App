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
#   - public schema (full drop and recreate)  — all app data
#   - auth.users + auth.identities            — keeps player.user_id FKs valid
# Skipped: prod auth sessions / refresh_tokens / etc — staging gets
# fresh sessions.
#
# Idempotent. Safe to re-run. Existing dev DB rows in those scopes are wiped,
# and so is anything in dev's public schema that prod does not have — see
# "the drop is explicit" below.
#
# Usage:
#   ./prod-to-dev-snapshot.sh
#
# Cron (4am daily):
#   0 4 * * * /home/polarbaejr/ssd/Deploy/badminton/scripts/prod-to-dev-snapshot.sh \
#     >> /home/polarbaejr/ssd/Deploy/badminton-snapshots/cron.log 2>&1
#
# ---------------------------------------------------------------------------
# THREE THINGS THIS SCRIPT USED TO GET WRONG. All three were reproduced on a
# pair of throwaway Postgres 16 clusters before being changed here, because
# every one of them fails SILENTLY on a database nobody watches.
#
# 1. THE DROP IS EXPLICIT NOW, because pg_dump's was not safe.
#    `pg_dump --schema=public --clean` emits a bare `DROP SCHEMA IF EXISTS
#    "public";` with no CASCADE. That succeeds only while dev's public schema
#    holds NOTHING that prod does not also have — and dev is the database where
#    migrations are rehearsed, so it is routinely ahead of prod. Staging carries
#    00123's `recompute_player_stats` today; prod does not. With one such object
#    present the DROP fails, and under `-v ON_ERROR_STOP=1` the ENTIRE restore
#    aborts at that line, after auth.users has already been truncated. Measured:
#    psql exits 3 and not a single prod table lands.
#    So the drop is now ours, with CASCADE, before anything else is touched, and
#    the dump is taken WITHOUT `--clean` so there is only one drop in play.
#    Its cascade NOTICEs are logged: they are the list of things dev had and
#    prod does not, which is worth seeing in the morning.
#
#    READ THIS BEFORE RE-ENABLING THE CRON. That list is not debris — on this
#    project it is usually THE MIGRATION YOU ARE CURRENTLY TESTING. A snapshot
#    resets staging to prod, so a migration applied to staging at 22:00 is gone
#    by 04:01. That was always the intent of the tool and it is what `--clean`
#    did too, on any night when it worked at all; what changed is that it now
#    reliably succeeds, so the effect is no longer masked by the abort in (1).
#    While you are rehearsing a migration on staging, either pause this cron or
#    expect to re-apply. The cascade NOTICEs in the log tell you exactly what
#    you will need to put back.
#
# 2. THE PRIVILEGES ARE MIRRORED, not blanket-granted.
#    `--no-acl` restores objects with no privileges at all, so something has to
#    put them back or the staging app gets "permission denied for schema
#    public" on every read. This script used to do that with
#    `GRANT ALL ON ALL TABLES/FUNCTIONS ... TO anon, authenticated,
#    service_role` plus a matching ALTER DEFAULT PRIVILEGES. That handed the
#    browser key EVERYTHING, every night:
#      - `purgeable_inactive_players`, the members-queued-for-deletion view, is
#        security_invoker=false so RLS never applies to it. 00064:109 revokes it
#        by name; the blanket line gave it straight back. That is the staging
#        drift 00157 cleans up.
#      - every SECURITY DEFINER function 00126 took away from `anon`, returned.
#        And the ALTER DEFAULT PRIVILEGES line meant functions created by LATER
#        migrations were born anon-executable.
#    scripts/sql/mirror-public-acls.sql now reads prod's catalogue and emits
#    prod's OWN grants. Ablated: the blanket version diverges from prod on 9 of
#    60 privilege checks, all of them `purgeable_inactive_players` or the
#    anon-revoked function; the mirror diverges on 0 of 60.
#
# 3. THE REALTIME PUBLICATION IS PUT BACK.
#    Publication MEMBERSHIP is not in a `--schema=public` dump (grep it: zero
#    hits) and it dies with the tables. `supabase_realtime` therefore came back
#    still existing and completely empty, which is not an error anywhere — it is
#    every live badge and the whole door page quietly never updating again on
#    staging. scripts/sql/mirror-public-publications.sql re-adds prod's
#    membership. REPLICA IDENTITY needs no help; pg_dump does carry that.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_CONTAINER="supabase_db_badminton"
DEV_CONTAINER="supabase_db_badminton_dev"
OUT_DIR="${HOME}/ssd/Deploy/badminton-snapshots"
TS=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$OUT_DIR"

PUBLIC_DUMP="$OUT_DIR/public-$TS.sql.gz"
AUTH_DUMP="$OUT_DIR/auth-$TS.sql.gz"
ACL_SQL="$OUT_DIR/acls-$TS.sql"
PUB_SQL="$OUT_DIR/publications-$TS.sql"

# Verify both containers are up
for c in "$PROD_CONTAINER" "$DEV_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "FATAL: container $c is not running" >&2
    exit 1
  fi
done

# Both generators are on disk next to this script. Check before touching a
# database, not after: a missing file discovered at step 7 means dev has been
# wiped and left with no privileges, which reads as empty pages rather than an
# error.
for f in mirror-public-acls.sql mirror-public-publications.sql; do
  if [ ! -r "$SCRIPT_DIR/sql/$f" ]; then
    echo "FATAL: $SCRIPT_DIR/sql/$f is missing. Pull the repo checkout on this host." >&2
    exit 1
  fi
done

echo "[$(date -u +%FT%TZ)] dumping prod public schema..."
docker exec "$PROD_CONTAINER" pg_dump -U postgres -d postgres \
  --schema=public \
  --quote-all-identifiers --no-owner --no-acl \
  | gzip > "$PUBLIC_DUMP"

echo "[$(date -u +%FT%TZ)] dumping prod auth users/identities..."
docker exec "$PROD_CONTAINER" pg_dump -U postgres -d postgres \
  --table=auth.users --table=auth.identities \
  --data-only --column-inserts \
  --no-owner --no-acl \
  | gzip > "$AUTH_DUMP"

# Read-only against prod, and done BEFORE dev is touched so that a failure here
# costs nothing. Both are kept beside the dumps: they are the record of what
# prod's privileges were on the night, which is the only thing that makes a
# later "why can staging read that" answerable.
echo "[$(date -u +%FT%TZ)] reading prod privileges and publication membership..."
docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 \
  < "$SCRIPT_DIR/sql/mirror-public-acls.sql" > "$ACL_SQL"
docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 \
  < "$SCRIPT_DIR/sql/mirror-public-publications.sql" > "$PUB_SQL"

# CASCADE, and ours rather than pg_dump's. The NOTICEs list what dev had that
# prod does not — normally the migrations being rehearsed on staging.
echo "[$(date -u +%FT%TZ)] dropping dev public schema (cascade notices follow)..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
SQL

echo "[$(date -u +%FT%TZ)] truncating dev auth users and identities..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE auth.identities CASCADE;
TRUNCATE auth.users CASCADE;
SQL

echo "[$(date -u +%FT%TZ)] restoring auth users into dev..."
gunzip -c "$AUTH_DUMP" | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

# The dump carries its own `CREATE SCHEMA "public"`, which is why the drop above
# does not recreate it.
echo "[$(date -u +%FT%TZ)] restoring public schema into dev..."
gunzip -c "$PUBLIC_DUMP" | docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q

echo "[$(date -u +%FT%TZ)] mirroring prod privileges onto dev..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$ACL_SQL"

echo "[$(date -u +%FT%TZ)] restoring realtime publication membership..."
docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$PUB_SQL"

# Retain 14 days of snapshots and of the privilege scripts that went with them
find "$OUT_DIR" -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete 2>/dev/null || true
find "$OUT_DIR" -maxdepth 1 -name 'acls-*.sql' -mtime +14 -delete 2>/dev/null || true
find "$OUT_DIR" -maxdepth 1 -name 'publications-*.sql' -mtime +14 -delete 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] snapshot $TS complete."
echo "  public: $(ls -lh "$PUBLIC_DUMP" 2>/dev/null | awk '{print $5}')"
echo "  auth:   $(ls -lh "$AUTH_DUMP"   2>/dev/null | awk '{print $5}')"
echo "  acl statements:         $(grep -c ';' "$ACL_SQL" 2>/dev/null || echo 0)"
echo "  publication statements: $(grep -c 'END \$do\$;' "$PUB_SQL" 2>/dev/null || echo 0)"
