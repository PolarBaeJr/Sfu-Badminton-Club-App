#!/usr/bin/env bash
#
# db-migrate.sh - report and apply supabase/migrations against a live database.
#
#   ./scripts/db-migrate.sh status  [prod|staging]
#   ./scripts/db-migrate.sh backfill [prod|staging]
#   ./scripts/db-migrate.sh apply   [prod|staging] <version>
#
# Everything runs over `ssh pi` into the database container. `status` is read
# only and safe to run any time. `backfill` and `apply` write, and print the
# exact SQL they are about to run before running it.
#
# Two things this script exists to get right, both of which have gone wrong by
# hand before:
#
#   1. Transaction wrapping. Some migration files open their own BEGIN/COMMIT
#      (00160) and some do not (00159). Passing --single-transaction to a file
#      that already wraps itself gives you a nested-transaction warning and a
#      commit that does not mean what you think it means. Omitting it on a file
#      that does not wrap itself means a mid-file failure leaves half a
#      migration applied. The script reads the file and decides.
#
#   2. Under-claiming. A migration this script did not watch succeed is never
#      recorded as applied. `status` will keep listing it as pending until
#      someone resolves it. Better a false "pending" than a false "applied".
#
# On staging and the nightly snapshot: until prod has this table, the 04:00
# refresh will drop staging's copy and not put one back, because the prod dump
# it restores from has no such table. Expect to re-apply 00161 and re-backfill
# staging by hand on any morning before prod is done.
#
# Once prod has it, the dump carries schema_migrations along with everything
# else, so a freshly-restored staging reports itself at prod's version rather
# than replaying 153 files. Staging-only migrations applied during the day are
# wiped by the same refresh and correctly show as pending again next morning.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

target="${2:-prod}"
case "$target" in
  prod)    CONTAINER="supabase-db" ;;
  staging) CONTAINER="supabase-staging-db" ;;
  *) echo "unknown target '$target' (expected prod or staging)" >&2; exit 2 ;;
esac

# psql over ssh. Quiet, no pager, fail on the first error rather than plowing on.
psql_value() {
  ssh pi "docker exec -i $CONTAINER psql -U postgres -d postgres -tAq" <<<"$1"
}

checksum() { shasum -a 256 "$1" | awk '{print $1}'; }

# A file "self-wraps" if it issues its own top-level COMMIT. Matching COMMIT
# rather than BEGIN is deliberate: `BEGIN` also opens a plpgsql DO block, so
# BEGIN alone gives false positives (00159 has one at line 51 and is NOT wrapped).
# COMMIT has no plpgsql meaning, so a top-level COMMIT means a real transaction.
self_wraps() { grep -qiE '^[[:space:]]*COMMIT[[:space:]]*;' "$1"; }

table_exists() {
  [ "$(psql_value "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")" = "t" ]
}

# version is the leading number, name is the rest: 00161_schema_migrations.sql
version_of() { basename "$1" .sql | cut -d_ -f1; }
name_of()    { basename "$1" .sql | cut -d_ -f2-; }

