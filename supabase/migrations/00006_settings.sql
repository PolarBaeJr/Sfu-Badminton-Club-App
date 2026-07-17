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
    "default_elo": 400,
    "provisional_threshold": 8,
    "singles_k_provisional": 80,
    "singles_k_established": 48,
    "doubles_k_provisional": 64,
    "doubles_k_established": 36
  }'::jsonb),

  ('tournament_bonuses', '{
    "enabled": true,
    "singles_champion": 32,
    "singles_finalist": 20,
    "singles_semifinalist": 12,
    "singles_quarterfinalist": 6,
    "doubles_champion": 28,
    "doubles_finalist": 18,
    "doubles_semifinalist": 10,
    "doubles_quarterfinalist": 4
  }'::jsonb),

  ('season_settings', '{
    "soft_compression_enabled": false,
    "compression_factor": 0.1
  }'::jsonb),

  ('inactivity_rules', '{
    "inactive_threshold_days": 45
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;
