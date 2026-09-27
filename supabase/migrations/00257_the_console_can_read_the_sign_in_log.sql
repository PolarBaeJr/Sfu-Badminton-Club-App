-- ============================================================
-- 00257_the_console_can_read_the_sign_in_log.sql : one function, so the audit
-- export can answer "who actually signs in"
-- ============================================================
-- SAFE TO APPLY AT ANY TIME, AND SAFE NOT TO. Every statement in the function
-- is a SELECT; it writes nothing, anywhere, ever. The console ships ahead of
-- it: /audit's export offers four other log types that need no function at
-- all, and the sign-ins type answers with a plain 503 naming this file until
-- somebody applies it. Deploy first or apply first, neither breaks the other.
--
-- WHY A FUNCTION AT ALL. `auth.audit_log_entries` belongs to
-- supabase_auth_admin and the `auth` schema is not in PGRST_DB_SCHEMAS, which
-- is `public,storage,graphql_public` (see 00131_anon_remainder.sql, the storage
-- section). There is no select the console's client can issue that reaches
-- those rows, service_role or not, because PostgREST will not route to a schema
-- it was not told about. A SECURITY DEFINER function in `public` is the way in,
-- and it is a narrow one: this reads, shapes and returns, and the shape is the
-- only thing a caller can ask for.
--
-- SEPARATE FROM 00256 ON PURPOSE, twice over. It defines a function and so
-- wraps itself in a transaction, which 00256 deliberately does not; and
-- capability-storage.test.ts resolves the live vocabulary list by the `00256_`
-- filename prefix, so a function definition riding along in that file would put
-- SQL the vocabulary test has to read past into the file it reads.
--
-- ------------------------------------------------------------
-- WHAT THE QUERY GETS RIGHT, AND WHY EACH ONE IS LOAD-BEARING
-- ------------------------------------------------------------
-- This is the events query from scripts/auth-log-export.sh, validated against
-- production on 2026-09-21. Five things about this table are easy to get wrong,
-- and getting any of them wrong quietly changes the answer rather than
-- producing an error:
--
--   1. TOKEN NOISE. auth.audit_log_entries is roughly 80% `token_refreshed`
--      and `token_revoked`. Those are a background session refresh, not a
--      person signing in. Counting them turns one login into dozens and makes
--      a quiet week look busy. They are excluded here with no flag to keep
--      them: this function serves an accountability export, not session
--      debugging.
--
--   2. NAMES. `payload->>'actor_name'` is whatever the identity provider sent,
--      so it carries stray double spaces and trailing whitespace. The person
--      is resolved by joining `players` on the actor uuid instead, and the
--      payload name is used only when that join yields nothing usable: no
--      player row, or a player row whose names are blank.
--
--   3. PROVIDER. `payload->'traits'->>'provider'` is populated for OAuth only.
--      A passkey or an email-code login leaves it NULL, which reads as "no
--      provider" rather than as "not Google". It is labelled explicitly, so an
--      empty cell is never mistaken for missing data.
--
--   4. WHAT A `user_recovery_requested` ROW ACTUALLY IS. GoTrue writes that
--      action for two different events and the raw value names neither. The
--      lateral join below splits them: a recovery row followed by a `login`
--      inside one second is the passkey route calling generateLink and
--      redeeming it server side, so NO email was ever sent, while a gap of
--      more than a second is a human reading a code out of their inbox. Every
--      same-second pair on production belongs to an account holding a passkey,
--      and no account without one has a single pair. Printing the raw value
--      alone would tell the club it emailed 64 recovery codes when it emailed
--      34. Both columns are returned: `action` is the raw GoTrue value and
--      `what` is the classification, so the reader can see the judgement and
--      the evidence for it side by side.
--
--   5. NO IP COLUMN, and that is a finding rather than an omission. On this
--      deployment `ip_address` is blank on all 1768 rows and `payload->>'ip'`
--      is null on all 1768: GoTrue behind this proxy records no address. The
--      export used to carry the column anyway and an officer reading a
--      permanently empty cell would reasonably conclude the club tracks
--      addresses and has lost them. It is not selected here at all.
--
-- `payload` IS `json`, NOT `jsonb` (GoTrue's own column type, which 00155
-- records at the point where it matters). The `->` and `->>` operators read
-- `json` directly, so no cast appears below. 00155 needed `::jsonb` and back
-- only because it WRITES with jsonb_set, and copying that cast into a read
-- would add a per-row conversion for nothing.
--
-- ------------------------------------------------------------
-- occurred_at IS RETURNED RAW, AND THAT IS A DELIBERATE DEPARTURE
-- ------------------------------------------------------------
-- The script it came from formats the timestamp in SQL, as
-- `to_char(created_at at time zone 'America/Vancouver', ...)`, and the export
-- does not. The export merges four sources into one file and three of them are
-- formatted in TypeScript, so formatting this one in SQL would put two clocks
-- in one document. Postgres tzdata and Node ICU tzdata can disagree about
-- Vancouver after 2026-11-01, when British Columbia stops falling back, and a
-- disagreement would land as rows an hour apart in the same column with nothing
-- to explain it. One clock governs the file and it is the TypeScript one.
-- A timestamptz is the honest thing for this function to return in any case:
-- it is a value, and the caller decides how to read it.
--
-- ------------------------------------------------------------
-- WHO MAY CALL IT
-- ------------------------------------------------------------
-- service_role and nobody else, same as 00155's pair. Execute is revoked from
-- PUBLIC, anon and authenticated explicitly rather than relied upon by default,
-- because the default for a new function is EXECUTE to PUBLIC. The rows this
-- returns are account email addresses and sign-in times for the whole club, so
-- an authenticated member reaching it would be a bigger leak than anything the
-- console surface gates. The capability check that decides whether a human may
-- see the output is `audit.signins.read`, in the app, on a service-role client
-- the member's session cannot borrow.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.export_auth_signins(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit int
)
RETURNS TABLE(
  entry_id    uuid,
  occurred_at timestamptz,
  action      text,
  what        text,
  person      text,
  email       text,
  provider    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
  SELECT
    e.id                                                          AS entry_id,
    e.created_at                                                  AS occurred_at,
    e.payload->>'action'                                          AS action,
    CASE
      WHEN e.payload->>'action' <> 'user_recovery_requested' THEN e.payload->>'action'
      WHEN nxt.gap <= 1 THEN 'passkey login'
      WHEN nxt.gap IS NOT NULL THEN 'email code requested'
      ELSE 'email code requested, never used'
    END                                                           AS what,
    coalesce(nullif(btrim(p.first_name || ' ' || coalesce(p.last_name, '')), ''),
             nullif(btrim(e.payload->>'actor_name'), ''),
             '(no player name)')                                  AS person,
    coalesce(e.payload->>'actor_username', '')                    AS email,
    coalesce(e.payload->'traits'->>'provider', '(passkey or email code)') AS provider
  FROM auth.audit_log_entries e
  -- The regex is not decoration. `payload` is json GoTrue writes, not a typed
  -- column, so nothing in the database constrains `actor_id` to be a uuid, and
  -- an unguarded cast RAISES on the first row that is not one. That would take
  -- out the whole export rather than one row, and it would do it to whoever
  -- widened the window far enough to reach the bad row, not to whoever wrote
  -- it. Production is clean today (0 malformed and 0 null across all 1768 rows,
  -- checked 2026-09-21), which is exactly why this is cheap to add now and
  -- unpleasant to debug later. Guarded, a malformed row falls through to the
  -- payload name instead of failing the export. 00155 guards the same cast the
  -- same way, at :107.
  LEFT JOIN public.players p
    ON e.payload->>'actor_id' ~ '^[0-9a-fA-F-]{36}$'
   AND p.user_id = (e.payload->>'actor_id')::uuid
  LEFT JOIN LATERAL (
    -- Same-second heuristic, validated against prod 2026-09-21. See point 4 of
    -- the header: a human reading a code out of their inbox cannot redeem it in
    -- under a second, and the passkey route redeems it server side.
    SELECT extract(epoch FROM min(l.created_at) - e.created_at) AS gap
    FROM auth.audit_log_entries l
    WHERE l.payload->>'action' = 'login'
      AND l.payload->>'actor_id' = e.payload->>'actor_id'
      AND l.created_at >= e.created_at
      AND l.created_at < e.created_at + interval '10 min'
  ) nxt ON true
  WHERE (p_from IS NULL OR e.created_at >= p_from)
    AND (p_to   IS NULL OR e.created_at <  p_to)
    AND e.payload->>'action' NOT IN ('token_refreshed', 'token_revoked')
  ORDER BY e.created_at DESC
  LIMIT coalesce(p_limit, 5000);
$function$;

REVOKE ALL ON FUNCTION public.export_auth_signins(timestamptz, timestamptz, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_auth_signins(timestamptz, timestamptz, int)
  TO service_role;

COMMENT ON FUNCTION public.export_auth_signins(timestamptz, timestamptz, int) IS
  'READ ONLY. One row per authentication event in a window, newest first, for the CSV export on /audit. Excludes token_refreshed and token_revoked (roughly 80% of the table, and a background session refresh rather than a person signing in), resolves the person against public.players rather than trusting payload.actor_name, labels a null OAuth provider explicitly, and classifies user_recovery_requested into the passkey route and the emailed-code route by whether a login follows within one second. Returns occurred_at as a raw timestamptz on purpose: the export formats every source in one place. Exists because auth.audit_log_entries is unreachable through PostgREST, whose PGRST_DB_SCHEMAS is public,storage,graphql_public. Admin surface only: service_role execute, and the app gates it on audit.signins.read.';

COMMIT;
