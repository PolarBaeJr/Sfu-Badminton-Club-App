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
#
# ---------------------------------------------------------------------------
# WHY IT WRITES TO STAGING TOO, BY DEFAULT.
#
# Staging is not test data. scripts/prod-to-dev-snapshot.sh copies the whole
# public schema plus auth.users and auth.identities from production every night
# at 04:00, unscrubbed, so the staging database holds the real membership: real
# names, real emails, real phones. There are two copies of these people on the
# public internet, not one.
#
# That nightly refresh does eventually carry an anonymisation across, because it
# drops and reloads the schema. Two reasons not to rely on it:
#
#   1. It is a job, and this one has been dead before. It failed silently every
#      night from 7 July to 21 September 2026 on a container name that no longer
#      existed. A deletion whose completeness depends on a cron job nobody is
#      watching is a deletion you cannot promise.
#   2. Even working, it leaves the member readable on staging until 04:00.
#
# So the default is --db both, and prod is written FIRST: if prod refuses, the
# mirror is never touched. On the mirror the script is deliberately laxer -- a
# member missing from staging is a no-op, not an error -- and it writes no audit
# row there, because staging's audit_logs is wiped every night and is not the
# record of anything.
# ---------------------------------------------------------------------------
set -euo pipefail

SSH_HOST="${SSH_HOST:-pi}"
PROD_CONTAINER="${PROD_CONTAINER:-supabase-db}"
STAGING_CONTAINER="${STAGING_CONTAINER:-supabase-staging-db}"

ACTOR="" TARGET="" REASON="" CONFIRM="" ALLOW_OFFICER="0" DB="both"

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
  --db       which databases to write. both (default) | prod | staging.
             STAGING IS NOT TEST DATA: it is refreshed from prod nightly with no
             scrub, so it holds the same real people. "both" is the default
             because a deletion that only covers one of the two copies is not a
             deletion. prod is always written first.

env: SSH_HOST (default: pi)
     PROD_CONTAINER    (default: supabase-db)
     STAGING_CONTAINER (default: supabase-staging-db)
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
    --db)      DB="${2:-}";     shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$DB" in
  both|prod|staging) ;;
  *) die "--db must be both, prod or staging (got: $DB)" ;;
esac

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
echo "  db:     $DB"
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

-- THE PARAMETERS HAVE TO ARRIVE THROUGH set_config, NOT AS :'var' INSIDE THE
-- BLOCK. psql performs variable interpolation while it lexes, and it treats a
-- dollar-quoted string as opaque, so a psql-style parameter written between
-- $do$ and $do$ is passed to the server literally and dies with
-- `syntax error at or near ":"`. (Verified against psql, not assumed. It is a
-- silent trap because the identical parameter a few lines higher, outside the
-- quoting, expands perfectly.)
--
-- These SELECTs are outside the block, so they do expand. `true` as the third
-- argument makes each setting LOCAL to the transaction, which means the dry
-- run's ROLLBACK discards them along with everything else and nothing leaks
-- into the next statement on that connection.
\o /dev/null
SELECT set_config('deletion.actor',         :'actor',         true),
       set_config('deletion.target',        :'target',        true),
       set_config('deletion.reason_b64',    :'reason_b64',    true),
       set_config('deletion.allow_officer', :'allow_officer', true),
       set_config('deletion.mirror',        :'mirror',        true);
\o

DO $do$
DECLARE
  c_actor      text := current_setting('deletion.actor');
  c_target     text := current_setting('deletion.target');
  c_reason_b64 text := current_setting('deletion.reason_b64');
  c_allow_off  text := current_setting('deletion.allow_officer');
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
  -- THE MIRROR FLAG. '1' when this run is against staging, which is a nightly
  -- unscrubbed copy of prod rather than an independent record. Everything it
  -- changes below is a RELAXATION, never a new power: prod has already run and
  -- already refused, so re-refusing here would only strand the two copies in
  -- different states, with the member deleted on prod and readable on staging.
  v_mirror     boolean := (current_setting('deletion.mirror') = '1');
