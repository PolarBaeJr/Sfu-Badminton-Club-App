#!/usr/bin/env bash
#
# Invoke one Supabase edge function with the cron secret, and LEAVE A RECORD.
#
# Usage: run-edge-fn.sh <function-name>
#
# WHY THIS IS IN THE REPO. It was host-only state in ~/bin on the Pi, called by
# seven crontab lines, and nothing described it anywhere in the checkout. The
# nightly retention jobs run through it, including purge-deleted-accounts, which
# is the job that has to satisfy a deletion request inside 30 days. A script that
# load-bearing cannot live only in one home directory with no account of what it
# does.
#
# WHAT WAS WRONG WITH THE OLD ONE, which is the whole reason this exists:
#
#   1. It computed the status and threw it away. The body was
#      `curl -s -o /dev/null -w "%{http_code}"`, so the HTTP code went to stdout
#      and every crontab line ended in `>/dev/null 2>&1`. A function that had
#      been failing every night for a month looked exactly like one that had
#      never failed.
#   2. `-o /dev/null` discarded the response BODY, which is where these functions
#      report their actual work: `{"purged":N,"errors":[...]}`. So even the errors
#      array was unrecoverable. The count and the failures were the only things
#      worth keeping and they were the two things dropped.
#   3. The one job that DID log (purge-inactive-accounts, a raw inline curl)
#      appended without a newline and without a timestamp, so 47 nightly runs
#      were a single 3KB line of concatenated JSON. `head -5` returned the whole
#      file. You could not tell which run was which, when it ran, or whether it
#      succeeded.
#   4. The secret went in as `-H "x-cron-secret: $S"`, which puts it in the
#      process argv, where any local `ps` sees it once a night per job.
#
# So: one line per run, newline-terminated, timestamped, carrying the status AND
# the body, and the secret is passed out of band.

set -euo pipefail

FN="${1:-}"
if [ -z "$FN" ]; then
  echo "usage: run-edge-fn.sh <function-name>" >&2
  exit 2
fi

# Overridable so this is testable against staging (kong :64321) without editing
# the script. The prod defaults match the crontab this replaces.
ENV_FILE="${EDGE_FN_ENV_FILE:-/mnt/ssd/Deploy/supabase-prod/.env}"
BASE_URL="${EDGE_FN_BASE_URL:-http://localhost:54321}"
LOG_FILE="${EDGE_FN_LOG_FILE:-$HOME/logs/edge-fns.log}"
MAX_LOG_BYTES="${EDGE_FN_MAX_LOG_BYTES:-1048576}"

mkdir -p "$(dirname "$LOG_FILE")"

# Bounded, because nothing rotates ~/logs. /etc/logrotate.d has no entry for it
# and the existing purge log had been growing untouched since August. One
# generation is enough: these lines are a few hundred bytes a night, so 1MB is
# years of history, and the failure this guards against is a full SD card on a
# host that has already gone down for less.
if [ -f "$LOG_FILE" ]; then
  SIZE=$(wc -c < "$LOG_FILE" | tr -d ' ')
  if [ "$SIZE" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
fi

log() {
  # ISO-8601 with the offset, so a line is unambiguous across the DST change BC
  # drops on 2026-11-01.
  printf '%s %s %s %s\n' "$(date -Iseconds)" "$FN" "$1" "$2" >> "$LOG_FILE"
}

# `|| true` because grep exits 1 on no match and `set -e` with pipefail would
# kill the script before the emptiness check below could report it usefully.
SECRET=$(grep '^CRON_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
if [ -z "$SECRET" ]; then
  log "no-secret" "CRON_SECRET missing or empty in $ENV_FILE"
  exit 1
fi

# The secret goes in a curl config file rather than on the command line, so it
# never appears in argv. 600 before anything is written to it, and removed on
# every exit path including a failure.
CONF=$(mktemp)
BODY=$(mktemp)
trap 'rm -f "$CONF" "$BODY"' EXIT
chmod 600 "$CONF"

{
  printf 'request = "POST"\n'
  printf 'url = "%s/functions/v1/%s"\n' "$BASE_URL" "$FN"
  printf 'header = "x-cron-secret: %s"\n' "$SECRET"
  printf 'silent\n'
  printf 'show-error\n'
  printf 'max-time = "600"\n'
} > "$CONF"

# --max-time 600 rather than curl's default of none: a hung function should
# leave a timeout line in the log tonight, not a curl still waiting tomorrow
# when cron starts the next one.
CODE=$(curl -K "$CONF" -o "$BODY" -w '%{http_code}' 2>>"$LOG_FILE" || echo "000")

# Truncated and flattened onto one line. Newlines in a response body are what
# turned the old purge log into something unreadable, and a 4000-character
# feedback body echoed back would do it again.
RESPONSE=$(head -c 1000 "$BODY" | tr '\n\r\t' '   ')
[ -n "$RESPONSE" ] || RESPONSE="<empty>"

log "$CODE" "$RESPONSE"

# Exit non-zero on anything but 2xx. Nothing watches this yet, but an exit code
# is what a MAILTO line, a systemd timer or any future check can read, and a
# script that always exits 0 can never be monitored later without rewriting it.
case "$CODE" in
  2*) exit 0 ;;
  *) exit 1 ;;
esac
