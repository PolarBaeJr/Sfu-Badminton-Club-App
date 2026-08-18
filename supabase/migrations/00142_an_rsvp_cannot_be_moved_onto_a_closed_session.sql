-- ============================================================
-- 00142_an_rsvp_cannot_be_moved_onto_a_closed_session.sql — the half of the
-- RSVP guard that was never tightened
-- ============================================================
-- SAFE TO APPLY AT ANY TIME, BEFORE OR AFTER THE DEPLOY. The app already
-- behaves as though this policy were in place, so applying it changes nothing
-- any member can see. That is checked below, not assumed.
--
-- ------------------------------------------------------------
-- WHAT IS OPEN
-- ------------------------------------------------------------
-- Live and identical on prod and staging:
--
--   session_rsvp_insert  WITH CHECK ( player_id = self
--                                     AND EXISTS(sessions WHERE id = session_id
--                                                AND status = 'open') )
--   session_rsvp_update  USING ( player_id = self )  WITH CHECK ( player_id = self )
--
-- 00016 required the session to be OPEN to file an RSVP and did not require it
-- to change one. The UPDATE policy also never pinned `session_id`, so a member
-- posting straight at PostgREST with their own key can PATCH their own RSVP row
-- onto any session at all — one that is closed, or on a track they cannot play.
--
-- The reachable damage is small and worth stating plainly rather than inflating:
-- `UNIQUE(session_id, player_id)` stops them holding two RSVPs for one session
-- and `intent` is enum-bounded, so what they can produce is a "going" count on a
-- closed session that is one too high — a number on a card
-- (apps/admin/src/app/sessions/page.tsx:585,
-- apps/player/src/app/sessions/page.tsx:138). It is a data-integrity nit, not a
-- door problem. It is here because the guard was clearly INTENDED — the insert
-- policy states it — and half-applied guards are how the next person concludes
-- the rule does not exist.
--
-- ------------------------------------------------------------
-- WHY THIS CANNOT BREAK THE APP
-- ------------------------------------------------------------
-- `session_rsvp` has exactly one writer reachable by a member's own key:
-- setSessionIntentImpl (apps/player/src/lib/actions/sessions.ts:174). It reads
-- `sessions.status` and throws "This session is closed" BEFORE it writes, then
-- either deletes the row or upserts it. So every UPDATE the app performs
-- already satisfies the clause being added, and the only requests this newly
-- refuses are ones the app would never have made.
--
-- The nightly reminder job stamps `session_rsvp.reminded_at`, but it runs as
-- service_role and RLS does not apply to it.
--
-- DELETE IS DELIBERATELY NOT TOUCHED. Withdrawing an RSVP from a session that
-- has since closed is not the same act as adding one, the app refuses it in its
-- own code anyway, and tightening a policy nobody has shown to be a problem is
-- how a fix acquires a second, unexamined change.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS session_rsvp_update ON public.session_rsvp;

-- Both halves carry the clause. USING decides which existing rows may be
-- touched; WITH CHECK decides what they may become — and it is WITH CHECK that
-- stops the row being moved ONTO a closed session, which is the actual bug.
-- With only one of the two this would be half-fixed in a different way.
CREATE POLICY session_rsvp_update ON public.session_rsvp FOR UPDATE TO authenticated
  USING (
    player_id = get_player_id(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.sessions s
       WHERE s.id = session_rsvp.session_id
         AND s.status = 'open'
    )
  )
  WITH CHECK (
    player_id = get_player_id(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.sessions s
       WHERE s.id = session_rsvp.session_id
         AND s.status = 'open'
    )
  );

COMMIT;

-- ============================================================
-- VERIFY
-- ============================================================
-- Both clauses present on both halves — the point is that `qual` and
-- `with_check` now read the same:
--
--   SELECT qual, with_check FROM pg_policies
--    WHERE tablename = 'session_rsvp' AND policyname = 'session_rsvp_update';
--
-- And the behaviour, as a member rather than as postgres. With `sub` set to a
-- member who holds an RSVP on an OPEN session:
--
--   PATCH /rest/v1/session_rsvp?session_id=eq.<open>&player_id=eq.<self>
--     {"session_id": "<a closed session's id>"}
--
-- Before: 200, and the row moves. After: 403, code 42501, "new row violates
-- row-level security policy" — a REFUSAL, not a silent no-op, because it is the
-- WITH CHECK half that catches it.
--
-- ------------------------------------------------------------
-- THIS WAS RUN, NOT ONLY REASONED ABOUT
-- ------------------------------------------------------------
-- Exercised against a throwaway Postgres 16 with the two policies side by side:
--
--   old policy  -> UPDATE 1, the row lands on the closed session (the bug)
--   this policy -> ERROR 42501, the row is unchanged
--   this policy -> UPDATE 1 for `SET intent = 'declined'` on the OPEN session,
--                  which is the act members actually perform and must not break
--
-- The third line is the one worth keeping: the first two would both pass
-- against a policy that simply refused everything.
