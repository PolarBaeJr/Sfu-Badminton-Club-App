#!/usr/bin/env bash
#
# auth-log-export.sh - export the GoTrue authentication log to CSV or Excel.
#
#   ./scripts/auth-log-export.sh [prod|staging] [options]
#
#   --days N          how far back to go (default 90)
#   --out DIR         where to write (default ./auth-logs)
#   --xlsx            also write a multi-tab .xlsx (needs python3 + openpyxl)
#   --redact-emails   replace the email column with a stable hash
#   --with-token-noise  keep token_refreshed and token_revoked rows
#
# READ ONLY. Every statement is a SELECT. Safe to run any time, against prod,
# during a release, as often as you like. It writes nothing to any database.
#
# Everything runs over `ssh pi` into the database container, the same way
# db-migrate.sh does.
#
# WHY THIS EXISTS: answering "who actually signs in" by hand means remembering
# four things that are easy to get wrong, and getting any of them wrong quietly
# changes the answer rather than producing an error.
#
#   1. TOKEN NOISE. auth.audit_log_entries is roughly 80% `token_refreshed` and
#      `token_revoked`. Those are a background session refresh, not a person
#      signing in. Counting them turns one login into dozens and makes a quiet
#      week look busy. They are dropped by default; --with-token-noise keeps
#      them if you are actually debugging session lifetime.
#
#   2. NAMES. payload->>'actor_name' is whatever the identity provider sent, so
#      it carries stray double spaces and trailing whitespace ("Viraj Veer
#      Chowdhary "). This joins `players` on user_id instead, and falls back to
#      the payload whenever that join yields no usable name: no player row, or
#      a player row whose names are blank.
#
#   3. TIME ZONE. The column is UTC. The club reads local time, and a login at
#      2026-09-21 02:00 UTC happened on the evening of the 20th in Vancouver.
#      Every timestamp here is converted to America/Vancouver.
#
#   4. PROVIDER. `payload->'traits'->>'provider'` is only populated for OAuth.
#      A passkey or an email code login leaves it NULL, which reads as "no
#      provider" rather than "not Google". It is labelled explicitly so an
#      empty cell is never mistaken for missing data.
#
# NOT THE SAME THING AS CONSOLE USE. This is authentication: it says somebody
# signed in, not which app they opened or whether they did anything. auth.sessions
# does not distinguish the player app from the admin console. For "did an officer
# actually change something", read public.audit_logs instead, and exclude the
# self-service action types (self_rating_seeded, self_deletion_requested) or the
# onboarding wave will read as administrative activity.
#
# EMAILS. The export includes the account email, because it is the only reliable
# identifier for someone with no player row. That makes the output personal data:
# it is fine on your machine, and worth thinking about before it goes in a shared
# drive or a group chat. --redact-emails swaps them for a stable hash, which keeps
# rows linkable to each other without naming anyone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

target="prod"
days=90
out_dir="$REPO_ROOT/auth-logs"
want_xlsx=0
redact=0
token_noise=0

# The target is positional and optional, so accept it only as the first argument
# and let everything else fall through to the flag loop.
if [[ "${1:-}" == "prod" || "${1:-}" == "staging" ]]; then
  target="$1"; shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)             days="${2:?--days needs a number}"; shift 2 ;;
    --out)              out_dir="${2:?--out needs a directory}"; shift 2 ;;
    --xlsx)             want_xlsx=1; shift ;;
    --redact-emails)    redact=1; shift ;;
    --with-token-noise) token_noise=1; shift ;;
    -h|--help)          sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option '$1'" >&2; exit 2 ;;
  esac
done

case "$target" in
  prod)    CONTAINER="supabase-db" ;;
  staging) CONTAINER="supabase-staging-db" ;;
  *) echo "unknown target '$target' (expected prod or staging)" >&2; exit 2 ;;
esac

[[ "$days" =~ ^[0-9]+$ ]] || { echo "--days must be a whole number, got '$days'" >&2; exit 2; }

# psql over ssh, CSV out, stop on the first error rather than writing a partial
# file that looks complete.
psql_csv() {
  ssh pi "docker exec -i $CONTAINER psql -U postgres -d postgres -v ON_ERROR_STOP=1 --csv -q" <<<"$1"
}

# md5 of the email plus a fixed salt. Stable across runs so the same person is
# the same hash in two exports, and useless for recovering the address.
if (( redact )); then
  email_expr="'acct-' || substr(md5(coalesce(e.payload->>'actor_username','') || 'sfubadminton-authlog'), 1, 10)"
else
  email_expr="coalesce(e.payload->>'actor_username','')"
fi

if (( token_noise )); then
  noise_filter="true"
else
  noise_filter="e.payload->>'action' NOT IN ('token_refreshed','token_revoked')"
fi

mkdir -p "$out_dir"
stamp="$(date +%Y-%m-%d)"
prefix="$out_dir/auth-$target-$stamp"

