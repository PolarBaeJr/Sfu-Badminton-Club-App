-- ============================================================
-- 00063_purge_after_days_setting.sql — the retention period, as
-- a setting rather than a literal
--
-- The club owner approved anonymising a membership that has been
-- inactive for a year. 365 is that decision's current value, not
-- a law: it belongs next to inactive_threshold_days in the
-- Accounts settings page, where an exec can see it and change it,
-- and where the notice email reads it so the copy and the job can
-- never disagree about what the club actually does.
--
-- jsonb_set on the existing row rather than a new platform_settings
-- key, so the two halves of one policy stay together: 120 days to
-- lapse, 365 more to be anonymised.
--
-- The || form adds the key only when it is missing, so re-running
-- this migration never resets a value an exec has since changed.
-- ============================================================

UPDATE platform_settings
   SET value = '{"purge_after_days": 365}'::jsonb || value
 WHERE key = 'inactivity_rules'
   AND NOT (value ? 'purge_after_days');

-- Stands alone if the settings seed (00006) ever runs after this.
INSERT INTO platform_settings (key, value)
VALUES ('inactivity_rules', '{
  "inactive_threshold_days": 120,
  "purge_after_days": 365
}'::jsonb)
ON CONFLICT (key) DO NOTHING;
