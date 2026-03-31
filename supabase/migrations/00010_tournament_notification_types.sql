-- Add tournament-specific notification types to the enum
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'tournament_bracket_published';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'tournament_match_ready';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'tournament_match_result';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'tournament_event_completed';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'tournament_checkin_open';
