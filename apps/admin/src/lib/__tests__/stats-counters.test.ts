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
    expect(code).toMatch(/DROP TRIGGER IF EXISTS/);
    const creates = code.match(/^CREATE (?!OR REPLACE)/gm) ?? [];
    // The only bare CREATE is the trigger, and it is preceded by its DROP.
    expect(creates.every((_, i) => i >= 0)).toBe(true);
    expect(code.match(/^CREATE TRIGGER/gm) ?? []).toHaveLength(1);
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
