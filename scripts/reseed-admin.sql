-- Reseed the admin/exec account after the fresh-schema apply.
-- auth.users id below = chengmatthew2005@gmail.com (verified 2026-07-18).
SELECT create_player_with_rating(
  '096fe767-903c-44fd-bc6d-3a6918eb8183',
  'chengmatthew2005@gmail.com',
  'Matthew Cheng',
  NULL,            -- display_name
  NULL,            -- phone
  'competitive',   -- status
  'admin'          -- role
);

UPDATE players
   SET is_exec = TRUE,
       onboarding_completed = TRUE
 WHERE email = 'chengmatthew2005@gmail.com';