cmd_status() {
  if ! table_exists; then
    echo "public.schema_migrations does not exist on $target."
    echo "Apply 00161_schema_migrations.sql first, then run: $0 backfill $target"
    exit 1
  fi

  applied="$(psql_value "SELECT version || ' ' || checksum || ' ' || applied_by FROM public.schema_migrations;")"

  local n_ok=0 n_pending=0 n_drift=0
  local pending=() drift=()

  for f in "$MIGRATIONS_DIR"/*.sql; do
    v="$(version_of "$f")"
    row="$(grep "^$v " <<<"$applied" || true)"
    if [ -z "$row" ]; then
      pending+=("$(basename "$f")")
      n_pending=$((n_pending + 1))
      continue
    fi
    n_ok=$((n_ok + 1))
    recorded="$(awk '{print $2}' <<<"$row")"
    if [ "$recorded" != "$(checksum "$f")" ]; then
      drift+=("$(basename "$f")  (recorded by $(awk '{print $3}' <<<"$row"))")
      n_drift=$((n_drift + 1))
    fi
  done

  # Rows in the table with no matching file. Usually means someone is on a branch
  # that predates a migration, but on prod it would mean a file was deleted after
  # being applied, which is a real problem.
  # `|| true` is load-bearing: with no matching rows the loop's last test fails,
  # and under `set -e` a failing command substitution aborts the whole script.
  orphans="$(while read -r v _; do
      [ -n "$v" ] || continue
      ls "$MIGRATIONS_DIR/${v}_"*.sql >/dev/null 2>&1 || echo "  $v"
    done <<<"$applied" || true)"

  echo "target:   $target ($CONTAINER)"
  echo "files:    $(ls "$MIGRATIONS_DIR"/*.sql | wc -l | tr -d ' ')"
  echo "applied:  $n_ok"
  echo "pending:  $n_pending"
  echo "drifted:  $n_drift"
  echo

  if [ "$n_pending" -gt 0 ]; then
    echo "PENDING - present as a file, absent from schema_migrations:"
    printf '  %s\n' "${pending[@]}"
    echo
  fi
  if [ "$n_drift" -gt 0 ]; then
    echo "DRIFTED - file edited since its checksum was recorded."
    echo "This is informational, not an error. For backfilled rows it usually just"
    echo "means the file changed at some point in its life; the checksum baseline"
    echo "was taken at backfill time, not at apply time, so it cannot distinguish"
    echo "an edit-before-apply from an edit-after-apply."
    printf '  %s\n' "${drift[@]}"
    echo
  fi
  if [ -n "$orphans" ]; then
    echo "ORPHANED - recorded as applied, no matching file in this checkout:"
    echo "$orphans"
    echo
  fi
  [ "$n_pending" -eq 0 ] && echo "Schema is level with this checkout."
}

cmd_backfill() {
  table_exists || { echo "schema_migrations missing; apply 00161 first." >&2; exit 1; }

  existing="$(psql_value "SELECT count(*) FROM public.schema_migrations;")"
  if [ "$existing" != "0" ]; then
    echo "schema_migrations already has $existing rows. Backfill is a one-time"
    echo "operation and refuses to run twice - it would relabel runner-verified"
    echo "rows as unverified guesses. Use 'status' instead." >&2
    exit 1
  fi

  sql_file="$(mktemp)"
  {
    echo "BEGIN;"
    for f in "$MIGRATIONS_DIR"/*.sql; do
      v="$(version_of "$f")"
      # 00161 is the migration that creates this table. If it is being backfilled
      # it plainly did run, so it is the one row we can honestly call verified.
      if [ "$v" = "00161" ]; then verified="true"; by="runner"; else verified="false"; by="backfill"; fi
      printf "INSERT INTO public.schema_migrations (version, name, checksum, applied_by, verified) VALUES ('%s', '%s', '%s', '%s', %s);\n" \
        "$v" "$(name_of "$f")" "$(checksum "$f")" "$by" "$verified"
    done
    echo "COMMIT;"
  } > "$sql_file"

  echo "About to record $(ls "$MIGRATIONS_DIR"/*.sql | wc -l | tr -d ' ') files as applied on $target."
  echo "All but 00161 are marked verified=false: inferred from the checkout, not observed."
  echo "SQL written to $sql_file - read it, then run:"
  echo
  # No --single-transaction here: the generated file opens its own BEGIN/COMMIT.
  # Adding the flag on top nests them and psql warns twice, which is the exact
  # confusion cmd_apply's self_wraps check exists to prevent.
  echo "  ssh pi 'docker exec -i $CONTAINER psql -U postgres -d postgres -v ON_ERROR_STOP=1' < $sql_file"
}

cmd_apply() {
  local v="${3:-}"
  [ -n "$v" ] || { echo "usage: $0 apply $target <version>" >&2; exit 2; }
  local f
  f="$(ls "$MIGRATIONS_DIR/${v}_"*.sql 2>/dev/null | head -1)" || true
  [ -n "$f" ] || { echo "no migration file for version '$v'" >&2; exit 1; }

  table_exists || { echo "schema_migrations missing; apply 00161 first." >&2; exit 1; }
  if [ "$(psql_value "SELECT count(*) FROM public.schema_migrations WHERE version = '$v';")" != "0" ]; then
    echo "$v is already recorded as applied on $target. Refusing to re-apply." >&2
    exit 1
  fi

  if self_wraps "$f"; then
    flag=""
    reason="file issues its own COMMIT, so it manages its own transaction"
  else
    flag=" --single-transaction"
    reason="file has no top-level COMMIT, so psql must wrap it"
  fi

  # The record insert is appended to the migration itself so that it lands in the
  # same transaction as the DDL. A migration that fails must not leave a row
  # claiming it succeeded.
  record="INSERT INTO public.schema_migrations (version, name, checksum, applied_by, verified) VALUES ('$v', '$(name_of "$f")', '$(checksum "$f")', 'runner', true);"

  bundle="$(mktemp)"
  if self_wraps "$f"; then
    # The splice below targets the first top-level COMMIT. With two transactions
    # in one file the record would commit with the first, so a failure in the
    # second would leave a row claiming success for a half-applied migration.
    # No file in the corpus does this today; refuse rather than assume.
    if [ "$(grep -ciE '^[[:space:]]*COMMIT[[:space:]]*;' "$f")" -gt 1 ]; then
      echo "$(basename "$f") has more than one top-level COMMIT." >&2
      echo "This runner cannot record it atomically. Apply it by hand, then insert" >&2
      echo "its row with applied_by='manual'." >&2
      exit 1
    fi
    # Splice the record in before the file's own COMMIT so it commits atomically
    # with the DDL rather than dangling outside the transaction.
    awk -v rec="$record" '
      /^[[:space:]]*COMMIT[[:space:]]*;/ && !done { print rec; done=1 }
      { print }
    ' "$f" > "$bundle"
  else
    cat "$f" > "$bundle"
    echo "$record" >> "$bundle"
  fi

  echo "migration: $(basename "$f")"
  echo "target:    $target ($CONTAINER)"
  echo "wrapping:  $reason"
  echo "bundle:    $bundle  (the file, plus its schema_migrations row)"
  echo
  echo "Read the bundle, then run:"
  echo
  echo "  ssh pi 'docker exec -i $CONTAINER psql -U postgres -d postgres -v ON_ERROR_STOP=1$flag' < $bundle"
}

case "${1:-}" in
  status)   cmd_status ;;
  backfill) cmd_backfill ;;
  apply)    cmd_apply "$@" ;;
  *) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
