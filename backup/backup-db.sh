#!/usr/bin/env bash
#
# Nightly backup of the production Supabase Postgres.
#   1. pg_dumpall --globals-only: the 16 roles and their cluster-wide grants.
#   2. pg_dump the whole `postgres` database (custom format, restorable).
#   3. Keep the last N days locally.
#   4. Optionally push each dump to an encrypted rclone remote (Google Drive
#      via `rclone crypt`, so Google only ever stores ciphertext — the dump
#      contains member PII).
#
# Runs entirely through `docker exec`, so the Pi host needs no postgres client.
#
# Config via env (all optional — defaults match the current Pi):
#   DB_CONTAINER   prod Postgres container   (default: supabase-db)
#   BACKUP_DIR     local dump dir            (default: ~/ssd/db-backups)
#   RETAIN_DAYS    days to keep              (default: 14)
#   RCLONE_REMOTE  encrypted remote target   (default: gcrypt:  — set empty to
#                                             skip the cloud upload)
#
# Cron (daily 03:30):
#   30 3 * * * ~/ssd/Deploy/badminton/backup/backup-db.sh \
#       >> ~/ssd/db-backups/backup.log 2>&1
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/ssd/db-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gcrypt:}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/badminton-$STAMP.dump"
GLOBALS="$BACKUP_DIR/badminton-globals-$STAMP.sql"

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: container '$DB_CONTAINER' is not running" >&2
  exit 1
fi

# Roles first. `pg_dump` NEVER emits roles, at any flag combination — only
# pg_dumpall --globals-only does. Without this file a restore lands in a cluster
# that has no `anon`, `authenticated`, `service_role` or `authenticator`, so
# every GRANT in the data dump below fails to apply.
#
# --no-role-passwords is deliberate: it keeps SCRAM/md5 hashes out of a file
# that gets shipped to Google Drive. Verified 2026-08-24 to emit 0
# password-bearing lines while still producing all 16 CREATE ROLE statements.
# The actual passwords come from POSTGRES_PASSWORD and friends in the compose
# env, so they are recoverable without this file; the hashes would be pure risk.
echo "[$(date -u +%FT%TZ)] dumping globals (roles + cluster grants)..."
docker exec "$DB_CONTAINER" pg_dumpall -U postgres \
  --globals-only --no-role-passwords > "$GLOBALS"
echo "[$(date -u +%FT%TZ)] wrote $GLOBALS ($(ls -lh "$GLOBALS" | awk '{print $5}'))"

# `--no-owner` stays: it lets the dump restore as whatever user runs psql.
#
# `--no-acl` was REMOVED on 2026-08-24. It was silently dropping every table
# privilege: all ~60 tables in `public` carry 2-3 explicit ACL entries, and
# --no-acl emits none of them. A restore from the old dumps therefore produced
# a database where `anon` and `authenticated` could not read anything — and
# because a denied PostgREST read comes back as an EMPTY LIST rather than an
# error, the restored site would have returned 200s with no data instead of
# failing loudly. That is the worst possible way for a restore to be wrong.
#
# Restore order is now load-bearing: globals first, then this file. See README.
echo "[$(date -u +%FT%TZ)] dumping $DB_CONTAINER (custom format)..."
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres \
  --format=custom --no-owner > "$FILE"
echo "[$(date -u +%FT%TZ)] wrote $FILE ($(ls -lh "$FILE" | awk '{print $5}'))"

# Local retention. Two patterns, because the globals file is `.sql`, not
# `.dump` — `badminton-*.dump` does not match it and it would accumulate
# forever. Keep these two lines in sync with the remote sweep further down.
find "$BACKUP_DIR" -maxdepth 1 -name 'badminton-*.dump'       -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -name 'badminton-globals-*.sql' -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true

# Off-site, encrypted. Skipped when RCLONE_REMOTE is empty or rclone is absent.
#
# The upload is deliberately NOT allowed to abort the script. It used to be:
# under `set -e` a failed `rclone copy` exited here, which skipped the retention
# sweep AND meant the only trace was a stack of stderr in backup.log that nobody
# reads. That is how the off-site copy silently went 15 days stale in Jul 2026 —
# a mangled rclone client_id made every upload fail with "invalid_client" while
# the local dumps kept succeeding, so the backup looked healthy from the outside.
#
# Now: retry hard, verify the object actually exists afterwards, and record the
# outcome in a state file so staleness is visible without reading the log.
UPLOAD_STATE="$BACKUP_DIR/.last-upload"
upload_ok=""

