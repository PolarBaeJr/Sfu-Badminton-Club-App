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
# READ THIS FIRST: IT HAS NOT RUN SINCE 7 JULY 2026.
#
# Everything below describes defects in what this script DOES. Before any of
# them could matter it has to get past its own container check, and it has not:
# the two names were `supabase_db_badminton` / `..._dev`, which do not exist.
# `cron.log` is 4,493 lines, one FATAL per night, and the newest real dump is
# `public-20260707T110001Z.sql.gz`. Fixed at the top of this file.
#
# So read (1)-(3) as "what would have happened, measured on throwaway clusters",
# NOT as "what has been happening nightly". In particular the blanket GRANT in
# (2) has not been re-opening `anon`'s access every night for the last six weeks,
# because it has not been reached. Whatever staging drift 00157 cleans up
# predates 7 July.
# ---------------------------------------------------------------------------
# THREE THINGS THIS SCRIPT USED TO GET WRONG, and TWO GUARDS THE FIXES NEEDED.
# All of it was reproduced on a pair of throwaway Postgres 16 clusters before
# being changed here, because every one of these fails SILENTLY on a database
# nobody watches.
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
#
# 4. THE CASCADE IN (1) IS ITSELF A NEW RISK, so it is gated.
#    The old drop could not cascade; ours can, and CASCADE reaches OUT of the
#    schema. A trigger on auth.users calling a public.handle_new_user(), an
#    extension installed into public, a foreign key from another schema into
#    public.players, a view elsewhere selecting from public, a column typed as a
#    public enum — CASCADE takes every one of them, and `--schema=public`
#    restores none of them. Signup would then write no player row, for ever,
#    with nothing in any log: the exact failure class the rest of this header is
#    about. Grepping the migrations says this repo has no such dependent, but the
#    migrations are not the whole database — Supabase's init ran first, the owner
#    has run SQL by hand, and `CREATE EXTENSION IF NOT EXISTS` is a silent no-op
#    that reveals nothing about where the extension actually landed. So the
#    question is put to the live database every night instead:
#    scripts/sql/check-public-dependents.sql lists anything outside public that
#    depends on it, and any output is fatal BEFORE the drop. Ablated: a planted
#    auth.users trigger names itself and stops the run with dev untouched; the
#    same query returns zero rows once it is removed.
#
# 5. AN EMPTY PRIVILEGE MIRROR IS REFUSED.
#    The generator in (2) returning zero rows still exits 0, which would wipe
#    dev, restore it, apply a file of pure comments, and leave staging with no
#    grants — empty pages rather than an error, since a failed PostgREST read
#    arrives as an empty list. A floor of 20 statements is checked before the
#    drop. Ablated: a generator stubbed to return nothing refuses the run and
#    leaves dev's 64 grants in place. The publication generator gets the same
#    treatment, except that its floor has to be a COMPARISON against prod rather
#    than a threshold: zero blocks is the correct answer for a `FOR ALL TABLES`
#    publication, so a fixed minimum would block such a database every night.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# THE NAMES WERE WRONG, AND THAT IS WHY NOTHING HAS RUN SINCE 7 JULY 2026.
# `supabase_db_badminton` / `..._dev` do not exist on the Pi and have not for
# weeks: the stacks are compose projects `supabase` and `supabase-staging`
# (/mnt/ssd/Deploy/supabase-prod and /mnt/ssd/Deploy/supabase-staging), whose db
# services are plain `supabase-db` and `supabase-staging-db`. Verified from
# `com.docker.compose.project.working_dir`, not from the names alone — the names
# are suggestive, the label is proof. cron.log is 4,493 lines of
# "FATAL: container supabase_db_badminton is not running", one per night, and the
# newest real dump is public-20260707T110001Z.sql.gz.
#
# Overridable, because the next rename should be a one-line env change and not
# another six weeks of silence.
PROD_CONTAINER="${PROD_CONTAINER:-supabase-db}"
DEV_CONTAINER="${DEV_CONTAINER:-supabase-staging-db}"
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
for f in mirror-public-acls.sql mirror-public-publications.sql check-public-dependents.sql; do
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

