-- 00156 — a challenge is not club reading
--
-- APPLY AFTER THE DEPLOY THAT SHIPS lib/challenge-visibility.ts, or at the same
-- time. Not because anything breaks if it goes first — every member-key read of
-- these two tables is already participant-scoped, see the audit below — but
-- because the app gate is the half that closes the detail route, and applying
-- the policy first would leave that route rendering somebody else's note for
-- however long the deploy takes. Order it the safe way round and neither half
-- has a window.
--
-- WHAT WAS WRONG
--
--   CREATE POLICY challenges_select ON challenges FOR SELECT TO authenticated
--     USING (TRUE);                                        -- 00005_rls.sql:125
--   CREATE POLICY cp_select ON challenge_participants FOR SELECT TO authenticated
--     USING (TRUE);                                        -- 00005_rls.sql:144
--
-- The comment above the first one says "All can read challenges (for
-- leaderboard context)". The leaderboard does not read challenges — it reads
-- `ratings` and `matches` — so the reason given for the widest possible policy
-- was not true when it was written and has not been true since.
--
-- What the row actually carries is `note`: the free-text line one member types
-- at another when they issue a challenge. Plus who challenged whom, when it
-- expires, and when they arranged to play. One request, no id to guess:
--
--   GET /rest/v1/challenges?select=*,challenge_participants(*)
--
-- returns the club's entire challenge ledger to any signed-in member, notes
-- included. /challenges/[id] rendered the same thing one row at a time with no
-- participant check at all — which is the half the app fix closes.
--
-- WHAT THE NEW POLICIES SAY
--
--   the creator                you can always see a challenge you issued
--   anyone in it               opponent, partner, opponent's partner
--   (admins)                   unchanged — challenges_admin and cp_admin are
--                              permissive FOR ALL policies (00005:137,157) and
--                              are not touched here, so the console's own
--                              service-role reads and any admin token are
--                              exactly as before.
--
-- THE CREATOR DISJUNCT IS LOAD-BEARING, NOT BELT-AND-BRACES. createChallenge
-- (apps/player/src/lib/actions/challenges.ts) inserts the `challenges` row on
-- the MEMBER's key and the participant rows in a SECOND statement on the
-- service role. The first statement is `.insert(...).select().single()`, and
-- PostgREST applies the SELECT policy to the row it returns — at a moment when
-- not one participant row exists yet. A participants-only policy would make
-- every challenge creation in the app fail with "no rows returned", and the
-- member would see a challenge that had in fact been created. It also matters
-- afterwards: if the participant insert ever fails, the creator still needs a
-- screen from which to cancel the orphan.
--
-- WHY A SECURITY DEFINER HELPER AND NOT AN INLINE EXISTS. `cp_select` has to
-- admit the OTHER participants of a challenge you are in — acceptChallenge
-- reads every participant's confirmation_status to decide whether the challenge
-- is now `accepted` or still `partially_confirmed`. Expressed inline that is a
-- policy on challenge_participants whose USING clause selects from
-- challenge_participants, which Postgres answers with 42P17, infinite
-- recursion. A SECURITY DEFINER function runs as its owner, so its inner query
-- is not subject to the policy that called it. (This works because no table
-- here carries FORCE ROW LEVEL SECURITY — there is none in this schema. If one
-- is ever added to challenge_participants, this helper starts recursing and
-- that is where to look.)
--
-- ORDER OF THE DISJUNCTS ON cp_select IS DELIBERATE. `player_id = me` is first
-- and is on its own enough for the one realtime subscription that matters: the
-- members' app watches `challenge_participants` filtered `player_id=eq.<me>`
-- (components/live-matches.tsx), which is how "you have been challenged"
-- arrives live, and that check needs no helper and no join.
--
-- THE ONE THING TO WATCH AFTER APPLYING. These two tables are in the realtime
-- publication (00114), and until now every published table's SELECT policy was
-- `USING (TRUE)` — so this is the first policy Realtime has to evaluate against
-- a subscriber's own identity here. The app's `challenges` subscriptions are
-- filtered `id=eq.<a challenge the server already rendered for this viewer>`,
-- so if Realtime evaluates the policy correctly nothing changes. If live
-- challenge status stops updating on /challenges and /challenges/[id] — the
-- badge goes stale until a refresh — that is this, and it is a degradation
-- rather than a hole. The revert is the two DROP/CREATE pairs at the bottom of
-- this file, commented out.
--
-- `note` IS DELIBERATELY NOT REVOKED. The audit's sketch proposed
-- REVOKE SELECT (note) as well. With these policies the column is only readable
-- by people who are in the match, which is who the member wrote it for — and a
-- column revoke makes PostgREST answer 403 to the WHOLE request rather than
-- blanking one field, which is the failure mode 00115 documents costing five
-- player screens. The narrower policy is the fix; the revoke would be a second
-- one aimed at the same target with a much larger blast radius.

BEGIN;

-- Does this user have a participant row on this challenge? SECURITY DEFINER so
-- it can be called from challenge_participants' own SELECT policy without
-- recursing. Same shape and search_path as is_admin / get_player_id (00003).
CREATE OR REPLACE FUNCTION public.is_challenge_participant(p_challenge_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM challenge_participants cp
     WHERE cp.challenge_id = p_challenge_id
       AND cp.player_id = get_player_id(p_user_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.is_challenge_participant(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_challenge_participant(UUID, UUID) TO authenticated;

DROP POLICY IF EXISTS challenges_select ON public.challenges;

CREATE POLICY challenges_select ON public.challenges
  FOR SELECT TO authenticated
  USING (
    created_by = get_player_id(auth.uid())
    OR is_challenge_participant(id, auth.uid())
  );

DROP POLICY IF EXISTS cp_select ON public.challenge_participants;

CREATE POLICY cp_select ON public.challenge_participants
  FOR SELECT TO authenticated
  USING (
    player_id = get_player_id(auth.uid())
    OR is_challenge_participant(challenge_id, auth.uid())
  );

COMMIT;

NOTIFY pgrst, 'reload schema';

-- VERIFY (as the owner, after applying):
--
--   -- as an ordinary member, this must come back with ONLY challenges they
--   -- are in — previously it returned every challenge in the club:
--   curl -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
--     "$SUPABASE_URL/rest/v1/challenges?select=id,note,challenge_participants(player_id)"
--
--   -- and in the app, as that member: issuing a challenge still works (that is
--   -- the .insert().select() path the creator disjunct exists for), /challenges
--   -- still lists theirs, /challenges/[id] still opens one of theirs, and
--   -- opening somebody else's id now 404s.
--
-- REVERT, if realtime challenge status goes stale and that matters more:
--
--   DROP POLICY IF EXISTS challenges_select ON public.challenges;
--   CREATE POLICY challenges_select ON public.challenges
--     FOR SELECT TO authenticated USING (TRUE);
--   DROP POLICY IF EXISTS cp_select ON public.challenge_participants;
--   CREATE POLICY cp_select ON public.challenge_participants
--     FOR SELECT TO authenticated USING (TRUE);
--   NOTIFY pgrst, 'reload schema';
