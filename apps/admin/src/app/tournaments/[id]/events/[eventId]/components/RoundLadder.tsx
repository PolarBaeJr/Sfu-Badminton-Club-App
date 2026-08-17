'use client';

import { useState } from 'react';
import {
  describeMatchShape,
  resolveMatchShape,
  hasOwnMatchShape,
  isPlayedMatch,
  eloWeightBreakdown,
  eventEloMultiplier,
} from '@badminton/shared';
import { RoundShapeControl } from './RoundShapeControl';
import type { TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

// ============================================================
// THE LADDER — what every round of this draw is played to (00108)
// ============================================================
//
// WHAT WAS WRONG WITH THE STRIP THIS REPLACES. It was a wrapping flex row of one
// select per round, and on a fresh single-elimination draw every one of them
// read "Same as the event (Best of 3 to 21)" with "Elo 1.25 x 1.15 = 1.44x"
// underneath. Eight rounds, so the same two strings eight times each: the one
// thing a reader wants — WHICH ROUND DIFFERS — was the hardest thing to see,
// because everything on screen was identical and nothing was aligned. Being a
// flex-wrap row it also broke mid-sequence, dropping Final and 3rd Place onto a
// second line in the middle of a ladder whose entire point is being ordered.
//
// THE COMMON CASE IS THAT EVERY ROUND INHERITS, and that is a fact about the
// generator, not a guess: brackets.ts applies knockoutLadder() to the
// pool_to_bracket format ONLY, so a plain knockout's rows carry NULL in both
// shape columns and every round resolves to the event's own shape. That state is
// one sentence, so it is rendered as one line with the per-round table behind a
// disclosure. A draw that has something to say gets the table immediately.
//
// SUMMARISED ONLY WHEN EVERY ROUND INHERITS. Not "when every round resolves the
// same" — a round explicitly pinned to the shape the event happens to use is
// still a decision somebody made, and printing "every round Best of 3 to 21"
// over it would summarise that decision away just because today's arithmetic
// agrees with it. So the one-shape summary is offered on the inherit case only;
// a draw whose rounds differ collapses to a COUNT of the departures instead,
// which is true of every ladder and claims nothing about a shape.
//
// On a pool_to_bracket event every round is stamped by knockoutLadder(), so that
// format always opens on the table — the ladder IS the content there. It can
// still be put away afterwards, because ~430px of table sitting permanently
// above the bracket costs the reader the thing they opened the tab for.
//
// THE TABLE IS A TABLE. Round, what it is played to, what it is worth: three
// aligned columns, in draw order, so the eye runs down one column and the row
// that departs is the one that looks different. The previous layout put the
// round name inline with its own select, which is why nothing lined up.

interface LadderRound {
  roundNumber: number;
  name: string;
  matches: TournamentMatchRow[];
}

interface Props {
  event: TournamentEventRow;
  /** The knockout rounds, in draw order. */
  rounds: LadderRound[];
  /** The third-place playoff, which hangs off the sequence rather than in it. */
  thirdPlace?: TournamentMatchRow | null;
  /** null on a single-phase event, where the matches carry phase NULL. */
  phase: 'pool' | 'bracket' | null;
}

export function RoundLadder({ event, rounds, thirdPlace, phase }: Props) {
  // FIRST, AND ABOVE EVERY EARLY RETURN. null means "no opinion yet", so the
  // default below can depend on the data while the hook itself never does — a
  // useState placed after the `rows.length === 0` guard is a conditional hook,
  // and a draw that gains its first round would change the hook order.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  // THE THIRD-PLACE PLAYOFF IS LAST AND IS NOT A ROUND NUMBER. It shares
  // round_number with the final (00080) and is addressed separately by
  // setRoundMatchShape, so it is appended as its own row rather than folded into
  // the final's — which is right by default and wrong the moment somebody wants
  // them different.
  const rows = [
    ...rounds.map((r) => ({
      key: `r${r.roundNumber}`,
      name: r.name,
      roundNumber: r.roundNumber as number | null,
      thirdPlace: false,
      matches: r.matches,
    })),
    ...(thirdPlace
      ? [{
          key: 'third',
          name: '3rd Place',
          roundNumber: null as number | null,
          thirdPlace: true,
          matches: [thirdPlace],
        }]
      : []),
  ].map((row) => {
    const first = row.matches[0];
    const shape = resolveMatchShape(first ?? null, event);
    return {
      ...row,
      resolved: describeMatchShape(shape),
      elo: eloWeightBreakdown(shape, event.elo_multiplier),
      // The RAW row, not the resolved shape: "does this round override" is a
      // question about the columns, and hasOwnMatchShape is the same predicate
      // the rest of 00108 answers it with.
      overrides: hasOwnMatchShape(first),
      locked: row.matches.some(isPlayedMatch) || event.status === 'completed',
    };
  });

  if (rows.length === 0) return null;

  const setCount = rows.filter((r) => r.overrides).length;
  const everyRoundInherits = setCount === 0;
  // OPEN BY DEFAULT ONLY WHEN THERE IS SOMETHING TO SEE. A draw whose rounds
  // differ opens on the table, because the table is the information; a draw
  // where every round inherits opens on one line. Either way the disclosure
  // works in both directions — an exec who has read the ladder can put ~430px
  // of table away and get the bracket back, which is the thing they came for.
  const expanded = userOpen ?? !everyRoundInherits;

  // Every round inherits, so every row resolved to the same string — say it once.
  const summary = rows[0]!;
  const multiplier = eventEloMultiplier(event.elo_multiplier);

  // THE ARITHMETIC, SAID ONCE. It used to sit under all eight selects, where
  // repeating a constant eight times taught nothing. It exists at all because
  // "1 game to 11" reads as a knock-down round and gives no clue what it is
  // worth: the guess it invites is 11/21 = about a half, or the 0.25 clamp
  // floor, and both are wrong for a round in an event whose multiplier is 1.25.
  // "Any round can be changed" is only said where it is TRUE. On a completed
  // event, or a draw whose every round has been played, nothing here is editable
  // and the sentence would be an invitation to press something that is not
  // there — the same class of lie as the event-level format badge that named a
  // shape the first round was never played to.
  const anyEditable = rows.some((r) => !r.locked);
  const legend = (
    <p className="text-[10px] leading-snug text-[var(--text-muted)]">
      Elo is how hard a round moves ratings: the round&rsquo;s own weight (longer games count for more)
      times this event&rsquo;s multiplier of{' '}
      <span className="font-mono text-[var(--text-secondary)]">{multiplier.toFixed(2)}</span>. A rated
      challenge played to 21 is 1.00×.
      {anyEditable
        ? ' Any round can be changed until it has a result.'
        : ' These rounds are fixed: each one has a result, or the event is finished.'}
    </p>
  );

  return (
    <div className="mb-3 rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Played to
        </span>

        {/* ONE LINE FOR THE CASE THAT IS ALMOST ALWAYS TRUE. Both figures are
            here because neither is the answer on its own: the owner's question
            was whether a game to 11 counts a quarter, and 0.52 alone does not
            say that a 1.25 event multiplier lifts it to 0.65.

            When the rounds DO differ there is no single shape and no single
            weight to print, so the collapsed line counts the departures instead
            and the table one press away is where they are named. Printing a
            "mostly Best of 3 to 21" here would be the old lie in one line. */}
        {!expanded && (
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
            {everyRoundInherits ? (
              <>
                <span className="text-[var(--text-secondary)]">
                  Every round
                  {rows.length > 1 ? <span className="text-[var(--text-muted)]"> ({rows.length})</span> : null}
                </span>
                <span className="font-medium text-[var(--text-primary)]">{summary.resolved}</span>
                <span className="font-mono text-[11px] text-[var(--text-muted)]" title={summary.elo.spoken}>
                  <span className="sr-only">{summary.elo.spoken}</span>
                  <span aria-hidden="true">Elo {summary.elo.short}</span>
                </span>
              </>
            ) : (
              <span className="text-[var(--text-secondary)]">
                <span className="font-semibold text-[var(--color-accent)]">{setCount}</span>
                {' of '}{rows.length}{' rounds set individually'}
              </span>
            )}
          </span>
        )}

        <button
          type="button"
          onClick={() => setUserOpen(!expanded)}
          aria-expanded={expanded}
          className="ml-auto min-h-[44px] rounded-[8px] px-2 text-[12px] font-medium text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {expanded ? 'Hide rounds' : everyRoundInherits ? 'Set rounds individually' : 'Show rounds'}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2">
          {/* CAPPED, NOT STRETCHED. Left to fill a 1184px pane the three columns
              drift ~350px apart and the eye loses which weight belongs to which
              round — the association the table exists to make. The cap is a
              reading measure for a 3-column table, not a breakpoint: below it
              the columns simply shrink. */}
          <table className="w-full max-w-[620px] border-collapse">
            <caption className="sr-only">
              What each round of this draw is played to, and what it is worth to a rating
            </caption>
            <thead>
              <tr className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <th scope="col" className="py-1 pr-3 text-left font-semibold">Round</th>
                <th scope="col" className="py-1 pr-3 text-left font-semibold">Played to</th>
                <th scope="col" className="py-1 text-right font-semibold">Elo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-[var(--border)] align-middle"
                >
                  {/* A ROUND THAT DEPARTS FROM THE EVENT SAYS SO THREE WAYS —
                      an accent rule down its left edge, its name in the primary
                      colour at a heavier weight, and the word "Set". Three
                      channels rather than one because colour alone is not a
                      distinction every reader can make, and because the whole
                      complaint was that the departing round was invisible. */}
                  <th
                    scope="row"
                    className={`py-1 pr-3 text-left text-[12px] ${
                      row.overrides
                        ? 'border-l-2 border-l-[var(--color-accent)] pl-2 font-semibold text-[var(--text-primary)]'
                        : 'pl-2 font-normal text-[var(--text-secondary)]'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span>{row.name}</span>
                      {row.overrides && (
                        <span className="rounded-[4px] bg-[var(--color-accent)] px-1 py-px text-[9px] font-bold uppercase tracking-wide text-[var(--bg-base)]">
                          <span className="sr-only">Set for this round, not inherited from the event: </span>
                          Set
                        </span>
                      )}
                    </span>
                  </th>
                  <td className="py-1 pr-3">
                    <RoundShapeControl
                      event={event}
                      matches={row.matches}
                      phase={phase}
                      roundNumber={row.roundNumber}
                      thirdPlace={row.thirdPlace}
                      variant="control"
                    />
                  </td>
                  {/* The weight lives in its own column so the eye can run down
                      it. In the old strip it sat under each select, which is
                      where the eight identical copies were. */}
                  <td
                    className="py-1 text-right align-middle font-mono text-[11px] text-[var(--text-muted)] whitespace-nowrap"
                    title={row.elo.spoken}
                  >
                    <span className="sr-only">{row.elo.spoken}</span>
                    <span aria-hidden="true">{row.elo.short}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {legend}
        </div>
      )}
    </div>
  );
}
