-- One table for every piece of feedback, whatever it is and wherever it came in.
--
-- There were two stores: feedback_reports (00172), which already carries a kind
-- flag, a source flag and an id, and event_feedback (00001), the post-tournament
-- survey. This folds the second into the first so triage is one query instead of
-- two, and so the in-app form, the Discord commands and the survey all land in
-- the same place.
--
-- discord_feedback_posts is NOT part of this. Despite the name it holds no
-- feedback — it is the relay's map from a report to the Discord message it
-- became, and it is what makes an edit edit rather than repost.
--
-- event_feedback IS DELIBERATELY LEFT IN PLACE. Dropping it here would repeat
-- the club_ledger mistake: the tables went first, the code that read them was
-- live for two more days. The drop is a later migration, after this ships and
-- the code below is running.

-- ---------------------------------------------------------------------------
-- 1. The columns the survey needs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.feedback_reports
  ADD COLUMN IF NOT EXISTS rating        smallint,
  -- CASCADE, unlike player_id's SET NULL. A report outlives its reporter
  -- because a bug is still a bug; feedback about a deleted event is about
  -- nothing at all, which is what event_feedback already did.
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

DO $$ BEGIN
  ALTER TABLE public.feedback_reports
    ADD CONSTRAINT feedback_reports_rating_check CHECK (rating BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. body has to become optional, because a survey can be a rating alone.
-- ---------------------------------------------------------------------------
--
-- 00172 made body NOT NULL because a Discord bug report with no words is
-- nothing. That stops being true once the survey lives here: its comment has
-- always been optional and a bare five stars is a real response. So body goes
-- nullable and the "must say something" rule moves to a check that either a
-- body or a rating is present — which still refuses a completely empty row.
ALTER TABLE public.feedback_reports ALTER COLUMN body DROP NOT NULL;

ALTER TABLE public.feedback_reports DROP CONSTRAINT IF EXISTS feedback_reports_body_check;
ALTER TABLE public.feedback_reports
  ADD CONSTRAINT feedback_reports_body_check
  CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000);

DO $$ BEGIN
  ALTER TABLE public.feedback_reports
    ADD CONSTRAINT feedback_reports_not_empty CHECK (body IS NOT NULL OR rating IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A tournament_id is exactly what makes a row survey feedback, in both
-- directions — so neither a survey response with no event nor a bug report
-- pinned to one can be written by accident.
DO $$ BEGIN
  ALTER TABLE public.feedback_reports
    ADD CONSTRAINT feedback_reports_tournament_kind
    CHECK ((kind = 'tournament_feedback') = (tournament_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 3. One response per player per event — and NOT a partial index.
-- ---------------------------------------------------------------------------
--
-- A partial unique index (WHERE kind = 'tournament_feedback') is the obvious
-- shape and it does not work: Postgres can only infer a partial index when the
-- statement repeats its predicate, and PostgREST's upsert cannot emit that. A
-- plain unique index does the job anyway, because unique indexes treat NULLs as
-- distinct — every bug report has a NULL tournament_id, so any number of them
-- coexist, while two survey responses to the same event collide as intended.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_reports_tournament_player_key
  ON public.feedback_reports (tournament_id, player_id);

-- ---------------------------------------------------------------------------
-- 4. Move the rows.
-- ---------------------------------------------------------------------------
--
-- source='app': the survey has only ever been a form in the player app. The
-- guard is ON CONFLICT rather than a WHERE, so re-running this migration cannot
-- duplicate a response.
INSERT INTO public.feedback_reports
  (kind, body, rating, tournament_id, player_id, source, created_at, updated_at)
SELECT 'tournament_feedback',
       NULLIF(btrim(f.comment), ''),
       f.rating,
       f.tournament_id,
       f.player_id,
       'app',
       f.created_at,
       f.updated_at
  FROM public.event_feedback f
 WHERE f.rating IS NOT NULL OR NULLIF(btrim(f.comment), '') IS NOT NULL
ON CONFLICT (tournament_id, player_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. merge_players has to move these too.
-- ---------------------------------------------------------------------------
--
-- 00163 moves event_feedback rows when two accounts merge, skipping any event
-- the survivor already answered. 00172 deliberately did NOT add feedback_reports
-- to that function — "not worth rewriting history for prose nothing reads yet".
-- That reasoning expires here: once the survey lives in this table, leaving it
-- out means a merge silently strands the loser's responses.
--
-- Kept as a separate statement rather than folded into merge_players' big
-- VALUES list, because it needs the same tournament-scoped skip event_feedback
-- had, not a blind reassignment.
CREATE OR REPLACE FUNCTION public.merge_feedback_reports(p_keep uuid, p_remove uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_moved   int;
  v_dropped int;
BEGIN
  UPDATE feedback_reports x SET player_id = p_keep
   WHERE x.player_id = p_remove
     AND (x.tournament_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM feedback_reports k
                          WHERE k.player_id = p_keep
                            AND k.tournament_id = x.tournament_id));
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  SELECT count(*) INTO v_dropped FROM feedback_reports WHERE player_id = p_remove;

  RETURN jsonb_build_object('moved', v_moved, 'dropped', v_dropped);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_feedback_reports(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.feedback_reports.rating IS
  'Post-event survey rating, 1-5. NULL for every other kind.';
COMMENT ON COLUMN public.feedback_reports.tournament_id IS
  'Set exactly when kind = tournament_feedback; enforced by feedback_reports_tournament_kind.';

NOTIFY pgrst, 'reload schema';
