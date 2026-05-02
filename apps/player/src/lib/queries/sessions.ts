/**
 * Canonical Supabase select shape for the player-side `sessions` table joins.
 * Used by both /feed (limit 1, status='open' upcoming) and /sessions (limit 80,
 * Upcoming + Past panels). Centralized so adding a column lights up both
 * surfaces uniformly.
 */
export const SESSION_SELECT_FIELDS =
  'id, name, location, date, notes, status, capacity, start_time, end_time, featured, session_attendance(player_id, players:players(full_name, avatar_url))';