if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[$(date -u +%FT%TZ)] uploading to $RCLONE_REMOTE ..."
    # rclone's *built-in* OAuth client is shared by every rclone user on earth
    # and regularly returns 403 "Quota exceeded ... Queries per minute" for the
    # shared project. It clears in seconds, so retry rather than fail the night.
    # (Setting your own client_id in rclone.conf removes this entirely — see
    # README.)
    # Both files must land. A data dump whose globals never uploaded restores
    # into a cluster with no roles, so treating the pair as one unit is the
    # point — `upload_ok` is set only if BOTH verify.
    push_one() {
      f=$1
      if ! rclone copy "$f" "$RCLONE_REMOTE" --no-traverse \
             --retries 8 --retries-sleep 15s --low-level-retries 10 \
             --timeout 120s --contimeout 30s; then
        echo "[$(date -u +%FT%TZ)] BACKUP UPLOAD FAILED: rclone copy of $(basename "$f") returned non-zero" >&2
        return 1
      fi
      # Trust the listing, not the exit code: verify the object is there and is
      # the size we just wrote. A "successful" upload of nothing is the failure
      # mode that would otherwise go unnoticed until a restore.
      # `tr -d` because BSD `wc -c` left-pads its count while GNU's does not.
      # The Pi is GNU so this compared fine there, but the padding made the
      # check fail spuriously the moment it was exercised on macOS — and the
      # server is moving to a Mac mini, where that would have turned every
      # night's upload into a false "verify mismatch".
      l=$(wc -c < "$f" | tr -d '[:space:]')
      r=$(rclone lsf "$RCLONE_REMOTE" --format s \
            --include "$(basename "$f")" --retries 5 2>/dev/null | head -1 | tr -d '[:space:]')
      if [ "$r" = "$l" ]; then
        echo "[$(date -u +%FT%TZ)] verified $(basename "$f") ($r bytes)."
        return 0
      fi
      echo "[$(date -u +%FT%TZ)] BACKUP UPLOAD FAILED: verify mismatch on $(basename "$f") — local $l, remote '${r:-missing}'" >&2
      return 1
    }

    if push_one "$GLOBALS" && push_one "$FILE"; then
      upload_ok=1
      echo "[$(date -u +%FT%TZ)] cloud upload verified (globals + dump)."
    fi

    if [ -n "$upload_ok" ]; then
      # Remote retention only when we know the remote is reachable and current,
      # so a broken upload can never also start deleting the off-site history.
      #
      # Scoped to the nightly filename pattern, matching the local sweep above.
      # Unscoped it reaped ANY object older than the window — including one-off
      # archival snapshots parked in the same remote by hand (pre-rework-*.dump
      # is exactly that: a point-in-time copy worth keeping indefinitely).
      rclone delete "$RCLONE_REMOTE" --min-age "${RETAIN_DAYS}d" \
        --include 'badminton-*.dump' --retries 5 2>/dev/null || true
      rclone delete "$RCLONE_REMOTE" --min-age "${RETAIN_DAYS}d" \
        --include 'badminton-globals-*.sql' --retries 5 2>/dev/null || true
      date -u +%FT%TZ > "$UPLOAD_STATE"
    fi
  else
    echo "[$(date -u +%FT%TZ)] BACKUP UPLOAD FAILED: rclone not installed" >&2
  fi
fi

echo "[$(date -u +%FT%TZ)] backup $STAMP complete (local dump written)."

if [ -n "$RCLONE_REMOTE" ] && [ -z "$upload_ok" ]; then
  last=$(cat "$UPLOAD_STATE" 2>/dev/null || echo 'never')
  echo "[$(date -u +%FT%TZ)] OFF-SITE COPY IS STALE — last verified upload: $last" >&2
  exit 1
fi
