#!/usr/bin/env bash
#
# Schedule a member's account for deletion, on their behalf.
#
#   ./scripts/request-account-deletion.sh --actor <you> --target <them> --reason "..."
#   ./scripts/request-account-deletion.sh --actor <you> --target <them> --reason "..." --confirm
#
# Without --confirm it is a DRY RUN: it resolves both people, runs every
# refusal check, prints exactly what would change, and rolls back.
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS.
#
# `players.deletion_requested_at` has exactly one writer in the application:
# deleteMyAccount (apps/player/src/lib/actions/profile.ts:313), which needs the
# MEMBER signed in and typing a confirmation. The admin console can only CANCEL
# a deletion (cancelAccountDeletion, apps/admin/src/lib/actions/players.ts:516).
#
# So there is no way for an officer to honour a request that arrived by email or
# Discord, and no way to re-enter a request that a database restore erased. This
# is the stopgap until the admin console grows the button. It is deliberately a
# script and not a psql one-liner, because the hand-written version of this
# write is the one that forgets the audit row.
#
# WHAT IT IS NOT: it does not delete anything. It sets the same two fields the
# member's own action sets and lets the normal 30-day purge do the work, so
# cancelAccountDeletion still undoes it and nothing downstream can tell the
# difference except the audit trail, which is exactly where the difference
# belongs.
# ---------------------------------------------------------------------------
set -euo pipefail

SSH_HOST="${SSH_HOST:-pi}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"

ACTOR="" TARGET="" REASON="" CONFIRM="" ALLOW_OFFICER="0"

die() { echo "error: $*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
usage: request-account-deletion.sh --actor <id> --target <id> --reason "<text>" [--confirm]

  --actor    you: the officer actioning this. email, member_code or uuid.
             Recorded as audit_logs.actor_id, so it must resolve to a real
             player. An unattributed deletion is not an auditable one.
  --target   the member to schedule for deletion. email, member_code or uuid.
  --reason   why, in plain words. This is the ONLY evidence the member asked,
             so write what would answer "they say they never requested this".
             e.g. "emailed exec@ 2026-09-21 asking to be deleted"
  --confirm  actually write. Without it, nothing is committed.
  --allow-officer
             permit a target who holds console access. Refused by default:
             scheduling a deletion sets active_flag=false, which locks that
             account OUT of the admin console, and the only cancel button is
             inside it. Cancel from a DIFFERENT admin account afterwards.

env: SSH_HOST (default: pi), DB_CONTAINER (default: supabase-db)
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --actor)   ACTOR="${2:-}";  shift 2 ;;
    --target)  TARGET="${2:-}"; shift 2 ;;
    --reason)  REASON="${2:-}"; shift 2 ;;
    --confirm) CONFIRM=1;       shift   ;;
    --allow-officer) ALLOW_OFFICER=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$ACTOR" ]  || usage
[ -n "$TARGET" ] || usage
[ -n "$REASON" ] || usage
[ "${#REASON}" -ge 10 ] || die "--reason is too short to be evidence of anything (got ${#REASON} chars, want 10+)"
[ "${#REASON}" -le 500 ] || die "--reason is longer than the audit column expects (500 max)"

# Identifiers are matched against email / member_code / uuid, so restrict them
# to what those can legitimately contain. This is belt-and-braces: the values
# reach psql as quoted variables below, never as concatenated SQL.
for v in "$ACTOR" "$TARGET"; do
  case "$v" in
    *[!A-Za-z0-9@._+-]*) die "identifier contains unexpected characters: $v" ;;
  esac
done

# The reason is free text, so it travels base64-encoded and is decoded inside
# the query rather than quoted into it. Nothing the user types is ever parsed
# as SQL.
REASON_B64=$(printf '%s' "$REASON" | base64 | tr -d '\n')

FINAL="ROLLBACK;"
MODE="DRY RUN (nothing will be written)"
if [ -n "$CONFIRM" ]; then
  FINAL="COMMIT;"
  MODE="COMMITTING"
fi

echo "=== $MODE ==="
echo "  actor:  $ACTOR"
echo "  target: $TARGET"
echo "  reason: $REASON"
echo

