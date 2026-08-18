-- 00154 — a dispute is not group reading
--
-- SAFE TO APPLY AT ANY TIME. No app change ships with this one, and that is a
-- finding rather than an omission: the members' app contains no dispute screen
-- at all — no read, no write, no component. The whole feature lives in the
-- console (apps/admin/src/app/disputes, apps/admin/src/lib/actions/disputes.ts)
-- and every one of those reads goes through createAdminClient(), which is the
-- service role and bypasses RLS entirely. Narrowing this policy therefore
-- changes exactly one thing: what a member's own token can fetch straight from
-- PostgREST.
--
-- WHAT WAS WRONG
--
--   CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
--     USING (
--       opened_by = get_player_id(auth.uid()) OR
--       is_admin(auth.uid()) OR
--       match_id IN (SELECT match_id FROM match_participants
--                     WHERE player_id = get_player_id(auth.uid()))
--     );
--
-- The third clause is the defect. "Anyone in the match" is FOUR PEOPLE in
-- doubles, and the row it hands them is not a scoreline:
--
--   reason_category   a dispute_reason enum that includes 'abuse'
--   description       free text, written by the person who opened it
--   resolution_note   the exec's written verdict
--   resolved_by       which officer decided it
--
-- So a member's allegation, in their own words, together with the officer's
-- ruling on it, was readable by their partner and by both opponents — including
-- the person it was about, and including the two people it was not about at
-- all. Nothing in the app ever drew this, which is exactly why it survived: the
-- leak has no screen, only an URL.
--
-- WHAT THE NEW POLICY SAYS
--
--   the person who opened it     their own words and the answer they were given
--   anyone with console access   admin, exec or trainer — the people who handle
--                                these. admin_access_level() is the predicate
--                                the console's own middleware resolves through
--                                (00054, 00087), and matches what 00153 used.
--
-- ON THE PERSON A DISPUTE IS ABOUT. They lose raw read access here, and that is
-- deliberate. Being told what has been alleged about you is a club process an
-- officer runs — a message, a conversation, a decision they explain — not a
-- table any of the four people at a court can query. The old policy did not
-- implement natural justice; it broadcast the file to the doubles court.
--
-- INSERT IS UNTOUCHED. disputes_insert still admits `opened_by = me`, so if a
-- member-facing "dispute this result" screen is ever built it will work; the
-- opener keeps read access to their own row by the first clause above.

BEGIN;

DROP POLICY IF EXISTS disputes_select ON public.disputes;

CREATE POLICY disputes_select ON public.disputes
  FOR SELECT TO authenticated
  USING (
    opened_by = get_player_id(auth.uid())
    OR admin_access_level(auth.uid()) IS NOT NULL
  );

COMMIT;

NOTIFY pgrst, 'reload schema';

-- VERIFY (as the owner, after applying):
--
--   -- as a member who played in a disputed match but did not open it,
--   -- this must come back empty:
--   curl -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
--     "$SUPABASE_URL/rest/v1/disputes?select=description,reason_category"
--
--   -- and /disputes in the console must still list every one of them.
