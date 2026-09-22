#!/usr/bin/env bash
#
# Pull the latest DB dumps from the Pi to this Mac, encrypting each one on
# arrival: a free off-site copy on a separate physical device, which this
# machine cannot read back. Run on a schedule via the launchd plist in this
# folder, or by hand.
#
# Config via env:
#   DEST           local dir for copies    (default: ~/badminton-backups)
#   PI_HOSTS       ssh aliases, in order   (default: "pi pi-lan")
#   PI_DIR         remote dump dir         (default: ~/ssd/db-backups)
#   RETAIN_DAYS    days to keep locally    (default: 14, matching the Pi)
#   AGE_RECIPIENT  age public key          (default: read from $DEST/.age-recipient)
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
#
# ---------------------------------------------------------------------------
# WHY THE ENCRYPTION IS WRITE-ONLY, AND WHAT THAT BUYS.
#
# Each dump is encrypted to an age public key the moment it lands, and the
# plaintext is removed. Only the public key lives on this Mac, so this machine
# can WRITE the off-site copy and cannot READ it. A stolen or seized laptop
# yields ciphertext and nothing else.
#
# That property is the entire point, and it is destroyed by keeping the private
# key here. If the identity file sits on this Mac, this tier is back to being a
# plaintext member database with an extra step, so the run says so out loud
# rather than reporting success. Keep the private key in the password manager,
# and nowhere on this disk. See backup/README.md.
#
# Losing the private key means losing every off-site copy: there is no recovery
# path and deliberately so. Tier 1 (the Pi) and tier 3 (encrypted Drive) are
# what cover that, which is why this tier can afford to fail closed.
# ---------------------------------------------------------------------------
set -euo pipefail

DEST="${DEST:-$HOME/badminton-backups}"
PI_HOSTS="${PI_HOSTS:-pi pi-lan}"
PI_DIR="${PI_DIR:-~/ssd/db-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

STATE="$DEST/.last-pull"
INCOMING="$DEST/.incoming"

mkdir -p "$DEST"

# ---------------------------------------------------------------------------
# Refuse to run rather than fall back to plaintext. A missing tool or a missing
# recipient is a configuration error, and the wrong way to handle it is to keep
# writing readable member data while printing a note nobody reads. Exit 1 is
# also what the launchd last-exit-status check actually surfaces.
# ---------------------------------------------------------------------------
# Resolved by absolute path and not left to $PATH. launchd hands a job a bare
# /usr/bin:/bin:/usr/sbin:/sbin, which does NOT contain Homebrew, so `age` is
# on the PATH of every interactive test and on none of the scheduled runs. The
# script would then refuse nightly and work perfectly whenever anyone checked
# it by hand, which is the same shape as the outage above: healthy under
# observation, dead on the schedule.
AGE=""
for cand in /opt/homebrew/bin/age /usr/local/bin/age "$(command -v age 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then AGE="$cand"; break; fi
done
if [ -z "$AGE" ]; then
  echo "[$(date -u +%FT%TZ)] REFUSING TO RUN: age is not installed (brew install age)." >&2
  echo "[$(date -u +%FT%TZ)] No dumps were pulled. The off-site copy is not being updated." >&2
  exit 1
fi

if [ -z "${AGE_RECIPIENT:-}" ] && [ -f "$DEST/.age-recipient" ]; then
  AGE_RECIPIENT="$(tr -d '[:space:]' < "$DEST/.age-recipient")"
fi
if [ -z "${AGE_RECIPIENT:-}" ]; then
  echo "[$(date -u +%FT%TZ)] REFUSING TO RUN: no age recipient in $DEST/.age-recipient." >&2
  echo "[$(date -u +%FT%TZ)] No dumps were pulled. The off-site copy is not being updated." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# A crashed run can leave plaintext in .incoming and a half-written .partial in
# DEST. Clear both at the START as well as on exit, because the run that has to
# clean up is by definition the one whose exit handler did not get to run.
# ---------------------------------------------------------------------------
rm -rf "$INCOMING"
rm -f "$DEST"/badminton-*.dump.age.partial
mkdir -p "$INCOMING"
chmod 700 "$INCOMING"
trap 'rm -rf "$INCOMING"' EXIT

# ---------------------------------------------------------------------------
# Encrypt everything sitting in plaintext in a directory, into DEST.
#
# The mtime carry is load-bearing, not neatness: the retention sweep below is a
# privacy control keyed on mtime, and a ciphertext stamped with its ENCRYPTION
# time rather than its DUMP time silently widens the window the club promises.
#
# Writing to .partial and then renaming is the same kind of care. The "have I
# already got this one" test is the existence of the .age file, so a truncated
# one left by a crash would make that dump look fetched forever.
# ---------------------------------------------------------------------------
encrypt_dir() {
  local dir="$1" f base out n=0
  for f in "$dir"/badminton-*.dump; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    out="$DEST/$base.age"
    "$AGE" -r "$AGE_RECIPIENT" -o "$out.partial" "$f"
    touch -r "$f" "$out.partial"
    mv "$out.partial" "$out"
    rm -f "$f"
    n=$((n + 1))
  done
  echo "$n"
}

