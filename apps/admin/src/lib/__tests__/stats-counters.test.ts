import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// THE PROPERTIES 00119 CLAIMS, ASSERTED AGAINST THE FILE THAT CLAIMS THEM.
//
// head_to_head_stats and partnership_stats used to be running totals, and every
// bug they had came from the same place: an increment that fired, or failed to
// fire, at a moment that did not correspond to the fact being counted. An
// unrated admin match was never counted (the writer is an AFTER UPDATE trigger
// and the row was born confirmed); a void never gave the count back; a resolved
// dispute on a confirmed match counted it twice. 00119 replaces the arithmetic
// with a recompute from `matches` and `match_participants`, which is what makes
// idempotence, no-underflow and reversal structural rather than guarded.
//
// WHAT THIS FILE CAN AND CANNOT DO. It cannot run SQL — nothing in this
// repository can, migrations are piped into psql by hand, and the same
// limitation is written down in realtime-publication.test.ts. So it does not
// test behaviour. It reads the migration and asserts the STRUCTURAL properties
// the file's guarantees rest on, each of which is a single grep and each of
// which would be silently destroyed by a well-meaning "optimisation" back to
// `total_matches + 1`:
//
//   * no decrement exists anywhere, which is why a reversal cannot underflow;
//   * the predicate has exactly one definition, which is why the confirm path,
//     the reversal path and the backfill cannot disagree about what counts;
//   * win_rate is still stored 0-100.
//
// The behavioural half of 00119 — that adminCreateMatch no longer inserts a
// confirmed match — is in admin-match-create.test.ts, where it can actually be
// executed.

const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`No migration starting ${prefix} in ${MIGRATIONS}`);
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

/** The file with the comments stripped — every assertion below is about the
 *  STATEMENTS, and 00119 is a file whose prose discusses the very things the
 *  statements must not contain. */
