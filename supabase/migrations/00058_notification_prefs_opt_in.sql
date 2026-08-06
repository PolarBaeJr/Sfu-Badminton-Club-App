-- ============================================================
-- 00058 — notification preferences become OPT-IN, without
--         unsubscribing anybody who already exists
--
-- players.notification_preferences has always been read as
-- opt-OUT: a key that was absent meant "on". The settings UI
-- only ever wrote a key when a member MOVED a toggle, so the
-- blob has no way to tell "never touched it" from "explicitly
-- said yes" — both are simply a missing key. At the time of
-- writing every single players row holds `{}`.
--
-- Flipping the default in code alone (packages/shared/src/utils/
-- notifications.ts) therefore reinterprets every existing row at
-- once and silently unsubscribes the entire club from push AND
-- email on the deploy that ships it. Nobody would see a setting
-- change; the notifications would just stop.
--
-- So the default is flipped in code and the previous effective
-- answer is written down here, explicitly, for every row that
-- exists right now. After this pair ships:
--
--   * existing members keep receiving exactly what they receive
--     today, and their settings page shows those toggles ON,
--     which is what was always true and was never recorded;
--   * rows created afterwards get the `{}` column default, which
--     the new code reads as everything OFF — a new member opts
--     in to what they want.
--
-- MUST be applied together with the code change. The migration
-- alone is a no-op (it writes values the old code already
-- assumed); the code alone is the mass unsubscribe.
--
-- Idempotent: `||` lets the RIGHT side win, so re-running it
-- cannot overwrite a preference a member has since set, and an
-- existing explicit `false` (a one-click unsubscribe under
-- RFC 8058, migration 00037) survives untouched.
-- ============================================================

UPDATE players
   SET notification_preferences =
         jsonb_build_object(
           -- Push (bare keys)
           'challenges',          true,
           'matches',             true,
           'sessions',            true,
           'tournaments',         true,
           'announcements',       true,
           -- Email (`email_` prefix)
           'email_challenges',    true,
           'email_matches',       true,
           'email_sessions',      true,
           'email_tournaments',   true,
           'email_announcements', true
         ) || COALESCE(notification_preferences, '{}'::jsonb);

-- The column default stays `{}` on purpose: that is now the literal
-- representation of "this member has not opted in to anything", and it is what
-- create_player_with_rating (00003) and the admin roster insert both produce.
COMMENT ON COLUMN players.notification_preferences IS
  'Per-category push and email delivery preferences, OPT-IN since 00058: a category is on only when stored as exactly true. Bare keys (challenges, matches, sessions, tournaments, announcements) gate push; the same keys prefixed email_ gate email. Also holds session_reminder_lead_minutes. An empty {} means a member who has not opted in to anything — never assume "on".';
