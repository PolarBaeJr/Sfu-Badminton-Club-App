-- ============================================================
-- 00109 — retire four tournament columns that decide nothing
--
-- *** RUN THIS AFTER THE CODE IS DEPLOYED, NOT BEFORE. ***
-- Same rule as 00095, for the same reason: the running console selects these
-- columns today, and a dropped column is a PostgREST error and NO ROWS — the
-- tournament list would go blank, not degrade. Deploy the code that stops
-- asking for them first, then run this.
--
-- ------------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------------
-- "why is this here when its not really used here anyways?" — the club owner,
-- about Bracket Size. He was right, and about three more besides. Traced
-- through both apps, this is what each one actually did:
--
--   bracket_size  written, validated 2-128, and read by NOTHING. Generation
--                 computes the size from the field that actually entered
--                 (`nextPowerOf2(N)`, brackets.ts) — which is the only source
--                 that can be right, because a tournament-level number cannot
--                 know who turned up.
--   type          internal | open_official | invitational. Written by the
--                 form, stored, and never read anywhere in either app. Not
--                 even displayed.
--   scope         open | eligible_only. Renders an "ELIGIBLE ONLY" badge and
--                 gates NOTHING. A control that looks like a restriction and
--                 enforces none is worse than an absent one.
--   format        singles | doubles | mixed_event. One display span. Every
--                 real decision — pairing, seeding, standings, the draw — uses
--                 the EVENT's event_type, because that is where the answer
--                 differs per event.
--
-- These are leftovers from before events existed, when a tournament WAS the
-- bracket. Events took over format, size and eligibility and nothing came back
-- to clear the originals.
--
-- WHAT IS NOT DROPPED, and why it is the interesting case:
--   allowed_memberships  the "Open to" checkboxes. This one is REAL — the
--                        player registration path reads it and refuses entry.
--                        It is what Scope only pretended to be.
--   event_multiplier     kept, and given the job the UI already implied it
--                        had. It was displayed to players as "1.15x
--                        MULTIPLIER" while the Elo calculation used the
--                        EVENT's elo_multiplier (default 1.25) and never
--                        looked at this column — so the number on the page was
--                        not the number applied to anyone's rating. It now
--                        seeds a new event's multiplier, which makes the
--                        display true instead of removing it.
-- ============================================================

ALTER TABLE tournaments
  DROP COLUMN IF EXISTS bracket_size,
  DROP COLUMN IF EXISTS type,
  DROP COLUMN IF EXISTS scope,
  DROP COLUMN IF EXISTS format;

-- The enum types go with the columns that used them. DROP TYPE refuses while
-- any column still depends on one, so if a dependency was missed above this
-- fails loudly here rather than leaving a half-retired schema.
DROP TYPE IF EXISTS tournament_type;
DROP TYPE IF EXISTS tournament_scope;
DROP TYPE IF EXISTS tournament_format;

COMMENT ON COLUMN tournaments.event_multiplier IS
  'Default Elo multiplier for events created in this tournament. Seeds tournament_events.elo_multiplier at creation; the event''s own value is what the rating calculation uses, so an event may still differ if an exec changes it.';
