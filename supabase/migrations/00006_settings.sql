-- ============================================================
-- 00006_settings.sql — Default platform settings
-- ============================================================

INSERT INTO platform_settings (key, value) VALUES
  ('challenge_rules', '{
    "elo_range": 150,
    "ladder_range": 3,
    "max_active_challenges": 3,
    "challenge_expiry_hours": 72
  }'::jsonb),

  ('session_caps', '{
    "max_rated_singles_per_session": 3,
    "max_rated_doubles_per_session": 3
  }'::jsonb),

  ('repeat_opponent_caps', '{
    "max_rated_singles_vs_same_7days": 2,
    "max_rated_doubles_same_combo_7days": 2
  }'::jsonb),

  ('walkover_rules', '{
    "grace_period_minutes": 15,
    "admin_review_window_hours": 48,
    "late_withdrawal_threshold_hours": 24,
    "no_show_auto_flag_threshold": 3,
    "no_show_auto_flag_rolling_days": 30,
    "no_show_auto_suspend_threshold": 5
  }'::jsonb),

  ('rating_defaults', '{
    "default_elo": 1200,
    "provisional_threshold": 8,
    "singles_k_provisional": 40,
    "singles_k_established": 24,
    "doubles_k_provisional": 32,
    "doubles_k_established": 18
  }'::jsonb),

  ('tournament_bonuses', '{
    "enabled": true,
    "singles_champion": 16,
    "singles_finalist": 10,
    "singles_semifinalist": 6,
    "singles_quarterfinalist": 3,
    "doubles_champion": 14,
    "doubles_finalist": 9,
    "doubles_semifinalist": 5,
    "doubles_quarterfinalist": 2
  }'::jsonb),

  ('season_settings', '{
    "soft_compression_enabled": false,
    "compression_factor": 0.1
  }'::jsonb),

  ('inactivity_rules', '{
    "inactive_threshold_days": 45
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;