# ---------------------------------------------------------------------------
# One transaction, one DO block. Every refusal is a RAISE EXCEPTION, so a
# failed check aborts before the UPDATE rather than after it, and the dry run
# exercises the identical code path as the real one.
# ---------------------------------------------------------------------------
# Emitted from a FUNCTION rather than captured with SQL=$(cat <<'X' ... ).
# A quoted heredoc inside command substitution is still scanned by bash while
# it looks for the closing paren, so one lone apostrophe anywhere in the SQL
# comments below (writing "the console-s auth path" the natural way) breaks the
# entire script with an unmatched-quote error pointing at a line far beneath the
# real cause. Emitting straight into the pipe removes that trap for good.
emit_sql() {
cat <<'PLPGSQL'
BEGIN;

DO $do$
DECLARE
  v_n          integer;
  v_target     uuid;
  v_actor      uuid;
  v_name       text;
  v_email      text;
  v_code       text;
  v_flag       boolean;
  v_stamp      timestamptz;
  v_role       text;
  v_exec       boolean;
  v_trainer    boolean;
  v_actor_name text;
  v_now        timestamptz := now();
BEGIN
  -- Resolve the actor.
  SELECT count(*) INTO v_n FROM players
   WHERE email = :'actor' OR member_code = :'actor' OR id::text = :'actor';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'actor "%" matched % players, need exactly 1', :'actor', v_n;
  END IF;
  SELECT id, full_name INTO v_actor, v_actor_name FROM players
   WHERE email = :'actor' OR member_code = :'actor' OR id::text = :'actor';

  -- Resolve the target.
  SELECT count(*) INTO v_n FROM players
   WHERE email = :'target' OR member_code = :'target' OR id::text = :'target';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'target "%" matched % players, need exactly 1', :'target', v_n;
  END IF;
  SELECT id, full_name, email, member_code, active_flag, deletion_requested_at,
         role, coalesce(is_exec, false), coalesce(is_trainer, false)
    INTO v_target, v_name, v_email, v_code, v_flag, v_stamp,
         v_role, v_exec, v_trainer
   FROM players
   WHERE email = :'target' OR member_code = :'target' OR id::text = :'target';

  -- Refusals, in the order that gives the most useful message first.
  IF v_actor = v_target THEN
    RAISE EXCEPTION 'that is you. Delete your own account from the member settings page, which is the audited self-service path';
  END IF;

  IF v_email LIKE 'deleted+%@deleted.invalid' THEN
    RAISE EXCEPTION 'target % (%) is already purged and anonymised; there is nothing left to schedule', v_name, v_code;
  END IF;

  IF v_stamp IS NOT NULL THEN
    RAISE EXCEPTION 'target % (%) already has a deletion scheduled, requested %; it purges 30 days after that. Use the console to cancel if that is wrong', v_name, v_code, v_stamp;
  END IF;

  -- THE ONE-WAY DOOR. Scheduling a deletion sets active_flag = false, and the
  -- console's auth path rejects exactly that at
  -- apps/admin/src/lib/supabase-server.ts:160 ("Account is inactive"). The only
  -- undo, cancelAccountDeletion, is INSIDE the console. So doing this to anyone
  -- who holds console access locks them out of the tool that reverses it, and
  -- recovery becomes a hand-written production UPDATE, which is the exact thing
  -- this script exists to prevent.
  --
  -- Overridable, because an officer who leaves the club is a real case. But it
  -- has to be said out loud rather than discovered afterwards.
  IF (v_role = 'admin' OR v_exec OR v_trainer) AND :'allow_officer' <> '1' THEN
    RAISE EXCEPTION 'target % (%) holds console access (role=%, is_exec=%, is_trainer=%). Scheduling a deletion sets active_flag=false, which locks them OUT of the admin console, and the only cancel button is inside it. Re-run with --allow-officer if that is genuinely what you want, and cancel it from another admin account, not theirs', v_name, v_code, v_role, v_exec, v_trainer;
  END IF;

  RAISE NOTICE '--------------------------------------------------------';
  RAISE NOTICE 'actor      : % (%)', v_actor_name, v_actor;
  RAISE NOTICE 'target     : % <%> code % (%)', v_name, v_email, v_code, v_target;
  RAISE NOTICE 'active_flag: %  ->  false', v_flag;
  RAISE NOTICE 'deletion   : NULL  ->  %', v_now;
  RAISE NOTICE 'purges on  : %', (v_now + interval '30 days');
  RAISE NOTICE '--------------------------------------------------------';

  UPDATE players
     SET deletion_requested_at = v_now,
         active_flag           = false
   WHERE id = v_target;

  -- Audited with its OWN action_type. deleteMyAccount files
  -- 'self_deletion_requested', and profile.ts is explicit that the console has
  -- to be able to tell the writers of active_flag apart. Filing an officer's
  -- action under the member's name would put a deletion they did not perform
  -- in their own audit trail, which is the opposite of what this row is for.
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (
    v_actor,
    'officer_deletion_requested',
    'player',
    v_target,
    jsonb_build_object('deletion_requested_at', NULL, 'active_flag', v_flag),
    jsonb_build_object('deletion_requested_at', v_now, 'active_flag', false),
    convert_from(decode(:'reason_b64', 'base64'), 'UTF8')
  );
END
$do$;
PLPGSQL
echo "$FINAL"
}

emit_sql | ssh "$SSH_HOST" "docker exec -i $DB_CONTAINER psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 \
  -v actor=\"$ACTOR\" \
  -v target=\"$TARGET\" \
  -v reason_b64=\"$REASON_B64\" \
  -v allow_officer=\"$ALLOW_OFFICER\""

echo
if [ -n "$CONFIRM" ]; then
  cat <<EOF
=== written ===

TWO THINGS ARE STILL YOURS TO DO, and the script cannot do either:

1. TELL THE MEMBER. They have 30 days to cancel, and they cannot exercise that
   if nobody told them. The self-service path does not need this because the
   member is the one who clicked; this path does, because they are not.

2. RECORD THE REQUEST OUTSIDE THIS DATABASE. If it is ever restored from a
   dump taken before today, this row goes back to normal and nothing will ever
   delete it again: the purge keys on deletion_requested_at, which the restore
   will have cleared. The audit row goes with it. See backup/README.md.
EOF
else
  echo "=== dry run only, nothing written. Re-run with --confirm to apply. ==="
fi