echo "target:   $target ($CONTAINER)"
echo "window:   last $days days"
echo "emails:   $( (( redact )) && echo 'redacted to a stable hash' || echo 'included in full' )"
echo "out:      $out_dir"
echo

# ---------------------------------------------------------------- events
# One row per authentication event, newest first. This is the raw log.
psql_csv "
select
  to_char(e.created_at at time zone 'America/Vancouver', 'YYYY-MM-DD HH24:MI:SS') as when_local,
  e.payload->>'action'                                          as action,
  coalesce(nullif(btrim(p.first_name || ' ' || coalesce(p.last_name, '')), ''),
           nullif(btrim(e.payload->>'actor_name'), ''),
           '(no player row)')                                   as person,
  $email_expr                                                   as email,
  coalesce(e.payload->'traits'->>'provider', '(passkey or email code)') as provider,
  coalesce(e.ip_address, '')                                    as ip
from auth.audit_log_entries e
left join players p on p.user_id = (e.payload->>'actor_id')::uuid
where e.created_at > now() - interval '$days days'
  and $noise_filter
order by e.created_at desc;
" > "$prefix-events.csv"

# ---------------------------------------------------------------- per person
# Collapses the log to one row per account: how often, how recently, and by
# which method. This is the tab worth reading first.
psql_csv "
select
  coalesce(nullif(btrim(p.first_name || ' ' || coalesce(p.last_name, '')), ''),
           nullif(btrim(e.payload->>'actor_name'), ''),
           '(no player row)')                                   as person,
  $email_expr                                                   as email,
  count(*) filter (where e.payload->>'action' = 'login')        as logins,
  count(*) filter (where e.payload->>'action' = 'user_signedup') as signups,
  count(*) filter (where e.payload->>'action' = 'user_recovery_requested') as recovery_requests,
  to_char(min(e.created_at) at time zone 'America/Vancouver', 'YYYY-MM-DD') as first_seen,
  to_char(max(e.created_at) at time zone 'America/Vancouver', 'YYYY-MM-DD') as last_seen,
  (current_date - (max(e.created_at) at time zone 'America/Vancouver')::date) as days_since,
  string_agg(distinct coalesce(e.payload->'traits'->>'provider', 'passkey or email code'), ', ') as methods
from auth.audit_log_entries e
left join players p on p.user_id = (e.payload->>'actor_id')::uuid
where e.created_at > now() - interval '$days days'
  and $noise_filter
group by 1, 2
order by max(e.created_at) desc;
" > "$prefix-by-person.csv"

# ---------------------------------------------------------------- by day
psql_csv "
select
  to_char(e.created_at at time zone 'America/Vancouver', 'YYYY-MM-DD') as day_local,
  count(*) filter (where e.payload->>'action' = 'login')      as logins,
  count(distinct e.payload->>'actor_id')
    filter (where e.payload->>'action' = 'login')             as distinct_people,
  count(*) filter (where e.payload->>'action' = 'user_signedup') as signups
from auth.audit_log_entries e
where e.created_at > now() - interval '$days days'
  and $noise_filter
group by 1
order by 1;
" > "$prefix-by-day.csv"

# ---------------------------------------------------------------- totals
# auth.users is the authority on "has this account ever signed in": the audit
# log is trimmed over time, last_sign_in_at is not.
psql_csv "
select 'accounts_total'   as metric, count(*)::text as value from auth.users
union all select 'ever_signed_in',  count(*)::text from auth.users where last_sign_in_at is not null
union all select 'never_signed_in', count(*)::text from auth.users where last_sign_in_at is null
union all select 'signed_in_30d',   count(*)::text from auth.users where last_sign_in_at > now() - interval '30 days'
union all select 'signed_in_7d',    count(*)::text from auth.users where last_sign_in_at > now() - interval '7 days'
union all select 'login_events',    count(*)::text from auth.audit_log_entries
  where payload->>'action' = 'login' and created_at > now() - interval '$days days'
union all select 'distinct_people_logged_in', count(distinct payload->>'actor_id')::text
  from auth.audit_log_entries
  where payload->>'action' = 'login' and created_at > now() - interval '$days days'
union all select 'window_days',     '$days'
union all select 'generated',       to_char(now() at time zone 'America/Vancouver', 'YYYY-MM-DD HH24:MI');
" > "$prefix-totals.csv"

for f in events by-person by-day totals; do
  n=$(( $(wc -l < "$prefix-$f.csv") - 1 ))
  printf '  %-12s %5d rows  %s\n' "$f" "$n" "$prefix-$f.csv"
done

if (( want_xlsx )); then
  echo
  if ! python3 -c "import openpyxl" 2>/dev/null; then
    echo "  --xlsx needs openpyxl. Install it with:  pip3 install openpyxl" >&2
    echo "  The CSVs above are complete and open in Excel as they are." >&2
    exit 1
  fi
  python3 "$REPO_ROOT/scripts/auth-log-xlsx.py" "$prefix"
fi
