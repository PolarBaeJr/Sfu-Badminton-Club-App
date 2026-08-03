#!/usr/bin/env bash
#
# Nightly backup of the production Supabase Postgres.
#   1. pg_dump the whole `postgres` database (custom format, restorable).
#   2. Keep the last N days locally.
#   3. Optionally push each dump to an encrypted rclone remote (Google Drive
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

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: container '$DB_CONTAINER' is not running" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] dumping $DB_CONTAINER (custom format)..."
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres \
  --format=custom --no-owner --no-acl > "$FILE"
echo "[$(date -u +%FT%TZ)] wrote $FILE ($(ls -lh "$FILE" | awk '{print $5}'))"

# Local retention
find "$BACKUP_DIR" -maxdepth 1 -name 'badminton-*.dump' -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true

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
    if rclone copy "$FILE" "$RCLONE_REMOTE" --no-traverse \
         --retries 8 --retries-sleep 15s --low-level-retries 10 \
         --timeout 120s --contimeout 30s; then
      # Trust the listing, not the exit code: verify the object is there and is
      # the size we just wrote. A "successful" upload of nothing is the failure
      # mode that would otherwise go unnoticed until a restore.
      local_size=$(wc -c < "$FILE")
      remote_size=$(rclone lsf "$RCLONE_REMOTE" --format s \
                      --include "$(basename "$FILE")" --retries 5 2>/dev/null | head -1)
      if [ "$remote_size" = "$local_size" ]; then
        upload_ok=1
        echo "[$(date -u +%FT%TZ)] cloud upload verified ($remote_size bytes)."
      else
        echo "[$(date -u +%FT%TZ)] BACKUP UPLOAD FAILED: verify mismatch — local $local_size, remote '${remote_size:-missing}'" >&2
      fi
    else
      echo "[$(date -u +%FT%TZ)] BACKUP UPLOAD FAILED: rclone copy to $RCLONE_REMOTE returned non-zero" >&2
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
