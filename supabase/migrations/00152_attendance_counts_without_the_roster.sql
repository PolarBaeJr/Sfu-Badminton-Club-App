-- 00152 — the number on the card, without the roster behind it
--
-- APPLY THIS BEFORE THE APP DEPLOY. It is purely additive — one new function,
-- nothing dropped, nothing narrowed — so applying it early costs nothing and
-- applying it late means every session card prints a zero attendee count until
-- it lands. Its companion, 00153, narrows the policy and must be applied AFTER
-- the deploy. The order across all three is:
--
--     00152  ->  app deploy  ->  00153
--
-- WHY IT EXISTS
--
-- `attendance_select` on session_attendance is `USING (TRUE)` (00005_rls.sql)
-- and status / checked_in_at / marked_by are all granted, so any signed-in
-- member can ask PostgREST for the club's itemised no-show and excused-absence
-- history. 00153 closes that. The one cross-member fact the members' app
-- actually needs from the table is the attendee count on a session card, and a
-- count is not a roster — so it moves here, behind SECURITY DEFINER, returning
-- session ids and integers and nothing about any individual.
--
-- The statuses are the same two the page filtered on: an admin-marked no-show
-- or excused absence is not somebody who turned up.
--
-- SIZE. The direct read this replaces had to be chunked AND paged, because
-- production sets PGRST_DB_MAX_ROWS=1000 and 25 sessions of 40 members is
-- exactly that cap. This returns one row per session, so the cap stops being
-- anywhere near — and the count is exact rather than exact-if-paged-correctly.

CREATE OR REPLACE FUNCTION public.get_session_attendee_counts(p_session_ids uuid[])
RETURNS TABLE(session_id uuid, attendees int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT sa.session_id, COUNT(*)::int AS attendees
  FROM session_attendance sa
  WHERE sa.session_id = ANY(p_session_ids)
    AND sa.status IN ('checked_in', 'present')
  GROUP BY sa.session_id;
$function$;

COMMENT ON FUNCTION public.get_session_attendee_counts(uuid[]) IS
  'Attendee counts for a set of sessions: one row per session that has at least one attendee, and nothing about any individual. SECURITY DEFINER because 00153 narrows attendance_select to the member''s own rows — this is how a session card keeps its number without the roster becoming readable. Counts ''checked_in'' and ''present'' only; an admin-marked no-show or excused absence is not somebody who turned up, which is the filter the page applied before this existed. A session with no attendees returns NO ROW rather than a zero, so callers must default a missing key to 0 (apps/player/src/lib/session-attendee-counts.ts does).';

-- anon has no business with this: the schedule is behind the login.
GRANT EXECUTE ON FUNCTION public.get_session_attendee_counts(uuid[]) TO authenticated;

-- PostgREST caches the schema; a new function is invisible to it until told.
-- Without this the app's rpc() call gets PGRST202, which its fallback reads as
-- "not applied yet" — the deploy would keep using the direct read and 00153
-- would then break the counts.
NOTIFY pgrst, 'reload schema';

-- VERIFY (as the owner, after applying):
--
--   SELECT * FROM get_session_attendee_counts(
--     ARRAY(SELECT id FROM sessions ORDER BY date DESC LIMIT 5)
--   );
--
-- and the same numbers should appear on the member app's session cards.
