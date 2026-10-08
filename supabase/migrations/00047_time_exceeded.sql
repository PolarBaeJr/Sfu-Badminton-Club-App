-- ============================================================
-- 00047_time_exceeded.sql — record a game the clock ended, not the score
-- ============================================================
-- 00030 taught the app real badminton scoring: a game ends by reaching the
-- target with a two-point margin, or by taking the deuce cap. That is right for
-- a game played to its finish, and it is what isLegalGameScore() enforces.
--
-- Club tournaments are not played to a finish. They run inside a booked gym
-- slot, and when the slot ends the exec calls time on whatever is on court. A
-- game to 21 stopped at 15-2 is a real, correctly-refereed result — the higher
-- score wins — but it satisfies neither the target nor the margin, so score
-- entry refused it outright ("Not a possible score for this format: 15-2") and
-- the exec had no way to record what actually happened. The workarounds were
-- worse than the gap: invent a plausible 21-x scoreline, or void the match and
-- lose the Elo entirely.
--
-- So the exec now says so explicitly, per match. This column is that statement.
-- Setting it relaxes score validation for that match ONLY: any non-tied score
-- within the format's cap is accepted, because a cut-short game can stop at any
-- point on the way to the target. Everything else — no ties (someone has to
-- have been ahead), no negatives, nothing above the cap — still holds, so the
-- relaxation cannot be used to launder an impossible scoreline.
--
-- Why a persisted column rather than a transient flag on the request: the
-- scoreline alone does not say WHY it is odd. Six months later a 15-2 in the
-- bracket is either a shortened game or a data-entry mistake, and only this
-- column tells them apart — for anyone auditing results, and for anyone
-- wondering why validation let that row exist. It travels with the match, like
-- walkover_reason does for the other kind of unfinished match.
--
-- NOT NULL DEFAULT false: every match ever recorded before today WAS played to
-- a finish under the strict rules, so false is the honest backfill, and a
-- three-state boolean would only invite `IS NOT TRUE` bugs at the call sites.
--
-- No CHECK constraint here, deliberately. Tournament results are written by the
-- admin app's service-role client, not through an RPC the way challenges are
-- (00027/00030), so there is no single SQL choke point to hang the rule on —
-- the enforcement lives in enterMatchResult (apps/admin/src/lib/
-- tournament-actions/results.ts), which validates server-side and cannot be
-- bypassed by the dialog's toggle. The cap it checks against comes from
-- pointsCap() in packages/shared, so it follows a custom format automatically
-- instead of assuming 30.
-- ============================================================

ALTER TABLE tournament_matches
  ADD COLUMN IF NOT EXISTS time_exceeded BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tournament_matches.time_exceeded IS
  'The exec called time on this match before it finished — the gym slot ended. Set at score entry, and the reason a score that breaks the normal target/margin rules (15-2 in a game to 21) was accepted for this row: with it set, any non-tied score within the format cap is legal. Recorded so an odd scoreline can later be told apart from a typo.';
