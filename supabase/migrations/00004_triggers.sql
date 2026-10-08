-- ============================================================
-- 00004_triggers.sql — Triggers
-- ============================================================

-- Generic updated_at trigger function
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at to all relevant tables
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'players', 'ratings', 'seasons', 'sessions', 'challenges',
    'matches', 'tournaments', 'disputes', 'walkovers', 'varsity_notes', 'announcements'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()',
      t
    );
  END LOOP;
END;
$$;

-- ============================================================
-- Auto-initialize ratings + reliability on player approval
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_init_player_records()
RETURNS TRIGGER AS $$
BEGIN
  -- When player moves from pending_approval to any active status
  IF OLD.status = 'pending_approval' AND NEW.status != 'pending_approval' THEN
    INSERT INTO ratings (player_id) VALUES (NEW.id)
    ON CONFLICT (player_id) DO NOTHING;

    INSERT INTO reliability_metrics (player_id) VALUES (NEW.id)
    ON CONFLICT (player_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER init_player_records
  AFTER UPDATE OF status ON players
  FOR EACH ROW
  EXECUTE FUNCTION trigger_init_player_records();

-- ============================================================
-- Auto-update head_to_head and partnership_stats on match confirm
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_match_confirmed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.result_status = 'confirmed' AND (OLD.result_status IS DISTINCT FROM 'confirmed') THEN
    PERFORM update_head_to_head(NEW.id);
    PERFORM update_partnership_stats(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER on_match_confirmed
  AFTER UPDATE OF result_status ON matches
  FOR EACH ROW
  EXECUTE FUNCTION trigger_match_confirmed();

-- ============================================================
-- Auto-flag player on no-show threshold breach
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_check_noshow_threshold()
RETURNS TRIGGER AS $$
DECLARE
  v_threshold INTEGER;
  v_suspend_threshold INTEGER;
BEGIN
  IF NEW.no_shows > OLD.no_shows THEN
    -- Get thresholds from platform_settings
    SELECT COALESCE((value->>'no_show_auto_flag_threshold')::INTEGER, 3)
    INTO v_threshold FROM platform_settings WHERE key = 'walkover_rules';

    SELECT COALESCE((value->>'no_show_auto_suspend_threshold')::INTEGER, 5)
    INTO v_suspend_threshold FROM platform_settings WHERE key = 'walkover_rules';

    -- Auto-flag
    IF NEW.no_shows >= v_threshold THEN
      UPDATE reliability_metrics SET walkover_flag = TRUE WHERE id = NEW.id;

      -- Create admin notification
      INSERT INTO notifications (player_id, type, title, body, metadata)
      SELECT p.id, 'admin_alert',
        'Player flagged for repeated no-shows',
        format('%s has %s no-shows', pl.full_name, NEW.no_shows),
        jsonb_build_object('flagged_player_id', NEW.player_id, 'no_shows', NEW.no_shows)
      FROM players p
      CROSS JOIN players pl
      WHERE p.role = 'admin' AND pl.id = NEW.player_id;
    END IF;

    -- Auto-suspend check
    IF NEW.no_shows >= v_suspend_threshold THEN
      UPDATE players SET status = 'suspended' WHERE id = NEW.player_id;

      INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
      VALUES (NULL, 'auto_suspend', 'player', NEW.player_id, NULL, jsonb_build_object('no_shows', NEW.no_shows),
        format('Auto-suspended: %s no-shows exceeded threshold of %s', NEW.no_shows, v_suspend_threshold));
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER check_noshow_threshold
  AFTER UPDATE OF no_shows ON reliability_metrics
  FOR EACH ROW
  EXECUTE FUNCTION trigger_check_noshow_threshold();

-- ============================================================
-- Auto-set format_weight and event_multiplier on match insert
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_set_match_weights()
RETURNS TRIGGER AS $$
BEGIN
  NEW.format_weight := get_format_weight(NEW.format);
  IF NEW.event_multiplier IS NULL OR NEW.event_multiplier = 0 THEN
    NEW.event_multiplier := get_event_multiplier(NEW.event_type);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_match_weights
  BEFORE INSERT ON matches
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_match_weights();
