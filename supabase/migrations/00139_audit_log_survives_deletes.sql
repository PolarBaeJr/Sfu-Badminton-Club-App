-- ============================================================
-- 00139 — tournament_audit_log: three FKs become ON DELETE SET NULL,
--         the fourth deliberately does not
-- ============================================================
-- WHAT IS BROKEN. All four foreign keys on tournament_audit_log are
-- ON DELETE NO ACTION (confdeltype = 'a' on BOTH databases, read 2026-08-17),
-- and every audit row carries a tournament_id AND an event_id — 595/595 on
-- staging, 26/26 on production, zero nulls in either column on either database.
-- That is not an accident of usage: `event_created` is logged at the moment an
-- event is created, so every event has a referencing audit row from birth.
--
-- The consequence is that the audit log has quietly become a delete-blocker for
-- ordinary console operations. Three of them, container-proven against
-- schema-only dumps of both databases (see VERIFICATION at the foot of this
-- file), all failing with SQLSTATE 23503:
--
--   * deleting a tournament event
--   * deleting a tournament
--   * regenerating a draw after any result has been entered
--     (the regenerate path DELETEs tournament_matches rows that
--      `result_entered` / `match_voided` audit rows point at)
--
-- Open on production and on staging, identically.
--
-- ============================================================
-- WHY SET NULL AND NOT CASCADE
-- ============================================================
-- CASCADE is the tidier answer and it is the WRONG one here, because this table
-- is not only an audit log. It is also the IDEMPOTENCY LEDGER FOR PLACEMENT
-- BONUSES.
--
-- apps/admin/src/lib/tournament-actions/finalize.ts:63 (`readBonusLedger`)
-- reads rows with action = 'placement_bonuses_applied' and reconstructs, from
-- their `details` jsonb, which players' ratings and which participant rows a
-- previous run already credited. applyPlacementBonuses writes
-- `current_rating + bonus`, which is not idempotent: lose the ledger row and
-- the next run silently adds every bonus a second time, to live ratings, with
-- nothing anywhere to say it happened.
--
-- Under CASCADE, deleting an event would delete its ledger rows. Under SET
-- NULL the row survives with its `details` payload intact. The owner chose
-- SET NULL for exactly this reason: preserving the row beats preserving
-- referential tidiness.
--
-- ============================================================
-- THE CONSEQUENCE SET NULL CREATES, AND WHY NO EXTRA MACHINERY IS ADDED
-- ============================================================
-- SET NULL means a ledger row whose only key is `event_id` becomes
-- unattributable the moment that event is deleted. If the ledger lookup could
-- ever run against a nulled row it would MISS a prior application and double
-- the bonus — the precise failure this table is supposed to prevent. That
-- possibility was checked before this file was written rather than assumed
-- away, and here is the check in full.
--
-- The ledger keys itself on `event_id` and nothing else:
--
--     .from('tournament_audit_log')
--     .select('details')
--     .eq('event_id', eventId)
--     .eq('action', BONUS_APPLIED_ACTION)          -- finalize.ts:68-71
--
-- So the question is whether `readBonusLedger` can ever be reached for an
-- eventId whose tournament_events row is gone. It has exactly three call
-- sites, and every one of them fetches the event and throws BEFORE the ledger
-- is read:
--
--   finalize.ts:97-98    applyPlacementBonuses  — select event; 'Event not found'
--   finalize.ts:123        -> readBonusLedger
--   finalize.ts:590-591  recomputeEventStandings — select event; 'Event not found'
--   finalize.ts:614        -> readBonusLedger
--   finalize.ts:635-636  finalizeEvent          — select event; 'Event not found'
--   finalize.ts:709        -> applyPlacementBonuses (which re-checks at :97)
--
-- A nulled ledger row is therefore UNREACHABLE: the only key that could select
-- it names an event that no longer exists, and every path refuses before it
-- looks. No bonus can be doubled by this change.
--
-- NOTHING EXTRA IS ADDED — no denormalised copy of event_id, no partial unique
-- index, no guard in finalize — because the hazard the task asked about is not
-- present, and a second copy of the key would create a second source of truth
-- for the one value whose single-source-ness is the entire point of the ledger.
--
-- WHAT IS ADDED is a COMMENT ON COLUMN recording the coupling, because the
-- safety above rests on CALLER ORDER, not on the schema. A future refactor that
-- hoists the ledger read above the existence check — or adds a fourth caller
-- that does not check — reintroduces the double-bonus, and the schema will not
-- stop it. The comment is where that reader is told.
--
-- ============================================================
-- THE FOUR CONSTRAINTS, ONE DECISION EACH
-- ============================================================
--   event_id      -> tournament_events(id)   NO ACTION -> SET NULL.  Proven
--                    broken (deleting an event). The row keeps tournament_id,
--                    action, performed_by, details and created_at — still a
--                    legible trail entry, and still a usable ledger row for the
--                    reason set out above.
--
--   tournament_id -> tournaments(id)         NO ACTION -> SET NULL.  Proven
--                    broken (deleting a tournament). Same argument.
--
--   match_id      -> tournament_matches(id)  NO ACTION -> SET NULL.  Proven
--                    broken (regenerating a draw after a result). This is the
--                    one people hit most: 22/26 prod rows and 541/595 staging
--                    rows have a NULL match_id already, so the column is
--                    routinely absent and the surviving row loses least of all
--                    by having it nulled. It still names the tournament, the
--                    event, the action and the actor.
--
--   performed_by  -> players(id)             NO ACTION, DELIBERATELY UNCHANGED.
--                    Three reasons, in order of weight:
--                      1. NO OPERATION IS BROKEN BY IT. The three failures this
--                         file exists to fix are event, tournament and match
--                         deletes. A player delete is not among them.
--                      2. THE ONE PATH THAT REMOVES A PLAYER ALREADY HANDLES
--                         IT. merge_players() repoints rather than deletes —
--                         `UPDATE tournament_audit_log SET performed_by = p_keep
--                         WHERE performed_by = p_remove` (00079:155), filed
--                         there under "repoint NO ACTION columns (preserve
--                         attribution)". Changing this constraint would not
--                         change what merge_players does; it would only remove
--                         the safety net if merge_players ever stopped doing
--                         it. Nothing else in either app hard-deletes a player.
--                      3. IT IS THE FIELD WITH THE MOST TO LOSE. "Who did this"
--                         is the load-bearing column of an audit row, and
--                         unlike a tournament or a match it cannot be inferred
--                         from anything else on the row. SET NULL here would
--                         destroy attribution to buy nothing measured.
--                    NO ACTION also means a hard `DELETE FROM players` for
--                    someone who has performed an audited tournament action
--                    will be refused. That is a feature, not the bug this file
--                    is fixing: it forces the merge path, which preserves
--                    history, instead of the delete path, which does not.
--
-- ============================================================
-- NULLABILITY
-- ============================================================
-- SET NULL requires the referencing columns to be nullable. ALL THREE ALREADY
-- ARE — attnotnull = false for tournament_id, event_id and match_id on both
-- databases (read 2026-08-17, and 00001_schema.sql:816-825 never declared them
-- NOT NULL). So there is no ALTER COLUMN ... DROP NOT NULL in this file, and
-- its absence is intentional rather than an omission. The DO block below
-- asserts it rather than trusting this paragraph.
--
-- ============================================================
-- APPLY ORDER / IDEMPOTENCE
-- ============================================================
-- Independent of 00140. Safe to apply in either order, and safe to re-apply:
-- every statement drops the constraint IF EXISTS before adding it, and the
-- final assertions check the resulting confdeltype rather than assuming.
-- One transaction: a half-applied set of delete rules is worse than none.

