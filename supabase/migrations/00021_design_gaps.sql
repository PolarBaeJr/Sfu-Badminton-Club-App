-- ============================================================================
-- 00021_design_gaps.sql
-- Schema columns the v3 design needs but the current schema doesn't yet
-- expose. Adds nullable / default-bearing columns so existing rows keep
-- working. No data migration required.
--
-- Surfaces backed:
--   • Sessions cards (player & admin)        : capacity, start_time, end_time, featured
--   • Feed Up Next "FRI · 7 PM" line         : start_time, end_time
--   • Settings → Edit Profile, Playing Detl. : dominant_hand, years_playing, favourite_shot
--   • Onboarding wizard                      : skill_level, format_preference, goal, sfu_student_id
--   • Admin Disputes "Submissions" column    : match_participants.submitted_score
-- ============================================================================

-- ── sessions ────────────────────────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS capacity   INTEGER  DEFAULT 20,
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time   TIME,
  ADD COLUMN IF NOT EXISTS featured   BOOLEAN  DEFAULT false NOT NULL;

COMMENT ON COLUMN public.sessions.capacity   IS 'Max attendees (used by % full progress bar and Open/Full badge).';
COMMENT ON COLUMN public.sessions.start_time IS 'Session start clock time. Combined with sessions.date for "Fri 7:00–9:00pm" line.';
COMMENT ON COLUMN public.sessions.end_time   IS 'Session end clock time.';
COMMENT ON COLUMN public.sessions.featured   IS 'When true, surface in Feed Up Next and pin red border on Sessions list.';

-- ── players ─────────────────────────────────────────────────────────────────
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS dominant_hand     TEXT,         -- 'left' | 'right' | 'ambidextrous'
  ADD COLUMN IF NOT EXISTS years_playing     TEXT,         -- free-text bucket: '<1', '1-3', '3-5', '5+'
  ADD COLUMN IF NOT EXISTS favourite_shot    TEXT,         -- free-text e.g. 'Backhand smash'
  ADD COLUMN IF NOT EXISTS skill_level       TEXT,         -- 'beginner' | 'casual' | 'intermediate' | 'advanced'
  ADD COLUMN IF NOT EXISTS format_preference TEXT,         -- 'singles' | 'doubles' | 'both'
  ADD COLUMN IF NOT EXISTS goal              TEXT,         -- onboarding free-text
  ADD COLUMN IF NOT EXISTS sfu_student_id    VARCHAR(9);   -- 9-digit SFU ID

COMMENT ON COLUMN public.players.dominant_hand     IS 'Settings → Edit Profile → Playing details.';
COMMENT ON COLUMN public.players.years_playing    IS 'Settings → Edit Profile → Playing details.';
COMMENT ON COLUMN public.players.favourite_shot   IS 'Settings → Edit Profile → Playing details.';
COMMENT ON COLUMN public.players.skill_level      IS 'Onboarding step 3 — drives starting ELO bucket.';
COMMENT ON COLUMN public.players.format_preference IS 'Onboarding step 4 + Settings → Preferences default.';
COMMENT ON COLUMN public.players.goal             IS 'Onboarding step 4 free-text.';
COMMENT ON COLUMN public.players.sfu_student_id   IS 'Onboarding step 2 — 9-digit SFU student card number.';

-- Light validation
ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_skill_level_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_skill_level_check
  CHECK (skill_level IS NULL OR skill_level IN ('beginner', 'casual', 'intermediate', 'advanced'));

ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_format_preference_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_format_preference_check
  CHECK (format_preference IS NULL OR format_preference IN ('singles', 'doubles', 'both'));

ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_dominant_hand_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_dominant_hand_check
  CHECK (dominant_hand IS NULL OR dominant_hand IN ('left', 'right', 'ambidextrous'));

ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_sfu_student_id_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_sfu_student_id_check
  CHECK (sfu_student_id IS NULL OR sfu_student_id ~ '^[0-9]{9}$');

-- ── match_participants ──────────────────────────────────────────────────────
ALTER TABLE public.match_participants
  ADD COLUMN IF NOT EXISTS submitted_score TEXT;

COMMENT ON COLUMN public.match_participants.submitted_score IS
  'Per-player score string submitted independently. Drives admin Disputes "Submissions" column when both sides disagree.';
