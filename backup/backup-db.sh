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
if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[$(date -u +%FT%TZ)] uploading to $RCLONE_REMOTE ..."
    rclone copy "$FILE" "$RCLONE_REMOTE" --no-traverse
    rclone delete "$RCLONE_REMOTE" --min-age "${RETAIN_DAYS}d" 2>/dev/null || true
    echo "[$(date -u +%FT%TZ)] cloud upload done."
  else
    echo "[$(date -u +%FT%TZ)] WARNING: rclone not installed — skipped cloud upload." >&2
  fi
fi

echo "[$(date -u +%FT%TZ)] backup $STAMP complete."
