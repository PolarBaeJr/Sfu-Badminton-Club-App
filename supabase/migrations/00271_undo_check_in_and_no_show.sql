-- 00271: undo a check-in or a no-show.
--
-- set_field_entry_status only ever moved an entry forward, so a desk that
-- pressed Check In or the no-show X on the wrong row had no way back. It now
-- also takes 'registered', the undo, under the same event lock and only while
-- the event is in check-in. Undoing clears checked_in_at/by, because the
-- attendance list reads the timestamp and an undone check-in did not happen.
--
-- Everything else in the function is 00202 unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_field_entry_status(p_entry_id uuid, p_is_pair boolean, p_new_status text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_before     text;
  v_already    boolean;
BEGIN
  IF p_new_status NOT IN ('checked_in', 'no_show', 'withdrawn', 'disqualified', 'registered') THEN
    RAISE EXCEPTION 'set_field_entry_status: % is not a settable entry status', p_new_status;
  END IF;
  IF p_entry_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'set_field_entry_status: p_entry_id and p_is_pair may not be null';
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Nothing is decided
  -- from this read; every value it produces is re-read below under the lock.
  IF p_is_pair THEN
    SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    SELECT event_id INTO v_event FROM tournament_participants WHERE id = p_entry_id;
  END IF;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- THE ENTRY, RE-READ UNDER THE LOCK. The row could have moved between the
  -- read above and this point; this is the value the write lands against.
  IF p_is_pair THEN
    SELECT status::TEXT INTO v_before FROM tournament_pairs
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  ELSE
    SELECT status::TEXT INTO v_before FROM tournament_participants
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  END IF;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  -- ---- the narrow status guards, per target status ----------------------
  IF p_new_status IN ('checked_in', 'no_show') THEN
    IF v_status = 'registration' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;

  -- Check-in is one of the two that moves a row FORWARD into play, so it cares
  -- what the row was: checking in somebody who has withdrawn would put them
  -- back in the field without anybody deciding to.
  IF p_new_status = 'checked_in' AND v_before NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- AND SO IS no_show -- 00202. See the header above this function.
  IF p_new_status = 'no_show' AND v_before NOT IN ('registered', 'checked_in', 'no_show') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  -- 00271: 'registered' IS THE UNDO, and only the undo. It takes a mistaken
  -- check-in or no-show back to waiting, and only while check-in is still
  -- open: once the draw is published the event has left 'checkin' and the
  -- field is what was drawn. It never revives a withdrawn or disqualified
  -- entry, and a no-show comes back as waiting, not as checked in, so the
  -- waiver check at the door still runs when they do turn up.
  IF p_new_status = 'registered' THEN
    IF v_status <> 'checkin' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
    IF v_before NOT IN ('checked_in', 'no_show', 'registered') THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_undoable',
                                'entry_status', v_before, 'event_status', v_status);
    END IF;
  END IF;

  v_already := (v_before = p_new_status);

  -- A REPEAT PRESS WRITES NOTHING BUT IS NOT AN ERROR HERE. exitDrawImpl needs
  -- to distinguish "already withdrawn, nothing to do" from "already withdrawn,
  -- but the forfeit cascade stopped partway and this retry is what finishes
  -- it" — and only the caller knows which, because only it runs the cascade.
  IF NOT v_already THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW()
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_by END
       WHERE id = p_entry_id;
    ELSE
      UPDATE tournament_participants
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW()
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor
                                  WHEN p_new_status = 'registered' THEN NULL ELSE checked_in_by END
       WHERE id = p_entry_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'already', v_already,
    'entry_status_before', v_before,
    'event_status', v_status,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'draw_locked', COALESCE(v_locked, FALSE)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) TO service_role;

COMMIT;
