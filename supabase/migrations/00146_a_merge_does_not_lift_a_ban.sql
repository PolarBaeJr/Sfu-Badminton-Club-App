-- ============================================================
-- 00146 — a merge is not a way to lift a ban or cancel a deletion
-- ============================================================
-- SCOPE. The 2026-08-17 fix list reserves 00146 for two things:
-- "ensure_player_for_user backfill; merge_players refusing a banned/
-- deletion-pending loser". ONLY THE SECOND IS HERE, and the reason is the same
-- one 00138 §0 gives for not writing a literal body: ensure_player_for_user is
-- 00132's function and 00132 IS NOT APPLIED TO PRODUCTION. plpgsql resolves
-- callees at run time, so a backfill shipped here would not fail on apply — it
-- would fail the first time somebody ran it, halfway through, on the database
-- that has no such function. The backfill belongs in the same sitting as 00132
-- and is deliberately left out.
--
-- APPLY ORDER: FREE. The signature is unchanged, no cache reload is needed, and
-- no application change accompanies this file. Applying it before or after the
-- app deploy changes nothing for the app; the merge tool simply starts refusing
-- two cases it used to accept silently.
--
-- ============================================================
-- WHAT IS BROKEN
-- ============================================================
-- merge_players() has four guards and every one of them is about GAMEPLAY and
-- SCHEMA — an unclassified CASCADE column, real history on the loser (matches,
-- money, tournaments), two logins, merging a row into itself. It never looks at
-- the loser's STANDING. Then it does this:
--
--     DELETE FROM players WHERE id = p_remove;
--
-- and, three lines later, states the rule that makes the omission bite:
--
--     "The SURVIVOR's own fields always win — name, email, status, everything
--      the admin entered on the roster record is preserved."
--
-- SO MERGING A BANNED DUPLICATE INTO A CLEAN ROW SILENTLY LIFTS THE BAN. The
-- row carrying is_banned, banned_at, banned_by and ban_reason is deleted; the
-- survivor's FALSE wins because the survivor's fields always win; and the audit
-- row the function writes records removed_id, removed_email, removed_name and
-- removed_user_id — not one of the four ban columns. There is no trace of the
-- moderation decision anywhere afterwards. An admin holding players.merge.write
-- undoes a ban without holding players.reinstate.write, without a reinstatement
-- fee, and without anything on /audit reading as an unban.
--
-- REACHABLE TODAY, AND NARROWLY SO — which is what makes it worth a guard
-- rather than a comment. merge_players_preview counts club_fees on the loser
-- and BLOCKS on any row, so a duplicate who has ever been reinstated cannot be
-- merged at all (the fee row stops it). What gets through is precisely the
-- member who is banned RIGHT NOW and has never been reinstated: no fee row, no
-- history, exactly the shape of a duplicate somebody would tidy up. The pending
-- `wui KI Cheng` merge is in this class of act.
--
-- deletion_requested_at IS THE SAME FAILURE WITH A LEGAL EDGE. 00012: the
-- account is deactivated immediately, the purge job anonymises the row after 30
-- days, "and the column stays set on anonymized rows as a tombstone so they
-- remain identifiable". Deleting that row in a merge does two different wrong
-- things depending on which side of the purge it is on — it cancels a deletion
-- the club promised a member, or it destroys the tombstone that says an
-- anonymised row was once a person who asked to leave. Neither is a thing a
-- duplicate-cleanup tool should be able to do.
--
-- ============================================================
-- REFUSE, NOT CARRY FORWARD
-- ============================================================
-- The function already carries the OR-forward pattern twice and says why:
-- "walkover_flag is OR: merging must not be a way to clear a flag", and 00138 §0
-- applied the same operator to onboarding_completed. The obvious move is a third
-- OR. IT IS THE WRONG MOVE FOR BOTH COLUMNS, for different reasons.
--
--   is_banned IS NOT A FLAG, IT IS FOUR COLUMNS AND AN IDENTITY. A ban is
--   is_banned + banned_at + banned_by + ban_reason, and banned_at is the ban
--   EPISODE KEY: club_fees.ban_started_at snapshots it and
--   club_fees_reinstatement_ban_key UNIQUE (player_id, ban_started_at) (00065,
--   00094) makes one reinstatement fee per ban true rather than hoped for. To
--   carry a ban forward you would have to move an episode identity onto a row
--   that may already hold its own, decide which of two banned_at values the
--   survivor keeps, and reconcile the fee rows keyed against the loser — which
--   merge_players cannot even see, because club_fees on the loser blocks the
--   merge outright. A refusal makes the admin do the moderation as moderation:
--   ban the survivor, or unban the loser, through banPlayer / reinstatePlayer,
--   each of which files its own audit row with a reason. A carried-forward ban
--   would be a moderation decision recorded as 'players_merged'.
--
--   CARRYING deletion_requested_at FORWARD IS AFFIRMATIVELY DANGEROUS. It would
--   schedule the SURVIVOR — the row holding all the history, the login and the
--   ratings — for anonymisation by the purge job. The safe-looking option is the
--   destructive one here.
--
-- Two separate RAISEs rather than one combined message, each naming its own
-- remedy, in the voice the existing guards use ("Merge the other direction, or
-- clear these first." / "Delete one auth user first, then merge.").
--
-- WHERE THEY GO: after every existing guard and before the first write. The
-- function's first write is the NO ACTION repoint block, so a refusal raised
-- above it cannot leave anything half-done — though the function is one
-- statement and would roll back regardless. Placing them last among the guards
-- keeps the cheap schema/history checks first, so an admin merging a
-- history-carrying row still gets the more useful message.
--
-- NOT ADDED TO merge_players_preview. The preview counts ROWS IN OTHER TABLES
-- and returns (table_name, row_count, effect); "this member is banned" is a
-- column on players and has no row count. Forcing it into that shape would make
-- previewPlayerMerge — which filters to row_count > 0 — either miss it or print
-- a fake count. The console will surface these as the merge's own error, the
-- same way it surfaces the two-logins refusal, which is not in the preview
-- either.
--
-- ============================================================
-- MECHANICS — PATCHED IN THE LIVE BODY, ON 00138 §0's PATTERN
-- ============================================================
-- 00138 §0 measured this exact function and found TWO live definitions:
-- production 197 lines, staging 209, differing by 00123's
-- recompute_player_stats block — a function that does not exist on production.
-- Its conclusion stands unchanged here and is the reason this file is a
-- substitution and not a CREATE OR REPLACE carrying a body:
--
--   * built from production's text, applying it to staging silently reverts
--     00123;
--   * built from staging's text, applying it to production installs a body that
--     calls a function that is not there — which fails at RUN time, in the
--     middle of a merge, after the DELETE;
--   * two branches, one per database, is not a migration.
--
-- The two databases have also diverged FURTHER since 00138 was written, because
-- 00138 itself patched this function. Anything written from a copy would now
-- have to reproduce that patch too. The substitution reproduces nothing: every
-- guard, every repoint, every GET DIAGNOSTICS, the owner, SECURITY DEFINER, the
-- search_path and the ACL are carried through by construction.
--
-- THE ANCHOR is the repoint section's comment line, which occurs exactly once in
-- both bodies and is the line immediately after the last existing guard:
--
--     -- ---- Repoint NO ACTION columns (DELETE would otherwise throw) ----
--
-- A single-line anchor, deliberately: pg_get_functiondef returns the body as
-- stored, so a multi-line anchor would be hostage to exact leading whitespace on
-- every line of it. The block refuses on any hit count other than 1, returns
-- early if the new text is already present, and re-reads pg_get_functiondef
-- afterwards to prove the change landed in the live body rather than in a local
-- string.
--
-- IDEMPOTENT: a second run finds the ban guard already there and returns.
--
-- ONE TRANSACTION, so the assertion at the foot can undo the patch.
-- ============================================================

BEGIN;

DO $merge_standing$
DECLARE
  v_def    text;
  -- The line the new guards are inserted ABOVE. Reproduced exactly as 00079
  -- wrote it and 00095 carried it.
  v_anchor text := '-- ---- Repoint NO ACTION columns (DELETE would otherwise throw) ----';
  -- Built with explicit || and E'\n' rather than as one multi-line literal:
  -- adjacent string constants are concatenated by the parser, but the E prefix
  -- does NOT carry across them, so a continuation line's \n would land in the
  -- function body as a literal backslash-n. Single quotes are doubled because
  -- this is plpgsql source inside a SQL string literal.
  v_new    text :=
       '-- Guard: a merge is not a moderation control. The loser row is DELETEd'                        || E'\n'
    || '  -- below and the survivor''s own fields always win, so a banned duplicate'                    || E'\n'
    || '  -- merged into a clean row loses its ban with no trace in the audit entry'                    || E'\n'
    || '  -- this function writes. NOT carried forward: a ban is four columns plus'                     || E'\n'
    || '  -- the banned_at episode key that club_fees.ban_started_at is unique'                         || E'\n'
    || '  -- against (00065, 00094), and a merge cannot reconcile two of those. See'                    || E'\n'
    || '  -- 00146.'                                                                                    || E'\n'
    || '  IF v_remove.is_banned THEN'                                                                   || E'\n'
    || '    RAISE EXCEPTION'                                                                            || E'\n'
    || '      ''Refusing to merge: the account being removed is banned. Lift the ban first, or ban the surviving account, so the decision is recorded as one.'';'
                                                                                                        || E'\n'
    || '  END IF;'                                                                                      || E'\n'
    || E'\n'
    || '  -- Same guard, sharper consequence. deletion_requested_at is a promise the'                   || E'\n'
    || '  -- club made to a member, and 00012 keeps it set on anonymised rows as a'                     || E'\n'
    || '  -- tombstone — so deleting this row either cancels a scheduled deletion or'                   || E'\n'
    || '  -- destroys the record that one happened. Carrying it forward is worse'                       || E'\n'
    || '  -- still: it would schedule the SURVIVOR for anonymisation.'                                  || E'\n'
    || '  IF v_remove.deletion_requested_at IS NOT NULL THEN'                                           || E'\n'
    || '    RAISE EXCEPTION'                                                                            || E'\n'
    || '      ''Refusing to merge: the account being removed has a deletion recorded (%). Cancel it from that member''''s page first, or leave the row to the purge job.'','
                                                                                                        || E'\n'
    || '      v_remove.deletion_requested_at;'                                                          || E'\n'
    || '  END IF;'                                                                                      || E'\n'
    || E'\n'
    || '  ' || '-- ---- Repoint NO ACTION columns (DELETE would otherwise throw) ----';
  v_hits   integer;
  v_newdef text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'merge_players'
     AND p.pronargs = 3;

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      '00146: public.merge_players(uuid,uuid,uuid) is not present. 00026/00079/00095 must be applied first.';
  END IF;

  -- Already patched (a re-run, or somebody got there first). Nothing to do.
  IF position('v_remove.is_banned' in v_def) > 0 THEN
    RAISE NOTICE '00146: merge_players already refuses a banned loser; leaving it alone.';
    RETURN;
  END IF;

  -- The body must still be the one this is being fitted to. Checked on the two
  -- guards the new ones sit under, not on the anchor alone: a body missing
  -- either has been rewritten by something this file has not seen, and the new
  -- guards would land in an unknown place.
  IF position('Both accounts have a login' in v_def) = 0
     OR position('the account being removed has history' in v_def) = 0 THEN
    RAISE EXCEPTION
      '00146: the live merge_players body is missing one of the existing guards. Dump pg_get_functiondef and fit the standing guards by hand.';
  END IF;

  -- Count before replacing. A body carrying the repoint comment twice must be
  -- looked at by a person, not patched blind.
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '00146: expected exactly 1 occurrence of "%" in the live merge_players body, found %. Refusing to patch — dump pg_get_functiondef and do it by hand.',
      v_anchor, v_hits;
  END IF;

  v_newdef := replace(v_def, v_anchor, v_new);
  EXECUTE v_newdef;

  -- Prove the replacement landed in the LIVE body, not just in the local string.
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'merge_players'
     AND p.pronargs = 3;

  IF position('v_remove.is_banned' in v_def) = 0
     OR position('v_remove.deletion_requested_at IS NOT NULL' in v_def) = 0 THEN
    RAISE EXCEPTION '00146: the standing guards did not land in the live merge_players body.';
  END IF;

  -- And that nothing else was lost on the way through. These are the two things
  -- 00138 §0 and 00123 put in the body; a substitution that dropped either would
  -- otherwise be invisible until somebody merged.
  IF position('COALESCE(v_remove.onboarding_completed' in v_def) = 0 THEN
    RAISE WARNING
      '00146: the live merge_players body does not carry 00138 §0''s onboarding_completed OR form. Apply 00138 before relying on it — this file did not remove it.';
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION '00146: the repoint section comment is gone from the patched body.';
  END IF;
END
$merge_standing$;

COMMENT ON FUNCTION public.merge_players(uuid, uuid, uuid) IS
  'Merges a duplicate player into a survivor. Refuses if the loser has matches, money or tournament history, if the schema has a CASCADE reference to players that this function does not classify, if both rows have a login, or (00146) if the loser is banned or has a deletion recorded — moderation and account-lifecycle decisions are made through their own audited actions, never as a side effect of a merge. Waivers, event waivers, passkeys and announcement reads are repointed rather than deleted; reliability metrics are merged (counters sum, confirmation time weighted, walkover flag OR-ed).';

-- ---- Prove the file did what it says ----
DO $assert$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_players' AND p.pronargs = 3;

  IF position('v_remove.is_banned' in v_def) = 0 THEN
    RAISE EXCEPTION '00146: merge_players still accepts a banned loser.';
  END IF;
  IF position('v_remove.deletion_requested_at' in v_def) = 0 THEN
    RAISE EXCEPTION '00146: merge_players still accepts a loser with a deletion recorded.';
  END IF;
  -- The guards must sit ABOVE the first write, or they guard nothing. Measured
  -- against the repoint section's comment rather than against a repoint
  -- statement: both strings above are known to be present (the patch block
  -- asserted the anchor is still there), so a 0 from position() cannot turn this
  -- comparison into a spurious failure.
  IF position('v_remove.is_banned' in v_def)
     > position('-- ---- Repoint NO ACTION columns' in v_def) THEN
    RAISE EXCEPTION '00146: the standing guards landed after the repoint section. Refusing to leave that in place.';
  END IF;

  RAISE NOTICE '00146: merge_players refuses a banned or deletion-pending loser.';
END
$assert$;

COMMIT;
