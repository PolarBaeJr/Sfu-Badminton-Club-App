ALTER TABLE challenges
ADD COLUMN scheduled_at TIMESTAMPTZ
GENERATED ALWAYS AS (
  CASE
    WHEN scheduled_date IS NOT NULL AND scheduled_time IS NOT NULL
      THEN (scheduled_date + scheduled_time) AT TIME ZONE 'America/Vancouver'
    WHEN scheduled_date IS NOT NULL
      THEN (scheduled_date + TIME '00:00:00') AT TIME ZONE 'America/Vancouver'
    ELSE NULL
  END
) STORED;

CREATE INDEX IF NOT EXISTS idx_challenges_scheduled_at
  ON challenges (scheduled_at)
  WHERE scheduled_at IS NOT NULL;

COMMENT ON COLUMN challenges.scheduled_at IS
  'Generated TIMESTAMPTZ from scheduled_date + scheduled_time (America/Vancouver).';