# A generator that returns nothing still exits 0. That would drop dev, restore
# it, apply a file of pure comments, and leave staging with no grants at all —
# which surfaces as empty pages, not as an error, because a failed PostgREST read
# arrives as an empty list. So put a floor under it BEFORE anything is dropped.
# The two-table fixture this was developed against generated 39 statements; prod
# generates hundreds. Twenty is far below any real answer and far above zero.
acl_stmts=$(grep -c ';' "$ACL_SQL" 2>/dev/null || true)
if [ "${acl_stmts:-0}" -lt 20 ]; then
  echo "FATAL: the privilege mirror produced only ${acl_stmts:-0} statements." >&2
  echo "       Refusing to wipe dev — it would come back with no grants and look" >&2
  echo "       empty rather than broken. $ACL_SQL is kept for inspection." >&2
  exit 1
fi

# The same floor for the publication generator, and it cannot be a threshold.
# An empty PUB_SQL is DEFECT 3 itself — supabase_realtime comes back existing and
# holding nothing, every live badge and the whole door page quietly stop
# updating, and nothing errors anywhere. But zero blocks is also the CORRECT
# answer when prod's publication is FOR ALL TABLES, which the generator rightly
# skips (a member list is not something to re-add table by table). A fixed
# minimum would either miss the failure or block every night on such a database.
# So ask prod how many pairs there should be and compare.
pub_expected=$(docker exec -i "$PROD_CONTAINER" psql -U postgres -d postgres -qAt \
  -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_publication p
     JOIN pg_publication_rel r ON r.prpubid = p.oid
     JOIN pg_class c ON c.oid = r.prrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE NOT p.puballtables;")
pub_got=$(grep -c 'END \$do\$;' "$PUB_SQL" 2>/dev/null || true)
if [ "${pub_expected:-0}" -gt 0 ] && [ "${pub_got:-0}" -lt "${pub_expected}" ]; then
  echo "FATAL: prod publishes ${pub_expected} public table(s), but the generator emitted" >&2
  echo "       only ${pub_got:-0} statement(s). Refusing to wipe dev — realtime would come" >&2
  echo "       back subscribed to nothing, which is silent everywhere. $PUB_SQL kept." >&2
  exit 1
fi

# WHAT CASCADE WOULD TAKE WITH IT. Asked of the database we are about to drop,
# because the answer is not in this repo: Supabase's own init ran before any of
# our migrations, `CREATE EXTENSION IF NOT EXISTS` is a silent no-op that reveals
# nothing about where the extension landed, and the owner has run SQL by hand.
# Anything this prints lives outside public, dies with the CASCADE, and is NOT in
# a `--schema=public` dump — so it would be gone for good. Empty output is the
# expected answer and the only one we proceed on.
echo "[$(date -u +%FT%TZ)] checking for cross-schema dependents on public..."
dependents=$(docker exec -i "$DEV_CONTAINER" psql -U postgres -d postgres -qAt \
  -v ON_ERROR_STOP=1 < "$SCRIPT_DIR/sql/check-public-dependents.sql")
if [ -n "$dependents" ]; then
  echo "FATAL: dropping public would also destroy these, and the dump restores none" >&2
  echo "       of them (pg_dump --schema=public does not carry them):" >&2
  echo "$dependents" | sed 's/^/         - /' >&2
  echo "       Nothing has been changed. Move each one out of public's blast radius" >&2
  echo "       (or add it to a post-restore step) before letting this run again." >&2
  exit 1
fi

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
echo "  acl statements:         $(grep -c ';' "$ACL_SQL" 2>/dev/null || true)"
echo "  publication statements: $(grep -c 'END \$do\$;' "$PUB_SQL" 2>/dev/null || true)"