BEGIN;

-- ---- 0. assert the pre-state ---------------------------------
-- Written as an assertion and not a comment because the whole file is
-- predicated on it. If a database ever arrives here with a NOT NULL on one of
-- these columns, the ALTERs below would succeed and then every cascading delete
-- would fail at runtime with 23502 instead of 23503 — a worse failure, later.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(a.attname, ', ')
    INTO v_bad
    FROM pg_attribute a
   WHERE a.attrelid = 'public.tournament_audit_log'::regclass
     AND a.attname IN ('tournament_id', 'event_id', 'match_id')
     AND a.attnotnull;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      '00139: tournament_audit_log.% is NOT NULL — ON DELETE SET NULL cannot be used on it', v_bad;
  END IF;
END $$;

-- ---- 1. event_id ---------------------------------------------
ALTER TABLE public.tournament_audit_log
  DROP CONSTRAINT IF EXISTS tournament_audit_log_event_id_fkey;
ALTER TABLE public.tournament_audit_log
  ADD CONSTRAINT tournament_audit_log_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES public.tournament_events(id) ON DELETE SET NULL;

-- ---- 2. tournament_id ----------------------------------------
ALTER TABLE public.tournament_audit_log
  DROP CONSTRAINT IF EXISTS tournament_audit_log_tournament_id_fkey;
