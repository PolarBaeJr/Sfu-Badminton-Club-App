#!/usr/bin/env bash
#
# Pull the latest DB dumps from the Pi to this Mac: a free off-site copy on a
# separate physical device. Run on a schedule via the launchd plist in this
# folder, or by hand.
#
# Config via env:
#   DEST         local dir for copies    (default: ~/badminton-backups)
#   PI_HOSTS     ssh aliases, in order   (default: "pi pi-lan")
#   PI_DIR       remote dump dir         (default: ~/ssd/db-backups)
#   RETAIN_DAYS  days to keep locally    (default: 14, matching the Pi)
#
# ---------------------------------------------------------------------------
# WHY THIS CONNECTS BY SSH ALIAS AND NOT BY HOSTNAME.
#
# It used to hardcode polardev.org:2222 plus an explicit key and port, which is
# a verbatim copy of the `pi-remote` block in ~/.ssh/config. That domain was
# retired, so every run failed with ssh's exit 255 and the launchd job kept
# firing daily into a connection refused. The last dump reached this Mac on
# 2026-07-20 and nobody noticed for two months, because a failed pull left the
# previous dumps sitting there looking like a healthy backup.
#
# Connecting by alias means the connection details live in exactly one place.
# When a host moves, ssh/config changes and this script does not.
# ---------------------------------------------------------------------------
set -euo pipefail

DEST="${DEST:-$HOME/badminton-backups}"
PI_HOSTS="${PI_HOSTS:-pi pi-lan}"
PI_DIR="${PI_DIR:-~/ssd/db-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

STATE="$DEST/.last-pull"

mkdir -p "$DEST"

# ---------------------------------------------------------------------------
# Pull. Try each alias in turn: `pi` is Tailscale and works anywhere, `pi-lan`
# is the direct address for when Tailscale is off at home.
# ---------------------------------------------------------------------------
pulled=""
for host in $PI_HOSTS; do
  echo "[$(date -u +%FT%TZ)] trying $host ..."
  if rsync -a --prune-empty-dirs \
       --include='badminton-*.dump' --exclude='*' \
       -e "ssh -o ConnectTimeout=15 -o BatchMode=yes" \
       "$host:$PI_DIR/" "$DEST/"; then
    pulled="$host"
    break
  fi
  echo "[$(date -u +%FT%TZ)] $host did not answer, trying the next route" >&2
done

if [ -z "$pulled" ]; then
  last=$(cat "$STATE" 2>/dev/null || echo 'never')
  echo "[$(date -u +%FT%TZ)] BACKUP PULL FAILED on every route ($PI_HOSTS)." >&2
  echo "[$(date -u +%FT%TZ)] OFF-SITE COPY IS STALE: last successful pull $last" >&2
  exit 1
fi

date -u +%FT%TZ > "$STATE"
echo "[$(date -u +%FT%TZ)] pulled dumps from $pulled to $DEST"

# ---------------------------------------------------------------------------
# RETENTION. This runs ONLY after a pull that succeeded, for the same reason
# the Pi's remote sweep does: a broken pull must never also start deleting the
# off-site history, or one bad night turns into no backup at all.
#
# WHY A SWEEP EXISTS AT ALL, which is a privacy requirement and not tidiness.
# The dump contains every member's name, email, phone and waiver. When a member
# is deleted, the purge anonymises them in the live database, but every dump
# taken before that still holds them. That is accepted practice ONLY while the
# backup retention is bounded and defined, so the copy expires on a known
# schedule. Without this sweep the copy never expired, and "we deleted you"
# was not a true statement about this machine.
#
# 14 days matches the Pi's RETAIN_DAYS. The two windows should move together.
# Scoped to the nightly filename pattern so that anything parked here by hand
# is left alone, matching the Pi's sweep.
# ---------------------------------------------------------------------------
find "$DEST" -maxdepth 1 -name 'badminton-*.dump' -mtime +"$RETAIN_DAYS" -print -delete 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] retained the last $RETAIN_DAYS days:"
ls -lh "$DEST"/badminton-*.dump 2>/dev/null | tail -3 || echo "  (none)"

# ---------------------------------------------------------------------------
# STILL OUTSTANDING: these dumps are stored in plaintext.
#
# Tier 3 encrypts before it leaves the Pi (rclone crypt, so Google only ever
# holds ciphertext). This tier does not, so anyone with access to this Mac has
# the whole member database with no key. That is a real gap and it is tracked;
# it is not fixed here because it needs a tool that is not installed and a key
# that is the owner's to create, and a dead backup was the worse problem.
# ---------------------------------------------------------------------------
if [ ! -f "$DEST/.encryption-configured" ]; then
  echo "[$(date -u +%FT%TZ)] NOTE: these dumps are stored UNENCRYPTED. See backup/README.md." >&2
fi