function statements(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

describe('00119 — the counters are derived, not accumulated', () => {
  const sql = migration('00119_');
  const code = statements(sql);

  // THE NO-UNDERFLOW GUARANTEE, AND IT IS THE ABSENCE OF CODE RATHER THAN THE
  // PRESENCE OF A GUARD. Voiding a match that was never counted — every unrated
  // admin match created before this migration ran — must not take a counter
  // negative. It cannot, because nothing subtracts: the reversal path recounts
  // from zero. A COUNT(*) has no negative range. If somebody ever reintroduces
  // a `- 1` here, that reasoning silently stops holding, so the assertion is on
  // the arithmetic itself.
  it('never decrements either counter', () => {
    for (const table of ['head_to_head_stats', 'partnership_stats']) {
      expect(code).not.toMatch(new RegExp(`${table}\\.\\w+\\s*-\\s*\\d`));
    }
    expect(code).not.toMatch(/(total_matches|matches_played|wins|losses)\s*=\s*[\w.]+\s*-\s*\d/);
  });

  // The other half of the same guarantee: nothing increments either, so a
  // double confirm cannot double-count and a re-run of the file is a no-op.
  it('never increments either counter', () => {
    expect(code).not.toMatch(/(total_matches|matches_played|player_a_wins|player_b_wins)\s*=\s*[\w.]+\s*\+\s*1/);
  });

  // ONE DEFINITION OF WHAT COUNTS. The confirm trigger, the participants
  // trigger, both recompute functions and the backfill all ask the same
  // function, so they cannot come to disagree — which is exactly how gap 2
  // existed in the first place, with the trigger holding one rule and
  // reverse_match_result holding none.
  it('defines the predicate once and routes everything through it', () => {
    const defs = code.match(/CREATE OR REPLACE FUNCTION public\.match_counts_toward_stats/g) ?? [];
    expect(defs).toHaveLength(1);
    // The literal comparison must appear inside that function and nowhere else.
    const literals = code.match(/=\s*'confirmed'::result_status/g) ?? [];
    expect(literals).toHaveLength(1);
    // Every consumer.
    const uses = code.match(/match_counts_toward_stats\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(7);
  });

  // The predicate is deliberately about result_status alone. An unrated match
  // counts — apply_match_result's casual branch has always counted one — and
  // wiring rated_flag in here would quietly change what every member's
  // head-to-head card means.
  //
  // The COMMENT ON statement names the column deliberately — saying "not
  // rated_flag" on the function itself is half the point of it — so the
  // assertion is about the predicate positions, not about the string appearing.
  it('does not filter on rated_flag', () => {
    expect(code).not.toMatch(/^\s*(WHERE|AND|IF)\b[^\n]*rated_flag/m);
    expect(code).not.toMatch(/rated_flag\s*(=|<>|IS)/);
  });

  // BOTH GAPS SHIP TOGETHER. Fixing the born-confirmed insert without fixing
  // the reversal means newly-counted matches can be voided and leave inflation
  // behind; fixing the reversal without the insert means reversals for matches
  // that were never counted.
  it('installs the participants trigger that closes the born-confirmed gap', () => {
    expect(code).toMatch(/DROP TRIGGER IF EXISTS on_match_participants_inserted ON public\.match_participants;/);
    expect(code).toMatch(/AFTER INSERT ON public\.match_participants/);
    // Statement-level with a transition table: a doubles match sends four
    // participant rows in one statement, and a row trigger would recompute four
    // times against a half-built team.
    expect(code).toMatch(/REFERENCING NEW TABLE AS new_participants/);
    expect(code).toMatch(/FOR EACH STATEMENT/);
  });

  it('makes the confirm trigger symmetric so leaving `confirmed` also recounts', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.trigger_match_confirmed'));
    // NEW and OLD are both tested through the predicate, which is what makes
    // confirmed -> voided and confirmed -> disputed fire it.
    expect(fn).toMatch(/match_counts_toward_stats\(NEW\.result_status\)/);
    expect(fn).toMatch(/match_counts_toward_stats\(OLD\.result_status\)/);
    expect(fn).toMatch(/IS DISTINCT FROM/);
  });

  // 0-100, NOT 0-1. The renderer was fixed on 2026-08-14 to stop multiplying by
  // a hundred a second time (apps/player/src/app/my-stats/page.tsx). Storing
  // this as a fraction would divide every partnership win rate by a hundred on
  // a screen that has already been burned by this once.
  it('stores win_rate on the 0-100 scale', () => {
    expect(code).toMatch(/ROUND\(v_wins::NUMERIC \/ v_total \* 100, 2\)/);
  });

  // The recompute is the repair. If the backfill had its own logic it could be
  // subtly different from the live path, which is the whole reason to derive.
  it('backfills by calling the same functions the triggers call', () => {
    const backfill = code.slice(code.lastIndexOf('DO $$'));
    expect(backfill).toMatch(/recompute_head_to_head_pair\(/);
    expect(backfill).toMatch(/recompute_partnership_pair\(/);
    // And it reports its blast radius rather than rewriting rows silently.
    expect(backfill).toMatch(/RAISE NOTICE/);
    expect(backfill).toMatch(/rows changed/);
  });

  // Idempotent, because the owner applies these by hand and a migration nobody
  // dares re-run is a migration nobody trusts.
  it('is re-runnable', () => {
    // Every function is CREATE OR REPLACE, and the one bare CREATE — the
    // trigger, which has no REPLACE form worth relying on across versions — is
    // preceded by its DROP IF EXISTS.
    const bare = code.match(/^CREATE (?!OR REPLACE)\w+/gm) ?? [];
    expect(bare).toEqual(['CREATE TRIGGER']);
    expect(code.indexOf('DROP TRIGGER IF EXISTS')).toBeLessThan(code.indexOf('CREATE TRIGGER'));
  });

  // The claim in 00114:319-329, now answered. Left as an assertion so that if
  // 00119 is ever reverted, the file that documented the gap and the file that
  // closed it cannot silently part company.
  it('answers the gaps 00114 wrote down', () => {
    const realtime = migration('00114_');
    expect(realtime).toMatch(/head_to_head_stats and\n-- partnership_stats are never written/);
    expect(sql).toMatch(/00114:319-329/);
  });
});

// ---------------------------------------------------------------------------

// 00123 CLOSES THE THREE THINGS 00119 LISTED UNDER "FOUND AND NOT FIXED", and
// each of them has a failure mode that is invisible at apply time:
//
//   * THE PREDICATE GREW AN ARGUMENT. Postgres keys functions on the argument
//     list, so a CREATE OR REPLACE with a second parameter would mint a SECOND
//     OVERLOAD and leave the one-argument body live for every existing caller.
//     Nothing errors; the walkover ruling just applies to nothing. The one-arg
//     form must be DROPped and every one of its five consumers re-created — and
//     a consumer left behind raises "function does not exist" on the next
//     confirmation, in production, not here.
//
//   * THE POINTS COLUMNS ARE GUARDED BY AN `IS DISTINCT FROM` TUPLE. Adding
//     them to the SET list without adding them to BOTH SIDES of that tuple
//     means every already-correct pair evaluates the guard false, writes
//     nothing, and keeps 0 forever — while the backfill honestly reports "0
//     rows changed". The migration would claim to fix the column and not.
//
//   * merge_players IS 200 LINES REPRODUCED VERBATIM from 00095 with one
//     statement added, because plpgsql cannot redefine part of a body. The
//     added statement has to run AFTER the loser is deleted; before it, the
//     loser's rows are still present and the pair-key collision the recompute
//     exists to avoid comes back.
//
// Same limitation as the 00119 block above: no SQL runs here. These are greps
// for the structural properties the file's guarantees rest on.
describe('00123 — walkovers, the points columns, and the merge guard', () => {
  const sql = migration('00123_');
  const code = statements(sql);

  // THE RULING, AND IT IS ONE LINE BECAUSE THE PREDICATE HAS ONE DEFINITION.
  // A walkover is a real result with real Elo and reliability consequences, but
  // it is not a match anybody played, and these two tables describe play. The
  // exclusion has to be walkover_type rather than result_status because the
  // RATED walkovers reach 'confirmed' through apply_match_result and are
  // indistinguishable from any other confirmed match by status alone.
  it('excludes every walkover, not just the ones that never reached confirmed', () => {
    expect(code).toMatch(/p_result_status = 'confirmed'::result_status\s*\n\s*AND p_walkover_type IS NULL/);
  });

  // THE OVERLOAD TRAP. Without the DROP, the two-argument body is a second
  // function and the one-argument body keeps serving every existing caller.
  it('drops the one-argument predicate before defining the two-argument one', () => {
    const drop = code.indexOf('DROP FUNCTION IF EXISTS public.match_counts_toward_stats(result_status);');
    const create = code.indexOf('CREATE OR REPLACE FUNCTION public.match_counts_toward_stats');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
    // Still exactly one definition, exactly as 00119 required of itself.
    const defs = code.match(/CREATE OR REPLACE FUNCTION public\.match_counts_toward_stats/g) ?? [];
    expect(defs).toHaveLength(1);
  });

  // EVERY CONSUMER RE-CREATED. Miss one and it calls a function that no longer
  // exists. This is the assertion that would have caught the mistake.
  it('re-creates all five consumers of the predicate', () => {
    for (const fn of [
      'recompute_head_to_head_pair',
      'recompute_partnership_pair',
      'trigger_match_confirmed',
      'trigger_match_participants_inserted',
    ]) {
      expect(code).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`));
    }
    // The fifth is the backfill, which is a DO block rather than a function.
    expect(code.slice(code.lastIndexOf('DO $$'))).toMatch(/match_counts_toward_stats\(/);
  });

  // AND EVERY CALL PASSES TWO ARGUMENTS. A one-argument call left anywhere is a
  // runtime error after the DROP above, not a compile error now.
  it('passes walkover_type at every call site', () => {
    // The DROP is the ONLY place the one-argument form may still be named, and
    // it is removed first precisely so that "has one argument" becomes an
    // unambiguous bug signal. Filtering more cleverly than this is how the
    // first version of this assertion let a one-argument call through.
    const drop = 'DROP FUNCTION IF EXISTS public.match_counts_toward_stats(result_status);';
    expect(code).toContain(drop);
    const rest = code.replace(drop, '');
    const uses = rest.match(/match_counts_toward_stats\([^)]*\)/g) ?? [];
    // Definition, COMMENT ON, both recompute functions, two in
    // trigger_match_confirmed, one in the participants trigger, three in the
    // backfill. Fewer means a consumer was missed.
    expect(uses.length).toBeGreaterThanOrEqual(10);
    for (const u of uses) {
      expect(u).toMatch(/,/);
    }
  });

  // THE INERT-MIGRATION TRAP. All six places, or the columns stay 0 while the
  // backfill reports success: the SELECT, the INSERT list, the VALUES, the SET
  // list, the ON CONFLICT write guard, and the zero branch.
  it('derives the points columns in the SET list AND in the write guard', () => {
    const fn = code.slice(
      code.indexOf('FUNCTION public.recompute_head_to_head_pair'),
      code.indexOf('FUNCTION public.recompute_partnership_pair'),
    );
    // Written from source, one row per side — NOT the partnership function's
    // deliberately double-counting SUM(pa + pb) port.
    expect(fn).toMatch(/SUM\(pa\.points_scored\),\s*\n\s*SUM\(pb\.points_scored\)/);
    expect(fn).toMatch(/player_a_points = EXCLUDED\.player_a_points/);
    expect(fn).toMatch(/player_b_points = EXCLUDED\.player_b_points/);
    // Both sides of the IS DISTINCT FROM tuple, which is what makes the write
    // actually happen for a pair whose counts are already right.
    expect(fn).toMatch(/head_to_head_stats\.player_a_points/);
    expect(fn).toMatch(/head_to_head_stats\.player_b_points/);
    expect(fn).toMatch(/EXCLUDED\.player_a_points,\s*\n\s*EXCLUDED\.player_b_points/);
    // The zero branch clears them too: "0 matches, 231 points" is the kind of
    // half-truth 00119 exists to remove.
    expect(fn).toMatch(/player_a_points = 0/);
    expect(fn).toMatch(/IS DISTINCT FROM \(0, 0, 0, 0, 0, NULL::timestamptz\)/);
  });

  // 00119's guarantees are inherited, not re-argued: the recompute functions are
  // re-created here, so a "+ 1" reintroduced in this file would undo them just
  // as effectively as one reintroduced in that one.
  it('still never increments or decrements a counter', () => {
    for (const table of ['head_to_head_stats', 'partnership_stats']) {
      expect(code).not.toMatch(new RegExp(`${table}\\.\\w+\\s*-\\s*\\d`));
    }
    expect(code).not.toMatch(/(total_matches|matches_played|player_a_wins|player_b_wins)\s*=\s*[\w.]+\s*\+\s*1/);
  });

  // 0-100, NOT 0-1. recompute_partnership_pair is reproduced in full here to
  // change its predicate call, which means this convention is reproduced with
  // it and could be lost in the copy.
  it('keeps win_rate on the 0-100 scale through the rewrite', () => {
    expect(code).toMatch(/ROUND\(v_wins::NUMERIC \/ v_total \* 100, 2\)/);
  });

  // THE MERGE GUARD COUNTS HISTORY, NOT TOMBSTONES. 00119 zeroes rows instead
  // of deleting them and adds no DELETE trigger, so a member whose matches were
  // deleted keeps an empty stats row — which merge_players_preview counted as
  // history, refusing the merge permanently with no way to clear it.
  it('stops zeroed stats rows blocking a merge, without widening the guard', () => {
    expect(code).toMatch(/head_to_head_stats WHERE \(player_a_id = p_remove OR player_b_id = p_remove\) AND total_matches > 0/);
    expect(code).toMatch(/partnership_stats WHERE \(player_a_id = p_remove OR player_b_id = p_remove\) AND matches_played > 0/);
    // match_participants is the guard that actually refuses a loser with real
    // history, and it is untouched.
    expect(code).toMatch(/FROM match_participants WHERE player_id = p_remove/);
  });

  // AFTER THE DELETE, NOT BEFORE. That ordering is the whole of the pair-key
  // collision answer: the loser's rows are gone by CASCADE, so nothing is
  // repointed onto an occupied UNIQUE key and no (survivor, loser) row survives
  // to become a self-pair.
  it('re-derives the survivor pairs after the loser is deleted', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.merge_players(p_keep'));
    const del = fn.indexOf('DELETE FROM players WHERE id = p_remove;');
    const recompute = fn.indexOf('recompute_player_stats(p_keep)');
    expect(del).toBeGreaterThanOrEqual(0);
    expect(recompute).toBeGreaterThan(del);
  });

  // The sweep is the same two functions the triggers call, so there is no
  // separate repair path that could drift from the live one.
  it('sweeps a player with the same functions the triggers use', () => {
    const fn = code.slice(
      code.indexOf('FUNCTION public.recompute_player_stats'),
      code.indexOf('FUNCTION merge_players_preview'),
    );
    expect(fn).toMatch(/recompute_head_to_head_pair\(/);
    expect(fn).toMatch(/recompute_partnership_pair\(/);
  });

  // Idempotent, because the owner applies these by hand. Every statement is
  // CREATE OR REPLACE or DROP ... IF EXISTS; 00119's two trigger OBJECTS are
  // deliberately left alone, so this file creates no trigger at all.
  it('is re-runnable and creates no trigger', () => {
    const bare = code.match(/^CREATE (?!OR REPLACE)\w+/gm) ?? [];
    expect(bare).toEqual([]);
    expect(code).not.toMatch(/CREATE TRIGGER/);
  });
});