# Self-healing, and how the pre-encryption backlog converts: any plaintext
# already sitting in DEST gets encrypted on the next run rather than needing a
# separate migration script that would be run once and then rot.
#
# BEFORE the pull, not after, because the fetch list below is built from which
# ciphertexts exist. Converting afterwards means every dump held in plaintext
# is also re-downloaded from the Pi and then immediately overwritten by the
# local copy of the same bytes.
converted="$(encrypt_dir "$DEST")"
if [ "$converted" -gt 0 ]; then
  echo "[$(date -u +%FT%TZ)] encrypted $converted dump(s) that were being held in plaintext"
fi

# ---------------------------------------------------------------------------
# Pull. Try each alias in turn: `pi` is Tailscale and works anywhere, `pi-lan`
# is the direct address for when Tailscale is off at home.
#
# This asks the Pi what it holds and fetches only the dumps we have no
# ciphertext for, instead of rsyncing the whole directory. rsync compares
# against what is in DEST, and what is in DEST is now .dump.age, so a plain
# mirror would re-download every dump every night and then re-encrypt it.
# ---------------------------------------------------------------------------
pulled=""
fetched=0
for host in $PI_HOSTS; do
  echo "[$(date -u +%FT%TZ)] trying $host ..."

  if ! remote=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$host" "ls -1 $PI_DIR/" 2>/dev/null); then
    echo "[$(date -u +%FT%TZ)] $host did not answer, trying the next route" >&2
    continue
  fi

  want=""
  while IFS= read -r name; do
    case "$name" in
      badminton-*.dump) ;;
      *) continue ;;
    esac
    [ -e "$DEST/$name.age" ] && continue
    want="${want}${name}"$'\n'
  done <<< "$remote"

  if [ -n "$want" ]; then
    if ! printf '%s' "$want" | rsync -a --files-from=- \
         -e "ssh -o ConnectTimeout=15 -o BatchMode=yes" \
         "$host:$PI_DIR/" "$INCOMING/"; then
      echo "[$(date -u +%FT%TZ)] $host listed but would not transfer, trying the next route" >&2
      continue
    fi
  fi

  pulled="$host"
  break
done

if [ -z "$pulled" ]; then
  last=$(cat "$STATE" 2>/dev/null || echo 'never')
  echo "[$(date -u +%FT%TZ)] BACKUP PULL FAILED on every route ($PI_HOSTS)." >&2
  echo "[$(date -u +%FT%TZ)] OFF-SITE COPY IS STALE: last successful pull $last" >&2
  exit 1
fi

fetched="$(encrypt_dir "$INCOMING")"

date -u +%FT%TZ > "$STATE"
echo "[$(date -u +%FT%TZ)] pulled $fetched new dump(s) from $pulled to $DEST"

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
# Encryption does not replace this. A ciphertext the club can still decrypt is
# still the club holding that member's data, so the clock runs the same.
#
# 14 days matches the Pi's RETAIN_DAYS. The two windows should move together.
# Scoped to the nightly filename pattern so that anything parked here by hand
# is left alone, matching the Pi's sweep. Both suffixes are swept: the bare
# .dump only matches anything if a run died between fetch and encrypt.
# ---------------------------------------------------------------------------
find "$DEST" -maxdepth 1 -name 'badminton-*.dump.age' -mtime +"$RETAIN_DAYS" -print -delete 2>/dev/null || true
find "$DEST" -maxdepth 1 -name 'badminton-*.dump' -mtime +"$RETAIN_DAYS" -print -delete 2>/dev/null || true

echo "[$(date -u +%FT%TZ)] retained the last $RETAIN_DAYS days:"
ls -lh "$DEST"/badminton-*.dump.age 2>/dev/null | tail -3 || echo "  (none)"

# ---------------------------------------------------------------------------
# The check that decides whether any of the above was worth doing. Encrypting
# to a key that is sitting on the same disk protects against nothing, so this
# looks for an age identity in the obvious places and complains if it finds
# one. It reads only for the marker line and never prints file contents.
# ---------------------------------------------------------------------------
for cand in "$HOME/badminton-age-key.txt" "$DEST"/*.txt "$DEST"/.age-identity*; do
  [ -f "$cand" ] || continue
  if grep -q 'AGE-SECRET-KEY-' "$cand" 2>/dev/null; then
    echo "[$(date -u +%FT%TZ)] WARNING: a private age key is on this Mac ($cand)." >&2
    echo "[$(date -u +%FT%TZ)] Anyone with this disk can read the backups. Move it to the password manager and delete it." >&2
  fi
done

leftover=$(find "$DEST" -maxdepth 1 -name 'badminton-*.dump' | wc -l | tr -d ' ')
if [ "$leftover" != "0" ]; then
  echo "[$(date -u +%FT%TZ)] WARNING: $leftover dump(s) are still in plaintext in $DEST." >&2
fi