BEGIN
  -- Resolve the actor. On the mirror a missing actor is survivable: it costs
  -- the audit row (skipped below), not the deletion.
  SELECT count(*) INTO v_n FROM players
   WHERE email = c_actor OR member_code = c_actor OR id::text = c_actor;
  IF v_n <> 1 AND NOT v_mirror THEN
    RAISE EXCEPTION 'actor "%" matched % players, need exactly 1', c_actor, v_n;
  END IF;
  IF v_n = 1 THEN
    SELECT id, full_name INTO v_actor, v_actor_name FROM players
     WHERE email = c_actor OR member_code = c_actor OR id::text = c_actor;
  ELSE
    RAISE NOTICE 'mirror: actor "%" is not on this database; applying the deletion without an audit row', c_actor;
  END IF;

  -- Resolve the target. On the mirror, absent means there is nothing here to
  -- delete, which is the desired end state rather than a failure. Staging can
  -- legitimately lag prod by up to a day.
  SELECT count(*) INTO v_n FROM players
   WHERE email = c_target OR member_code = c_target OR id::text = c_target;
  IF v_n <> 1 THEN
    IF v_mirror THEN
      RAISE NOTICE 'mirror: target "%" matched % rows here, nothing to do', c_target, v_n;
      RETURN;
    END IF;
    RAISE EXCEPTION 'target "%" matched % players, need exactly 1', c_target, v_n;
  END IF;
  SELECT id, full_name, email, member_code, active_flag, deletion_requested_at,
         role, coalesce(is_exec, false), coalesce(is_trainer, false)
    INTO v_target, v_name, v_email, v_code, v_flag, v_stamp,
         v_role, v_exec, v_trainer
   FROM players
   WHERE email = c_target OR member_code = c_target OR id::text = c_target;

  -- Refusals, in the order that gives the most useful message first. Each one
  -- becomes a skip on the mirror: prod is the database that decides, and these
  -- three all describe a state in which the mirror already needs no change.
  IF v_actor = v_target AND NOT v_mirror THEN
    RAISE EXCEPTION 'that is you. Delete your own account from the member settings page, which is the audited self-service path';
  END IF;

  IF v_email LIKE 'deleted+%@deleted.invalid' THEN
    IF v_mirror THEN
      RAISE NOTICE 'mirror: target % (%) is already anonymised here, nothing to do', v_name, v_code;
      RETURN;
    END IF;
    RAISE EXCEPTION 'target % (%) is already purged and anonymised; there is nothing left to schedule', v_name, v_code;
  END IF;

  IF v_stamp IS NOT NULL THEN
    IF v_mirror THEN
      RAISE NOTICE 'mirror: target % (%) already scheduled here (requested %), nothing to do', v_name, v_code, v_stamp;
      RETURN;
    END IF;
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
  --
  -- Skipped on the mirror for a specific reason, not laziness: the snapshot
  -- script re-grants admin to $STAGING_ADMIN_EMAILS after every refresh, so a
  -- member who is an ordinary player on prod can be an admin on staging. Left
  -- in, that mismatch would abort the mirror write AFTER prod had committed.
  IF (v_role = 'admin' OR v_exec OR v_trainer) AND c_allow_off <> '1' AND NOT v_mirror THEN
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
  --
  -- Not written on the mirror. Staging's audit_logs is dropped and reloaded
  -- from prod at 04:00, so a row inserted here survives hours and is then
  -- replaced by prod's copy of the same event. Writing it would create a second
  -- record of one action that disagrees with the real one about its timestamp.
  IF v_actor IS NOT NULL AND NOT v_mirror THEN
    INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
    VALUES (
      v_actor,
      'officer_deletion_requested',
      'player',
      v_target,
      jsonb_build_object('deletion_requested_at', NULL, 'active_flag', v_flag),
      jsonb_build_object('deletion_requested_at', v_now, 'active_flag', false),
      convert_from(decode(c_reason_b64, 'base64'), 'UTF8')
    );
  END IF;
END
$do$;
PLPGSQL
echo "$FINAL"
}

apply_to() {
  local label="$1" container="$2" mirror="$3"
  echo "--- $label ($container) ---"
  emit_sql | ssh "$SSH_HOST" "docker exec -i $container psql -U postgres -d postgres \
    -v ON_ERROR_STOP=1 \
    -v actor=\"$ACTOR\" \
    -v target=\"$TARGET\" \
    -v reason_b64=\"$REASON_B64\" \
    -v allow_officer=\"$ALLOW_OFFICER\" \
    -v mirror=\"$mirror\""
  echo
}

# PROD FIRST, ALWAYS. `set -e` then means a refusal on prod stops the run before
# the mirror is touched, so the two copies can never end up with the member
# deleted on staging and live on production.
case "$DB" in
  prod|both) apply_to "production" "$PROD_CONTAINER" 0 ;;
esac
case "$DB" in
  staging|both) apply_to "staging mirror" "$STAGING_CONTAINER" 1 ;;
esac

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
