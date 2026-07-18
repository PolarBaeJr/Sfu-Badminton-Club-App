#!/usr/bin/env bash
#
# Pull the latest DB dumps from the Pi to this Mac — a free off-site copy on a
# separate physical device. Run on a schedule via the launchd plist in this
# folder, or by hand.
#
# Config via env:
#   DEST      local dir for copies   (default: ~/badminton-backups)
#   SSH_KEY   ssh key                (default: ~/.ssh/taqeventbot.key)
#   PI        user@host              (default: polarbaejr@ssh.polardev.org)
#   PI_PORT   ssh port               (default: 2222)
#   PI_DIR    remote dump dir        (default: ~/ssd/db-backups)
set -euo pipefail

DEST="${DEST:-$HOME/badminton-backups}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/taqeventbot.key}"
PI="${PI:-polarbaejr@ssh.polardev.org}"
PI_PORT="${PI_PORT:-2222}"
PI_DIR="${PI_DIR:-~/ssd/db-backups}"

mkdir -p "$DEST"
rsync -a --prune-empty-dirs \
  --include='badminton-*.dump' --exclude='*' \
  -e "ssh -p $PI_PORT -i $SSH_KEY -o ConnectTimeout=15" \
  "$PI:$PI_DIR/" "$DEST/"

echo "[$(date -u +%FT%TZ)] pulled dumps to $DEST"
ls -lh "$DEST"/badminton-*.dump 2>/dev/null | tail -3 || true