ALTER TABLE public.tournament_audit_log
  ADD CONSTRAINT tournament_audit_log_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE SET NULL;

-- ---- 3. match_id ---------------------------------------------
ALTER TABLE public.tournament_audit_log
  DROP CONSTRAINT IF EXISTS tournament_audit_log_match_id_fkey;
ALTER TABLE public.tournament_audit_log
  ADD CONSTRAINT tournament_audit_log_match_id_fkey
  FOREIGN KEY (match_id) REFERENCES public.tournament_matches(id) ON DELETE SET NULL;

-- ---- 4. performed_by: NOT TOUCHED -----------------------------
-- See "THE FOUR CONSTRAINTS" above. The assertion in §6 checks it is still
-- NO ACTION, so a later edit that changes it has to change this file too.

-- ---- 5. write the coupling into the database -----------------
-- The comment a future reader gets from \d+ and from information_schema. It
-- states the one invariant that the schema itself cannot enforce.
COMMENT ON COLUMN public.tournament_audit_log.event_id IS
  'Nullable, ON DELETE SET NULL (00139). Rows with action = '
  '''placement_bonuses_applied'' are the IDEMPOTENCY LEDGER for placement '
  'bonuses: readBonusLedger (finalize.ts) selects them by event_id alone and '
  'applyPlacementBonuses writes current_rating + bonus, so a ledger row that '
  'cannot be found means every bonus on the event is awarded twice. That is '
  'safe today ONLY because all three callers fetch the tournament_events row '
  'and throw ''Event not found'' before reading the ledger, so a nulled row is '
  'unreachable. IF YOU ADD A CALLER, OR HOIST THE LEDGER READ ABOVE THE '
  'EXISTENCE CHECK, YOU BREAK THAT and the database will not stop you.';

COMMENT ON COLUMN public.tournament_audit_log.performed_by IS
  'Deliberately still ON DELETE NO ACTION (00139) while the other three FKs are '
  'SET NULL. Attribution is the column with the most to lose and the least to '
  'recover from elsewhere, no console operation is blocked by it, and the only '
  'path that removes a player — merge_players() (00079) — repoints this column '
  'rather than relying on the delete rule. NO ACTION additionally refuses a '
  'hard DELETE of a player who has performed audited tournament actions, which '
  'forces the merge path that preserves history.';

-- ---- 6. assert the post-state --------------------------------
-- confdeltype: 'n' = SET NULL, 'a' = NO ACTION, 'c' = CASCADE.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('%s=%s', c.name, c.got), ', ')
    INTO v_bad
    FROM (
      SELECT x.name, x.want, pg_constraint.confdeltype::text AS got
        FROM (VALUES
                ('tournament_audit_log_event_id_fkey',      'n'),
                ('tournament_audit_log_tournament_id_fkey', 'n'),
                ('tournament_audit_log_match_id_fkey',      'n'),
                ('tournament_audit_log_performed_by_fkey',  'a')
             ) AS x(name, want)
        JOIN pg_constraint
          ON pg_constraint.conrelid = 'public.tournament_audit_log'::regclass
         AND pg_constraint.conname  = x.name
    ) c
   WHERE c.got IS DISTINCT FROM c.want;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00139: wrong ON DELETE rule after apply: %', v_bad;
  END IF;

  -- All four must still exist. A typo'd name above would make the join find
  -- nothing and the check pass vacuously.
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.tournament_audit_log'::regclass
         AND contype = 'f') <> 4 THEN
    RAISE EXCEPTION '00139: expected exactly 4 foreign keys on tournament_audit_log, found %',
      (SELECT count(*) FROM pg_constraint
        WHERE conrelid = 'public.tournament_audit_log'::regclass AND contype = 'f');
  END IF;
END $$;

COMMIT;

-- ============================================================
-- VERIFICATION (2026-08-17)
-- ============================================================
-- Run in a disposable supabase/postgres:17.6.1.136 container, loaded from
-- read-only `pg_dump --schema-only` of BOTH production and staging, separately.
-- Nothing was written to either live database.
--
--   pre-state   all four FKs confdeltype 'a'; the three columns already nullable
--   FAILURE     with the pre-state loaded and a tournament -> event -> match ->
--               audit-row fixture seeded:
--                 DELETE FROM tournament_events ...  -> 23503
--                 DELETE FROM tournaments ...        -> 23503
--                 DELETE FROM tournament_matches ... -> 23503
--   after       the same three deletes succeed; the audit row SURVIVES with the
--               nulled column and its `details` jsonb byte-identical
--   ledger      a 'placement_bonuses_applied' row seeded before the delete is
--               still present afterwards, with details intact
--   player      DELETE FROM players (the actor) still raises 23503 — the
--               deliberate non-change, asserted rather than described
--   re-apply    running the file a second time is a no-op and both DO blocks
--               still pass
--
-- The harness disables USER triggers on the fixture tables (NOT
-- session_replication_role, which would also switch off the FK system triggers
-- and make the whole proof vacuous). So the post-fix result is strictly "the
-- foreign key no longer blocks the delete". That it is also the whole console
-- operation was checked separately, against both live databases: the only
-- non-internal trigger on tournaments / tournament_events / tournament_matches
-- is `set_updated_at` on tournaments, tgtype 19 = ROW | BEFORE | INSERT |
-- UPDATE. NOTHING FIRES ON DELETE. There is no second guard behind the FK.
--
-- ============================================================
-- FOUND AND DELIBERATELY LEFT: two more NO ACTION FKs
-- ============================================================
-- Enumerating everything that still refuses these deletes turned up a pair
-- outside this table, present on both databases:
--
--   tournament_matches.winner_to_match_id -> tournament_matches(id)   NO ACTION
--   tournament_matches.loser_to_match_id  -> tournament_matches(id)   NO ACTION
--
-- Self-references inside the bracket. They are NOT changed here, for two
-- reasons. They are not this table's problem — the file is about the audit log,
-- and widening it to the bracket graph is a different change with a different
-- blast radius. And THEY DO NOT BLOCK THE OPERATIONS THIS FILE FIXES: NO ACTION
-- is checked at end of statement, and every path that removes these rows
-- removes the whole interlinked set in ONE statement —
-- `adminClient.from('tournament_matches').delete().eq('event_id', eventId)`
-- (brackets.ts:195) for a regenerate, and a single cascade for an event or
-- tournament delete. What WOULD fail is deleting bracket matches one at a time,
-- which nothing does today. Recorded here so the next person to look does not
-- have to re-derive it.
