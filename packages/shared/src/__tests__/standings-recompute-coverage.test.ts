// A CORRECTIVE ACTION ON A COMPLETED EVENT REDOES THE PLACINGS, OR IT LEAVES
// THEM DESCRIBING A BRACKET THAT NO LONGER EXISTS.
//
// assertEventResultsMutable in results.ts deliberately admits `completed`, so a
// finished event can still be fixed on the day. But a completed event HAS
// standings — final_position and points, written at finalisation and read by
// the leaderboard, the trophy and the ratings. Every corrective action that
// admits `completed` can therefore invalidate them.
//
// Only one of the five did anything about it. editMatchResultImpl called
// recomputeEventStandings; void, restore, undo and slot editing did not, and
// recomputeEventStandings had exactly ONE caller in the whole repo. So:
//
//   complete an event -> void the final -> the voided winner keeps first place,
//   the points and the trophy, because nothing recomputed.
//
// No concurrency required, no race, two clicks by one admin. That is why this
// is a census and not a comment: the hole was not that somebody wrote the wrong
// code, it was that a fix applied to one path was never applied to its four
// siblings, and nothing said so.
//
// THE RULE
//   Every function in results.ts that calls assertEventResultsMutable, plus the
//   undo path (gated on match status rather than event status but reaching a
//   decided match on a completed event exactly the same way), must also call
//   recomputeStandingsAfterCorrection.
//
// A NEW corrective action fails this test until it either recomputes or is
// classified below. That classification is the review.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const RESULTS = 'apps/admin/src/lib/tournament-actions/results.ts';

/**
 * Corrective actions that reach a decided match but provably cannot move a
 * placing, with the reason. Empty today, and adding to it is a review decision:
 * the bar is that the action cannot change which entries appear in
 * assignPositionsAndPoints' bracket read, nor who won them.
 */
const EXEMPT: Record<string, string> = {
  // Cannot move a placing, on three independent grounds — checked against
  // finalize.ts's assignPositionsAndPoints, which is the only thing that
  // computes a placing:
  //
  //  1. It refuses outright when the match is already 'completed' or
  //     'walkover', so the match it acts on is undecided — and the bracket read
  //     selects `status in ('completed','walkover')`. The match was outside
  //     that read before and is outside it after.
  //  2. Its match write nulls winner_*/loser_* and sets 'voided'. Every
  //     position is read off winner_*/loser_*, and there was nothing there.
  //  3. It marks both entries 'no_show', and the ONLY entry-status the placings
  //     computation reads is isOutOfEvent — {'withdrawn','disqualified'}.
  //     'no_show' is deliberately not in that set (tournament-withdrawal.ts:29).
  //
  // If any of those three stops being true, delete this entry rather than
  // patching the comment.
  recordDoubleNoShowImpl: 'undecided match, nulled winner_*, and no_show is not an out-of-event status',
};

/** The gate that admits `completed`, and the helper that repairs what follows. */
const GATE = 'assertEventResultsMutable(';
const RECOMPUTE = 'recomputeStandingsAfterCorrection(';

/**
 * Split the file into top-level `function`/`async function` bodies by brace
 * depth. Deliberately not a regex over the whole file: a per-function body is
 * the only unit where "calls the gate" and "calls the recompute" can be checked
 * against EACH OTHER rather than against the file, and a file-level grep would
 * have passed happily while four of five functions were broken.
 */
function topLevelFunctions(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const decl = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    const start = src.indexOf('{', m.index + m[0].length - 1);
    if (start === -1) continue;
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    out.push({ name: m[1]!, body: src.slice(start, end + 1) });
  }
  return out;
}

describe('standings recompute coverage', () => {
  const src = readFileSync(new URL(RESULTS, `file://${repoRoot}`), 'utf-8');
  const fns = topLevelFunctions(src);

  it('parses the corrective actions out of results.ts', () => {
    // Guards the parser itself. If topLevelFunctions ever stops finding bodies
    // the census below passes vacuously, which is the failure mode this whole
    // family of tests exists to prevent.
    expect(fns.length).toBeGreaterThan(5);
    expect(fns.map(f => f.name)).toContain('voidMatchImpl');
    expect(fns.map(f => f.name)).toContain('editMatchResultImpl');
  });

  it('every gated corrective action redoes the standings', () => {
    const gated = fns.filter(f => f.name !== 'assertEventResultsMutable' && f.body.includes(GATE));
    // The gate has callers at all — otherwise this test proves nothing.
    expect(gated.length).toBeGreaterThanOrEqual(3);

    const missing = gated
      .filter(f => !(f.name in EXEMPT))
      .filter(f => !f.body.includes(RECOMPUTE))
      .map(f => f.name);

    expect(missing, `corrective actions on a completed event that never redo the placings: ${missing.join(', ')}`).toEqual([]);
  });

  it('the undo path redoes the standings too', () => {
    // Not gated by assertEventResultsMutable — it checks the MATCH status
    // instead — but it clears a decided result on a completed event just like
    // the others, so the census would miss it without naming it.
    const undo = fns.find(f => f.name === 'undoMatchResultImpl');
    expect(undo).toBeDefined();
    expect(undo!.body).toContain(RECOMPUTE);
  });

  it('the recompute helper is the only caller of recomputeEventStandings IN results.ts', () => {
    // One policy, not five. The bonuses-already-paid warning lives in the
    // helper; a path calling recomputeEventStandings directly would silently
    // skip it, which is how the correction path's own fix failed to generalise.
    //
    // SCOPED TO results.ts ON PURPOSE, and the name says so. finalize.ts calls
    // recomputeEventStandings legitimately (it declares it), so a repo-wide
    // assertion would have to carve that out; a caller appearing somewhere
    // else entirely is not covered here and would need its own census.
    const direct = fns
      .filter(f => f.name !== 'recomputeStandingsAfterCorrection')
      .filter(f => f.body.includes('recomputeEventStandings('))
      .map(f => f.name);
    expect(direct).toEqual([]);
  });
});
