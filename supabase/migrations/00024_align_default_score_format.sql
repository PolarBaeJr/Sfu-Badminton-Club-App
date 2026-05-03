-- ============================================================================
-- 00024_align_default_score_format.sql
-- Aligns player_preferences.default_score_format CHECK with the existing
-- match_format enum (defined in 00001_schema.sql:30) so the player's
-- preferred score format is actually applicable to challenges and matches.
--
-- Phase 2's CHECK used 'bo3_21' / 'bo3_15' / 'bo1_21' (from an early plan
-- spec) but those don't match match_format ENUM ('bo3_21', 'single_21',
-- 'single_15', 'single_11'). Only 'bo3_21' overlapped, so a player could
-- save a default the system can never apply. This migration replaces the
-- CHECK with the canonical enum values.
--
-- Backfill is unnecessary: the column is brand new (Phase 2) and every
-- backfilled row has the default 'bo3_21' which is valid under both old
-- and new constraints.
-- ============================================================================

ALTER TABLE public.player_preferences
  DROP CONSTRAINT IF EXISTS player_preferences_default_score_format_check;

ALTER TABLE public.player_preferences
  ADD CONSTRAINT player_preferences_default_score_format_check
  CHECK (default_score_format IN ('bo3_21', 'single_21', 'single_15', 'single_11'));
