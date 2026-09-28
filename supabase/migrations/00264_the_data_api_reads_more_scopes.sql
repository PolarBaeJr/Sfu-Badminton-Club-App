-- ============================================================
-- 00264 THE DATA API READS MORE SCOPES
--
-- WHAT CHANGES: the scope vocabulary CHECK on data_api_keys grows from three
-- strings to six. Nothing else.
--
--   players:read          (00241) the roster and lifetime ratings
--   matches:read          (00241) match history, head-to-head, season records
--   ratings:history:read  (00241) per-match rating history
--   seasons:read          (new)   seasons, season totals, season standings
--   tournaments:read      (new)   tournaments, events, entrants, draws
--   schedule:read         (new)   upcoming and past sessions and club events
--
-- A CORRECTION TO 00241. Its comment on this CHECK says ratings:history:read
-- is admitted and "backed by nothing" because nothing journals a per-match
-- rating change. That was wrong: match_participants stores post_rating and
-- rating_delta, and tournament_matches.elo_snapshot stores before, after and
-- delta per player. 00265 serves it.
--
-- EXISTING KEYS KEEP WORKING. The new array is a superset of the old one, and
-- the verify block below proves every stored row still satisfies it before
-- the transaction commits. The console can now rewrite `scopes` on a live key
-- (service_role already holds UPDATE on data_api_keys from 00241), so a key is
-- upgraded rather than re-minted.
--
-- data_api_keys_scope_not_empty is not touched.
-- ============================================================

BEGIN;

ALTER TABLE public.data_api_keys
  DROP CONSTRAINT IF EXISTS data_api_keys_scope_vocabulary,
  ADD CONSTRAINT data_api_keys_scope_vocabulary
    CHECK (scopes <@ ARRAY[
      'players:read',
      'matches:read',
      'ratings:history:read',
      'seasons:read',
      'tournaments:read',
      'schedule:read'
    ]::text[]);

DO $verify$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.data_api_keys
   WHERE NOT scopes <@ ARRAY['players:read', 'matches:read', 'ratings:history:read',
                             'seasons:read', 'tournaments:read', 'schedule:read']::text[];
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '00264: % stored keys carry a scope outside the new vocabulary', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.data_api_keys'::regclass
                    AND conname = 'data_api_keys_scope_not_empty') THEN
    RAISE EXCEPTION '00264: data_api_keys_scope_not_empty is missing';
  END IF;

  -- An unknown scope must still be refused. The consumer and key rows are
  -- written inside a subtransaction that the CHECK violation rolls back.
  BEGIN
    INSERT INTO public.data_api_consumers (id, name)
    VALUES ('00000000-0000-0000-0000-000000000264', '00264 self-check');
    INSERT INTO public.data_api_keys (consumer_id, key_hash, key_prefix, scopes)
    VALUES ('00000000-0000-0000-0000-000000000264', repeat('0', 64), 'sfubad_x', ARRAY['players:write']);
    RAISE EXCEPTION '00264: an unknown scope was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  RAISE NOTICE '00264 verified: six scopes admitted, unknown scopes refused, every stored key still valid.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
