import type { ReactNode } from 'react';
import {
  getRoundName, computeDrawLayout, drawHalves, drawQuarters, drawLastRounds, splitPairLabel,
  SKIP_SLOT_LABEL, SKIP_STATUS_LABEL,
} from '@badminton/shared';
import type { DrawSide, DrawLayout } from '@badminton/shared';
import { DrawScroller, type DrawView } from './DrawScroller';

/**
 * THE PLAYER APP'S HALF OF THE CONVERGING DRAW.
 *
 * Every offset comes from `computeDrawLayout` in @badminton/shared — the same
 * function the console's bracket tab is built on, so the two diagrams cannot
 * drift the way the two hand-maintained copies of this geometry did. This file
 * owns the sizes it draws at and the markup; it owns no arithmetic.
 *
 * IT RENDERS THE DRAW TWICE, and only one is ever on screen. Above 768px the
 * chart; below it, a plain round-by-round list. See the note on `DrawRounds`
 * for why a phone does not get the chart.
 *
 * The sizes below are the sizes the chart is LAID OUT at, which above a certain
 * draw size is not the size it is drawn at: DrawScroller scales the whole thing
 * down to fit its box. Nothing here has to know that — a transform leaves every
 * measured figure in this file true, which is most of why it is a transform.
 */

// The card is two entrant rows and a status strip, and no more: a phone-first
// app's chart has to be narrow enough that a reader can follow one path across
// it, and the console's meta strip (match number, court) is scoring-table
// information that nobody courtside is looking for.
const SIDE_H = 24;
const FOOT_H = 16;
const CARD_H = SIDE_H * 2 + FOOT_H;   // 64
const CARD_GAP = 10;
const COL_W = 168;
// DO NOT NARROW THIS TO CLAW BACK PAGE WIDTH. While the height binds, the scale
// is budget/h, so a narrower sheet is drawn at the SAME scale and only ends up
// smaller — a LINK_W cut increases the dead margin it was meant to close.
// CARD_GAP is the only geometry constant whose reduction touches h, and COL_W is
// untouchable (its measured truncation figures are on EntryName below).
const LINK_W = 24;
const HEAD_H = 26;
const PLAYOFF_CAPTION_H = 64;
/**
 * HOW THICK A CONNECTOR IS PAINTED, which is not how thick the engine says it
 * is. `computeDrawLayout` emits mathematical hairlines — 1 on whichever axis the
 * segment has no extent on — and a literal 1px span filled with --border (8%
 * alpha) then multiplied down by the sheet's transform was invisible: at the
 * 0.68 page floor it rasterised at ~68% coverage of an already 1.2:1 line.
 *
 * The fix is here, at the paint, and not in the shared geometry: the engine's 1
 * is what `bracket-layout.test.ts` identifies risers by and measures edge and
 * centre-line landings against. Each segment is grown from its hairline axis and
 * backed off by half the growth, so the painted line stays centred on the
 * coordinate those assertions are about.
 */
const LINK_PX = 2;

const GEOMETRY = {
  cardH: CARD_H,
  cardGap: CARD_GAP,
  colW: COL_W,
  linkW: LINK_W,
  headH: HEAD_H,
  playoffCaptionH: PLAYOFF_CAPTION_H,
};

/**
 * THE SMALLEST DRAW THAT IS EVER BUILT IN HALVES — five rounds, so 32 entrants
 * and up. Not a taste call: it is the smallest draw that a projector can fail
 * to fit, so below it the halves could never be shown and building them would
 * be pure cost.
 *
 * Measured in full screen against the compiled CSS. At 1920×1080 a 16-draw
 * (four rounds, 1320×349) fits both axes at 1.43, and at 1280×720 — the worst
 * projector this feature admits to — it still fits at 0.9424. A 32-draw is the
 * first that does not: at 1704×608 it needs 0.7300 at 720p, below the 0.80
 * floor, and so is the first that has anything to gain.
 *
 * The cost this buys off is real but small: the halves are built by the SERVER
 * component whether or not full screen is ever entered, so their markup travels
 * in the flight payload every time. Two halves are about the same element count
 * as the whole chart, so a draw that has them pays roughly double for its
 * chart. Worth it at 32 and up, which is where a projector is; not worth it
 * below, where one never is.
 */
const HALVES_FROM_ROUNDS = 5;

/**
 * THE SMALLEST DRAW THAT IS EVER BUILT IN QUARTERS — six rounds, so 64 entrants
 * and up. Derived exactly as HALVES_FROM_ROUNDS is, one rung along: it is the
 * smallest draw whose HALF a projector can fail to fit, so below it a quarter
 * could never be the sheet that rescued anything.
 *
 * Measured in full screen at 1280×720, the worst projector this feature admits
 * to. A 32-draw's half is 1320×477 and fits both axes at 0.9424, comfortably
 * over the 0.80 floor — so a 32 has nothing to gain and its quarter would be
 * seven matches on a sheet whose centre column carries a borrowed card. A
 * 64-draw's half is 1704×625 and needs 0.730; it crops, and its quarter
 * (1320×349) fits at 0.9424. That is the gap this exists to close.
 *
 * WHAT IT DOES NOT CLOSE, said plainly: a 128's quarter is 1704×608 and needs
 * 0.730 at 720p as well — the WIDTH binds, and no amount of cutting by side
 * fixes that below an eighth. A 128 on a 720p projector still falls back to the
 * business end, which fits at 1.329.
 *
 * The cost is the same cost the halves pay and it is paid by the SERVER: four
 * more sheets travel in the flight payload whether or not full screen is ever
 * entered. That is why this is gated at 64 and not at 32 — a 32 is the commonest
 * draw in the club and it pays nothing.
 */
const QUARTERS_FROM_ROUNDS = 6;

/**
 * WHAT THE FOUR QUARTERS ARE CALLED, top to bottom.
 *
 * The draw has no established name for a quarter the way it has "top half" and
 * "bottom half", so these are anchored at the ends: the two the reader can place
 * without counting are named for where they are, and the two in between are
 * given the ordinals that put them in order between them. `drawQuarters` returns
 * them in this order — down the sheet — so the index is the label.
 */
const QUARTER_LABELS = ['Top quarter', 'Second quarter', 'Third quarter', 'Bottom quarter'] as const;

/**
 * THE BUSINESS END: quarter-finals, semi-finals, final.
 *
 * "split this away into Quarter finals to finals" — the rounds a room actually
 * watches. Three is the count that makes that phrase true on EVERY draw size,
 * because a round's name is decided by counting back from the final: the third
 * round from the end is the quarter-final of a 16 and of a 128 alike. So this
 * is not a size-dependent guess, and the view never has to be relabelled.
 */
const FINALS_ROUNDS = 3;

/**
 * THE SMALLEST DRAW THAT IS OFFERED THE BUSINESS END — four rounds, so 16
 * entrants and up. An 8-entry draw IS its own last three rounds, so below this
 * the option would be a second button showing the sheet the reader is already
 * looking at. `drawLastRounds` refuses that case on its own; this constant is
 * the same rule said where the view list is built, so the option is simply
 * absent rather than present and degenerate.
 *
 * IT IS NOT GATED ON THE FIT, unlike the halves, and that is the point of it.
 * The halves exist because a 128 cannot be shown whole at a readable size —
 * they are a remedy for a sheet that does not fit. This is not a remedy: a
 * 16-draw fits whole at every resolution and is still offered its last three
 * rounds, because what the room wants at 7pm on finals night is the four
 * matches that are left, printed as large as the wall can carry them. On a
 * 1920×1080 projector that is 2.0 against the whole 16-draw's 1.43.
 */
const FINALS_FROM_ROUNDS = 4;

/**
 * THE CAPTION UNDER A CENTRE-COLUMN CARD IS SHORTER ON THE BUSINESS END, and
 * the geometry has to be told so or the room reserved would not be the room
 * used.
 *
 * The whole draw and the halves reserve 64px, which is a heading and two 11px
 * lines. That was measured for a sheet 477–2384px tall, where 64px is trim. The
 * quarter-finals-to-final tree is 138px tall: the third-place block at 64px of
 * caption would be 128px of the sheet against 138px of actual bracket, so
 * nearly half of what the projector showed would be a card and a sentence about
 * a match that is not in the tree.
 *
 * It shortens because it CAN, not to save room. That caption's job is to say
 * where the two entrants came from, and on this view both semi-finals are on
 * screen a few centimetres above it — the picture answers the question the
 * sentence was there to answer, so one line does.
 *
 * 40px IS THE MEASURED STACK, in Chrome against the compiled CSS at the 168px
 * column: 8px of `mt-2`, a 12px `.eyebrow` heading and one 11px line at
 * `leading-snug`, which measures 15.1px. 35.1px in a 40px reservation.
 *
 * AND THE SENTENCE IS MEASURED TOO, because "one line" is a claim about a
 * string and not about a style. "Between the two beaten semi-finalists." wraps
 * to two lines in that column and paints 50px into the 40; "The two beaten
 * semi-finalists." is 15.1px and fits. Counting characters would not have
 * caught it — the render did.
 */
const FINALS_CAPTION_H = 40;

const FINALS_GEOMETRY = { ...GEOMETRY, playoffCaptionH: FINALS_CAPTION_H };

/**
 * The third-place playoff's heading and its long caption, written once because
 * three of the four views print them and a fourth prints a shortened form. Two
 * lines at 11px, which is what `GEOMETRY.playoffCaptionH` reserves room for.
 */
const THIRD_PLACE_HEADING = '3rd Place Playoff';
const THIRD_PLACE_CAPTION =
  'The two beaten semi-finalists, one from each half. The winner does not advance to the final.';

/**
 * One knockout match, already resolved to entry ids. The page flattens singles
 * and pairs into this shape so nothing below has to branch on `doubles` again.
 */
export interface DrawMatch {
  id: string;
  round_number: number;
  bracket_position: number;
  round_name: string | null;
  status: string;
  scores: Array<{ a: number; b: number }> | null;
  is_bye: boolean;
  aId: string | null;
  bId: string | null;
  winnerId: string | null;
}

interface DrawProps {
  /** The main tree. The third-place playoff is NOT in here — see `thirdPlace`. */
  matches: DrawMatch[];
  thirdPlace: DrawMatch | null;
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
  /**
   * What the sheet is, for the FULL-SCREEN header only — the page already says
   * both of these in its own header. A projected chart with no caption is a
   * bracket nobody in the room can place.
   */
  title?: string;
  subtitle?: string;
  /**
   * THE CARD'S OWN HEADING — the `Trophy` + `<h2>Draw</h2>` row, authored by the
   * page like every other card's on it, but rendered down here because it has to
   * share a flex row with the Full screen button and that button cannot leave
   * `.draw-chart-wrap`. See the note at the two render sites below.
   */
  heading?: ReactNode;
}

/** A skip match has one real entry and one empty slot; only the empty side is labelled. */
function entryName(m: DrawMatch, side: 'a' | 'b', nameOf: Record<string, string>): string {
  const id = side === 'a' ? m.aId : m.bId;
  if (!id) return m.is_bye ? SKIP_SLOT_LABEL : 'TBD';
  return nameOf[id] || 'TBD';
}

function entrySeed(m: DrawMatch, side: 'a' | 'b', seedOf: Record<string, number | null>): number | null {
  const id = side === 'a' ? m.aId : m.bId;
  return id ? seedOf[id] ?? null : null;
}

/**
 * A BYE IS NOT A WIN, and the guard has to be here because the DATA says it is.
 * The generator completes a skip match with the real entrant already in
 * `winner_*_id`, so without this line the entrant who walked into the next round
 * got .match-winner — the red accent and the glow — for a match nobody played,
 * plus an sr-only "(Winner)" announcing it. This is the position the rest of the
 * codebase already takes: see tournament-withdrawal.test.ts:133, where
 * `isPlayedMatch({ status: 'completed', is_bye: true })` is false.
 *
 * One boolean, not a CSS change: .match-winner styles every winner in the app
 * and the skip card's own muted treatment (opacity-50, secondary text) is
 * already right — what it needed was for nothing to override it.
 */
function isWinner(m: DrawMatch, side: 'a' | 'b'): boolean {
  if (m.is_bye) return false;
  const id = side === 'a' ? m.aId : m.bId;
  return !!id && !!m.winnerId && id === m.winnerId;
}

/** The whole scoreline, for the list view, where there is room for it. */
function scoreLine(m: DrawMatch): string {
  if (!m.scores || m.scores.length === 0) return '';
  return m.scores.map((s) => `${s.a}–${s.b}`).join(', ');
}

/**
 * THE SCORELINE GOES IN THE FOOTER, not on the entrant rows.
 *
 * The console puts one side's digits on each row, which it can afford at a
 * 196px column. Here the column is 168px — a phone-first app's chart has to be
 * narrow enough to follow a path across — and a best-of-3's "21 15 21" beside a
 * seed took 40px out of 144, which truncated "Katarzyna Kowalski" to
 * "Katarzyna…" on a card that had room to print it. Measured at 1440px against
 * the compiled CSS, not reasoned about. The full line fits on the footer strip
 * that was otherwise carrying the word "vs".
 */
function footerText(m: DrawMatch): string {
  if (m.is_bye) return SKIP_SLOT_LABEL;
  const line = scoreLine(m);
  if (line) return m.status === 'walkover' ? `${line} W/O` : line;
  if (m.status === 'completed' || m.status === 'walkover') return 'W/O';
  if (m.status === 'live') return 'Playing';
  return 'vs';
}

export function Draw({ matches, thirdPlace, nameOf, seedOf, title, subtitle, heading }: DrawProps) {
  const layout = computeDrawLayout(matches, GEOMETRY, { thirdPlace: !!thirdPlace });
  // THE HIGHEST round_number, not the COUNT of rounds. getRoundName counts back
  // from the final — `totalRounds - roundNumber + 1` — so the two arguments have
  // to be in the same numbering. Handed a count, a draw whose rounds are not
  // numbered 1..R (anything hand-built, anything the pool half shifted) goes
  // negative and prints "Round of 0.0078125". Only the fallback is affected,
  // since the generator stamps round_name on every row it writes, which is
  // exactly why it would have gone unnoticed.
  const lastRoundNumber = matches.reduce((max, m) => Math.max(max, m.round_number), 0);
  const roundName = (roundNumber: number) =>
    matches.find((m) => m.round_number === roundNumber)?.round_name
    ?? getRoundName(roundNumber, lastRoundNumber);

  const readingNote = layout.mode === 'converging'
    ? 'The top half runs inwards from the left, the bottom half from the right, and they meet at the final in the middle.'
    : 'This draw’s rounds do not halve, so it is shown as a plain left-to-right ladder.';

  /**
   * THE TWO PAGES A DRAW TOO BIG FOR A PROJECTOR IS SHOWN AS.
   *
   * "what if u split 128 into 2 and 64 aswell, 2 pages?" A 128 needs 0.41 to
   * fit a 1080p screen whole, is refused by the 0.80 floor and scrolls, which
   * on a projector nobody is standing at is the same as being cropped.
   *
   * WHAT A HALF IS, and it is not "the left column of the sheet". Each half is
   * fed back through the SAME layout engine and converges in its own right, so
   * the top half of a 128 is 64 entrants meeting at a semi-final — the same
   * shape, and the same 1200px, as a whole 64 draw, which already fits. That
   * is the whole trick: halving buys a size class. Laying a half out as a plain
   * ladder would keep all 32 of its rows and buy nothing.
   *
   * ROUND NAMES STILL COME FROM THE WHOLE DRAW. `roundName` closes over
   * `lastRoundNumber` computed from every match, so a half page's centre column
   * reads "Semi-final" and not "Final" — which is what it would say if the
   * names were re-derived from the half's own round count.
   */
  const halves = layout.rounds >= HALVES_FROM_ROUNDS ? drawHalves(layout) : null;
  const finalMatch = layout.nodes.find(
    (n) => n.side === 'centre' && n.depth === layout.rounds - 1,
  )?.match ?? null;

  const halfViews: DrawView[] = halves && finalMatch
    ? ([['top', halves.top], ['bottom', halves.bottom]] as const).map(([half, halfMatches]) => {
        // centreSlots: 1 is the FINAL. It is not in either half — its two
        // feeders are one per page — so it is repeated on both, in the clear
        // centre column under the semi-final, exactly where and for exactly
        // the reason the third-place playoff already sits. The third-place
        // match, whose two entrants are also one per page, follows it down.
        const pageLayout = computeDrawLayout(halfMatches, GEOMETRY, {
          centreSlots: 1,
          thirdPlace: !!thirdPlace,
        });
        const other = half === 'top' ? 'bottom' : 'top';
        const label = half === 'top' ? 'Top half' : 'Bottom half';
        return {
          key: half,
          label,
          heading: label,
          noun: 'half',
          // TWO PAGES MAKE THE WHOLE DRAW. See `cover` on DrawView: this is what
          // stops the rotation showing the room the halves AND the quarters, which
          // is the same matches twice a cycle.
          cover: 2,
          sideHint: 'Scroll sideways — this half meets at the semi-final',
          width: pageLayout.width,
          height: pageLayout.height,
          note: `The ${half} half of the draw, meeting at its semi-final in the middle. `
            + `The final is repeated on both halves.`,
          body: (
            <ChartBody
              layout={pageLayout}
              part={label.toLowerCase()}
              roundName={roundName}
              nameOf={nameOf}
              seedOf={seedOf}
              extras={[
                {
                  key: 'final',
                  pos: pageLayout.centreSlots[0]!,
                  match: finalMatch,
                  heading: roundName(finalMatch.round_number),
                  // TWO LINES, AND THAT IS A MEASURED LIMIT rather than a
                  // house style. The centre column stacks its cards a
                  // `cardH + playoffCaptionH` pitch apart, so this sentence has
                  // 64px under the card and the heading takes 22 of them: at
                  // 11px in a 152px field a third line lands on top of the
                  // third-place playoff's own heading. Where the other
                  // finalist comes from is said once, in the page's header,
                  // where there is room for it.
                  caption: `The winner of this half plays the winner of the ${other} half.`,
                },
                ...(thirdPlace && pageLayout.thirdPlace
                  ? [{
                      key: 'third',
                      pos: pageLayout.thirdPlace,
                      match: thirdPlace,
                      heading: THIRD_PLACE_HEADING,
                      caption: THIRD_PLACE_CAPTION,
                    }]
                  : []),
              ]}
            />
          ),
        };
      })
    : [];

  /**
   * THE FOUR PAGES A DRAW TOO BIG FOR A 720p PROJECTOR IS SHOWN AS.
   *
   * A quarter is a HALF OF A HALF and `drawQuarters` computes it that way, so
   * nothing here decides which card is in which quarter — see its note. What
   * this owns is the same one decision the halves own: what goes in the clear
   * centre column under the page's root.
   *
   * ONE BORROWED CARD, AND IT IS THE SEMI-FINAL. The rule the halves established
   * is "borrow the one card your root feeds, because its other feeder is on
   * another page", and that rule carries here unchanged: a half's root is a
   * semi-final and it borrows the final; a quarter's root is a quarter-final and
   * it borrows the semi-final. Following it rather than extending it is what
   * makes a quarter come out 1704×608 on a 128 — byte-identical to a whole 32
   * draw, which is the same "buys a size class" the halves earned.
   *
   * NO FINAL, and that is not an oversight. The final is two cards up from this
   * page's root, so borrowing it would mean borrowing the semi-final's own
   * sibling context too, and the sheet the room wants for the final is already in
   * this dropdown: "Quarter-finals to final" fits at 1.329 on the very projector
   * that made quarters necessary.
   *
   * NO THIRD-PLACE PLAYOFF EITHER, unlike a half, and the asymmetry is the
   * arithmetic rather than a taste. A half always contributes exactly one of the
   * two beaten semi-finalists, so the card is certainly about it. A quarter
   * contributes one only if its own winner loses the semi-final — a card that is
   * about this page half the time, printed on four pages, for 128px of the
   * scarcest column on the sheet.
   */
  const quarters = layout.rounds >= QUARTERS_FROM_ROUNDS ? drawQuarters(layout) : null;

  const quarterViews: DrawView[] = quarters && quarters.length === QUARTER_LABELS.length
    ? quarters.map((quarter, i) => {
        const pageLayout = computeDrawLayout(quarter.matches, GEOMETRY, { centreSlots: 1 });
        const label = QUARTER_LABELS[i]!;
        // `i ^ 1` IS THE PAIRING, and it is `drawQuarters`'s own: quarters 0 and 1
        // feed one semi-final and 2 and 3 the other, so a quarter's partner is its
        // index with the low bit flipped. Reading it off `quarter.feeds` instead —
        // "the other quarter with the same feeds" — would be the same answer found
        // the long way round.
        const other = QUARTER_LABELS[i ^ 1]!;
        return {
          key: `quarter-${i + 1}`,
          label,
          heading: label,
          noun: 'quarter',
          cover: 4,
          sideHint: 'Scroll sideways — this quarter meets at the quarter-final',
          width: pageLayout.width,
          height: pageLayout.height,
          note: `The ${label.toLowerCase()} of the draw, meeting at its quarter-final in the middle. `
            + `The semi-final it feeds is repeated below it.`,
          body: (
            <ChartBody
              layout={pageLayout}
              // THE PAGE'S QUARTER, not the node's side. On a quarter page
              // `node.side` is the side of THAT page's own converging chart, which
              // is an EIGHTH of the real draw — announcing it would tell a screen
              // reader that half the cards on the top quarter are somewhere else.
              part={label.toLowerCase()}
              roundName={roundName}
              nameOf={nameOf}
              seedOf={seedOf}
              extras={[
                {
                  key: 'semi',
                  pos: pageLayout.centreSlots[0]!,
                  match: quarter.feeds,
                  heading: roundName(quarter.feeds.round_number),
                  // TWO LINES, AND THAT IS MEASURED. In headless Chrome against
                  // the compiled CSS at the 168px column this wraps to two lines
                  // and the heading, its 8px of `mt-2` and the caption come to
                  // 49.8px of the 64px `playoffCaptionH` reserves. A third line
                  // would paint past `bodyH`, which the scaled box's height does
                  // not include, so it would be shaved off at the bottom of the
                  // scroll region rather than collide with anything — which is why
                  // this is kept to the one thing the picture cannot say: where
                  // the borrowed card's other entrant comes from.
                  caption: `Its other entrant comes from the ${other.toLowerCase()}.`,
                },
              ]}
            />
          ),
        };
      })
    : [];

  /**
   * QUARTER-FINALS TO FINAL, LAID OUT FROM SCRATCH.
   *
   * `drawLastRounds` returns the matches and nothing else — no coordinates —
   * so the only way to draw them is to send them back through the engine, and
   * the engine stacks the four quarter-finals at one pitch like any other first
   * round. That is the fix for the sheet that was reported: at the whole draw's
   * own coordinates a 128's two left-hand quarter-finals are 1120px apart, and
   * at the 0.80 full-screen floor that is 896px of blank projector between the
   * quarter-final row and the semi-final row. Re-laid-out the gap is 10px.
   *
   * NO `centreSlots` HERE, unlike a half, and getting that backwards would put
   * a second card under a card that is already the root. A half stops at a
   * semi-final and has to borrow room for the final because the final's other
   * feeder is on the other page; this view CONTAINS the final, so the centre
   * column below it is free for the third-place playoff alone.
   */
  const finalsMatches = layout.rounds >= FINALS_FROM_ROUNDS
    ? drawLastRounds(layout, FINALS_ROUNDS)
    : null;
  const finalsLayout = finalsMatches
    ? computeDrawLayout(finalsMatches, FINALS_GEOMETRY, { thirdPlace: !!thirdPlace })
    : null;

  const finalsView: DrawView[] = finalsLayout
    ? [{
        key: 'finals',
        label: 'Quarter-finals to final',
        heading: 'Quarter-finals to final',
        noun: 'view',
        // NOT A COVER OF THE DRAW AT ALL — see `cover` on DrawView. This sheet
        // leaves 120 of a 128's matches out on purpose, so no number of copies of
        // it is the draw, and it is the one view the rotation shows alongside
        // whichever cover tier it settles on.
        cover: 0,
        sideHint: 'Scroll sideways — the two sides meet at the final',
        width: finalsLayout.width,
        height: finalsLayout.height,
        note: 'The last three rounds only: the quarter-finals, the semi-finals and the final.',
        body: (
          <ChartBody
            layout={finalsLayout}
            // NOT a subset by side, so the cards keep their own sides — and those
            // are the real draw's. `computeDrawLayout` assigns sides by walking
            // down from the root, and the four quarter-finals of this subset
            // walk down from the same two semi-finals they do on the whole
            // sheet, so a card labelled "top half" here is in the top half
            // there. That is why this view does not need the override the half
            // and quarter pages do.
            part={null}
            roundName={roundName}
            nameOf={nameOf}
            seedOf={seedOf}
            extras={thirdPlace && finalsLayout.thirdPlace
              ? [{
                  key: 'third',
                  pos: finalsLayout.thirdPlace,
                  match: thirdPlace,
                  heading: THIRD_PLACE_HEADING,
                  // ONE LINE, because both semi-finals are on this sheet. The
                  // long caption exists to say where the two entrants came
                  // from; here the reader can see it. Measured at the 168px
                  // column, not counted — see FINALS_CAPTION_H.
                  caption: 'The two beaten semi-finalists.',
                }]
              : []}
          />
        ),
      }]
    : [];

  /**
   * THE VIEWS, IN THE ORDER THE DROPDOWN OFFERS THEM, and the whole draw is
   * always the first of them.
   *
   * "for all the section since one cannot be active when other is active" —
   * they are one mutually exclusive choice, so they are one list. DrawScroller
   * shows `views[0]` on the page and whenever full screen is not on; everything
   * after it is only ever reachable from the full-screen dropdown.
   *
   * COARSEST FIRST, and the extract last. The order is what the arrow keys step
   * and what the default view falls back through — "the first view that fits" —
   * so putting the halves before the quarters is what makes a screen that can
   * show a half show a half rather than a quarter of the same draw.
   */
  const views: DrawView[] = [
    {
      key: 'whole',
      label: 'Whole draw',
      noun: 'draw',
      cover: 1,
      sideHint: 'Scroll sideways — the two halves meet at the final',
      width: layout.width,
      height: layout.height,
      note: readingNote,
      body: (
        <ChartBody
          layout={layout}
          part={null}
          roundName={roundName}
          nameOf={nameOf}
          seedOf={seedOf}
          extras={thirdPlace && layout.thirdPlace
            ? [{
                key: 'third',
                pos: layout.thirdPlace,
                match: thirdPlace,
                heading: THIRD_PLACE_HEADING,
                caption: THIRD_PLACE_CAPTION,
              }]
            : []}
        />
      ),
    },
    ...halfViews,
    ...quarterViews,
    ...finalsView,
  ];

  return (
    <>
      {/* THE CHART — tablet and up only. `display: none` below 768px, so on a
          phone it contributes no width at all and the page body cannot be
          pushed sideways by it. */}
      <div className="draw-chart-wrap px-4 pt-4 pb-4">
        {/* THE HEADING GOES DOWN INTO THE SHELL, so it can share the shell's
            existing header row with the Full screen button — "in the same row as
            draw". It is handed to DrawScroller rather than printed here because
            that row (`.draw-topline`) is inside the element that goes full
            screen, and the button that has to sit in it is owned by the client
            component that holds the fullscreen state.

            The reading note goes with it, and it is the same `readingNote` as
            ever: DrawScroller now prints it from the ACTIVE VIEW's own `note`.
            Off full screen the active view is always `views[0]`, whose note IS
            this string, so nothing has been duplicated or can drift — the
            "one string, two places" this comment used to describe collapsed
            into one string in one place with two containers. */}
        {/* The sized, positioned box the absolute offsets below are relative to
            is DrawScroller's innermost one — it owns it because it is the one
            being transformed to fit. Everything here is laid out at full size
            and scaled as a whole. */}
        <DrawScroller title={title} subtitle={subtitle} views={views} heading={heading} />
      </div>

      {/* THE SAME HEADING AGAIN, FOR THE PHONE, and this is not a duplicate that
          can double up: `.draw-rounds` and `.draw-chart-wrap` are exact
          complements — one is `display:block` below 768px and `none` above, the
          other the reverse — so at every width exactly one copy of the heading
          paints and the card is never untitled and never titled twice. Reusing
          that existing switch is why this needs no media query of its own.

          It is rendered here rather than left in the page because the tablet
          copy had to move inside `.draw-chart-wrap` to reach the button's row,
          and a heading that lives only there would take the card's `<h2>` out of
          the document outline on a phone. */}
      <DrawRounds
        layout={layout}
        thirdPlace={thirdPlace}
        nameOf={nameOf}
        seedOf={seedOf}
        roundName={roundName}
        heading={heading}
      />
    </>
  );
}

/**
 * A card that is drawn in the centre column but is NOT part of the tree the
 * layout was built from — the third-place playoff on a whole draw, on a half
 * page the final as well, and on a quarter page the semi-final it feeds.
 *
 * Nothing is drawn joining any of them to anything, and that is one rule rather
 * than two exceptions: every card in here is fed from BOTH halves at once, so
 * there is no single line back to its entrants that would not cross the sheet
 * and say something false about what it crossed. The caption carries it.
 */
interface CentreExtra {
  key: string;
  pos: { x: number; y: number };
  match: DrawMatch;
  heading: string;
  caption: string;
}

/**
 * THE CHART ITSELF, drawn from whatever layout it is handed.
 *
 * ONE RENDERER FOR THE WHOLE DRAW, FOR A HALF OF IT AND FOR A QUARTER. Every
 * one of them is the same shape — a converging tree with a centre column — so
 * it is the same markup with a different layout, and writing it more than once
 * is how they would come to disagree about a card that had been edited on one.
 *
 * `part` IS THE PAGE'S OWN SUBSET, AND IT OVERRIDES THE NODE'S SIDE FOR
 * LABELLING. On a subset page `node.side` is the side of THAT page's own
 * converging chart — a quarter of the real draw on a half page, an eighth of it
 * on a quarter page — so reading the aria-label off it would announce half the
 * cards on the top-half page as being in the bottom half. A subset page says
 * only which subset it is, on every card, and it is handed the words rather than
 * deriving them because the words are the dropdown's own labels: a card cannot
 * be announced as part of something the menu does not offer.
 */
function ChartBody({
  layout, part, roundName, nameOf, seedOf, extras,
}: {
  layout: DrawLayout<DrawMatch>;
  /** Lower case, and it is a whole phrase: 'top half', 'second quarter'. */
  part: string | null;
  roundName: (roundNumber: number) => string;
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
  extras: CentreExtra[];
}) {
  const roundLabel = (roundNumber: number, side: DrawSide) => {
    if (part) return `${roundName(roundNumber)}, ${part}`;
    return side === 'centre'
      ? roundName(roundNumber)
      : `${roundName(roundNumber)}, ${side === 'left' ? 'top' : 'bottom'} half`;
  };

  return (
    <>
      {layout.columns.map((col) => (
        <div
          key={col.key}
          className="absolute eyebrow flex items-center justify-center"
          style={{ left: col.x, top: 0, width: COL_W, height: HEAD_H }}
        >
          {roundName(col.roundNumber)}
        </div>
      ))}

      <div className="absolute inset-x-0" style={{ top: HEAD_H, height: layout.bodyH }} aria-hidden="true">
        {/* The two axes are grown independently, not as an either/or: a stub or
            an entry is a hairline in h with a real w, a riser the other way
            round, and nothing guarantees a segment can only ever be one of the
            two. See LINK_PX. */}
        {layout.connectors.map((c) => (
          <span
            key={c.key}
            className="absolute bg-[var(--draw-link)]"
            style={{
              left: c.w === 1 ? c.x - (LINK_PX - 1) / 2 : c.x,
              top: c.h === 1 ? c.y - (LINK_PX - 1) / 2 : c.y,
              width: c.w === 1 ? LINK_PX : c.w,
              height: c.h === 1 ? LINK_PX : c.h,
            }}
          />
        ))}
      </div>

      <div className="absolute inset-x-0" style={{ top: HEAD_H, height: layout.bodyH }}>
        {layout.nodes.map((node) => (
          <div key={node.id} className="absolute" style={{ left: node.x, top: node.y, width: COL_W }}>
            <ChartCard
              m={node.match}
              side={node.side}
              roundLabel={roundLabel(node.roundNumber, node.side)}
              nameOf={nameOf}
              seedOf={seedOf}
            />
          </div>
        ))}

        {/* The clear space under the centre card. A converging draw's centre
            column holds one match, so it is the only spare room on the sheet
            and it is right where the reader is already looking. */}
        {extras.map((extra) => (
          <div
            key={extra.key}
            className="absolute"
            style={{ left: extra.pos.x, top: extra.pos.y, width: COL_W }}
          >
            <ChartCard
              m={extra.match}
              side="centre"
              roundLabel={extra.heading}
              nameOf={nameOf}
              seedOf={seedOf}
            />
            <h3 className="eyebrow mt-2">{extra.heading}</h3>
            <p className="text-[11px] leading-snug text-[var(--text-muted)]">{extra.caption}</p>
          </div>
        ))}
      </div>
    </>
  );
}

function ChartCard({
  m, side, roundLabel, nameOf, seedOf,
}: {
  m: DrawMatch;
  side: DrawSide;
  roundLabel: string;
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
}) {
  const mirrored = side === 'right';
  const footer = footerText(m);
  const label = `${roundLabel}: ${entryName(m, 'a', nameOf)} vs ${entryName(m, 'b', nameOf)}`;

  return (
    <div
      role="group"
      aria-label={label}
      style={{ height: CARD_H }}
      className={`w-full flex flex-col border border-[var(--border)] overflow-hidden card-surface ${
        m.is_bye ? 'opacity-50' : ''
      }`}
    >
      {(['a', 'b'] as const).map((s) => {
        const won = isWinner(m, s);
        return (
          <div
            key={s}
            style={{ height: SIDE_H }}
            className={`shrink-0 px-2 text-[13px] flex items-center gap-1.5 ${
              mirrored ? 'flex-row-reverse text-right' : ''
            } ${s === 'b' ? 'border-t border-[var(--border)]' : ''} ${
              won ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'
            }`}
          >
            <span className={`nums text-[10px] text-[var(--text-dim)] w-3.5 shrink-0 ${mirrored ? 'text-left' : 'text-right'}`}>
              {entrySeed(m, s, seedOf) ?? ''}
            </span>
            {/* No crown icon on a chart card, unlike the list below: the winner
                already carries .match-winner's colour, and 14px of icon on a
                144px name field is 14px the name needed more. */}
            <EntryName label={entryName(m, s, nameOf)} size="chart" />
            {won && <span className="sr-only">(Winner)</span>}
          </div>
        );
      })}
      <div
        className="nums flex items-center justify-center text-[10px] text-[var(--text-dim)] border-t border-[var(--border)] shrink-0"
        style={{ height: FOOT_H }}
      >
        {footer}
      </div>
    </div>
  );
}

/**
 * ONE ENTRY'S NAME — a doubles pair STACKED, one partner a line.
 *
 * MEASURED, against the compiled CSS with the real Barlow files, not reasoned
 * about. The chart card's name field is 130.0px (the 168px column, less 16px of
 * padding, a 6px gap and the 14px seed gutter). A doubles label is two whole
 * names joined — "Jonathan Smithson & Katarzyna Kowalski" — and that string is
 * 231.9px at 13px. It printed nine characters of thirty-eight and named neither
 * player. Stacked at 11px the longest partner name in the sample,
 * "Bartholomew Fairweather", is 123.3px, so both fit whole with room over.
 *
 * The phone list needed it too, for the same reason and a smaller margin: at
 * 390px that row's name field is 202.5px once a best-of-3's digits are on it,
 * and the joined label needs 232px. The comment that used to sit on ListRow
 * claimed 287px, which was the width BEFORE the digits — the two-line stack is
 * what makes that claim true again.
 *
 * The cost is type size, and it is paid only by doubles — the case that could
 * not be read at all. A single-line label (a singles player, or a pair with a
 * name of its own) keeps its size and its truncation exactly as before.
 */
function EntryName({ label, size }: { label: string; size: 'chart' | 'list' }) {
  const lines = splitPairLabel(label);
  if (lines.length === 1) {
    return <span className="truncate flex-1 min-w-0" title={label}>{label}</span>;
  }
  // leading-[1.05], not [1.1]: the chart row is a fixed 24px and two 11px lines
  // at 1.1 come to 24.2px, which the card's overflow-hidden was shaving.
  const lineClass = size === 'chart' ? 'text-[11px] leading-[1.05]' : 'text-[13px] leading-[1.15]';
  return (
    <span className="flex-1 min-w-0 flex flex-col justify-center" title={label}>
      {lines.map((line, i) => (
        <span key={i} className={`truncate ${lineClass}`}>{line}</span>
      ))}
    </span>
  );
}

/**
 * THE PHONE'S DRAW: one list a round, no chart.
 *
 * A converging draw is 2R-1 columns wide — nine of them on a 32-entry event —
 * which is a wider drag on a 390px screen than the linear chart it replaces,
 * not a narrower one. The height it saves is height a phone never had to pay
 * for: vertical scrolling is free on a phone and sideways scrolling is the
 * expensive axis, so shipping the chart here would spend the one thing that
 * hurts to buy the one thing that does not.
 *
 * So a phone gets the same information as a list, which is what it is good at.
 * The chart is hidden with `display: none` rather than laid out and scrolled,
 * which also means the page body has no wide child at all at 390px — the class
 * of bug that once made a 380px viewport 620px wide cannot occur here.
 *
 * Read alongside "Your Matches" further down the page, which is what somebody
 * standing courtside actually came for.
 */
function DrawRounds({
  layout, thirdPlace, nameOf, seedOf, roundName, heading,
}: {
  layout: ReturnType<typeof computeDrawLayout<DrawMatch>>;
  thirdPlace: DrawMatch | null;
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
  roundName: (roundNumber: number) => string;
  /** The card's heading, on the widths where the chart above is display:none. */
  heading?: ReactNode;
}) {
  const rounds: Array<{ roundNumber: number; nodes: typeof layout.nodes }> = [];
  for (const node of layout.nodes) {
    const found = rounds.find((r) => r.roundNumber === node.roundNumber);
    if (found) found.nodes.push(node);
    else rounds.push({ roundNumber: node.roundNumber, nodes: [node] });
  }
  rounds.sort((a, b) => a.roundNumber - b.roundNumber);
  // Within a round, the top half first and then the bottom, each in draw order
  // — the same order they appear down the chart's two columns.
  for (const r of rounds) {
    r.nodes.sort((a, b) => a.match.bracket_position - b.match.bracket_position);
  }

  // WHICH ROUNDS OPEN. A 128-entrant draw is 127 matches, and every one of them
  // stacked open is a list nobody scrolls to the bottom of — the first round
  // alone is 64 rows, so "the final" is 3,000px below the fold on the one screen
  // that has the least of it.
  //
  // The rule is "the round somebody is here for", in three fallbacks:
  //   * whatever is being PLAYED (live, or ready to start),
  //   * failing that the LAST round with a result, which on a finished event is
  //     the final and on a half-played one is where the draw has got to,
  //   * failing both, round one — nothing has happened yet, so the fixtures are
  //     the news.
  //
  // A SHORT DRAW OPENS WHOLE. Three rounds is at most seven matches; collapsing
  // that buys nothing and costs a reader two taps, so an eight-entry event
  // behaves exactly as it did before this existed.
  const isPlaying = (r: { nodes: typeof layout.nodes }) =>
    r.nodes.some((n) => n.match.status === 'live' || n.match.status === 'ready');
  const hasResult = (r: { nodes: typeof layout.nodes }) =>
    r.nodes.some((n) => n.match.status === 'completed' || n.match.status === 'walkover');

  const allOpen = rounds.length <= 3;
  let focusIndex = rounds.findIndex(isPlaying);
  if (focusIndex === -1) focusIndex = rounds.map(hasResult).lastIndexOf(true);
  if (focusIndex === -1) focusIndex = 0;

  return (
    <div className="draw-rounds px-4 pt-4 pb-4 space-y-2">
      {/* Matches the four sibling cards' heading row. The chart's copy of this
          carries the Full screen button beside it; there is nothing to put
          beside it here, because a phone never gets the chart that button
          projects. */}
      {heading && <div className="flex items-center gap-2 mb-3">{heading}</div>}
      {rounds.map((r, i) => (
        <RoundDisclosure
          key={r.roundNumber}
          title={roundName(r.roundNumber)}
          count={r.nodes.length}
          open={allOpen || i === focusIndex}
        >
          {r.nodes.map((node) => (
            <ListRow key={node.id} m={node.match} nameOf={nameOf} seedOf={seedOf} />
          ))}
        </RoundDisclosure>
      ))}
      {thirdPlace && (
        <RoundDisclosure title="3rd Place Playoff" count={1} open={allOpen || focusIndex === rounds.length - 1}>
          <ListRow m={thirdPlace} nameOf={nameOf} seedOf={seedOf} />
          <p className="text-xs text-[var(--text-muted)] pt-1">
            The two beaten semi-finalists. The winner does not advance to the final.
          </p>
        </RoundDisclosure>
      )}
    </div>
  );
}

/**
 * ONE COLLAPSIBLE ROUND, as a native <details>.
 *
 * Native rather than a toggle with state, because Draw is a SERVER component:
 * a useState disclosure would drag the whole draw across the client boundary
 * for a triangle. <details> also arrives with the keyboard behaviour, the
 * expanded/collapsed announcement and browser find-in-page already working,
 * none of which a div and an onClick get for free.
 *
 * WHAT `open` ACTUALLY DOES HERE, since the obvious claim about it is wrong.
 * React writes the attribute whenever the PROP CHANGES between renders, so this
 * is not a plain initial state: the page is on a realtime channel (00113), a
 * result landing re-renders this list, and `focusIndex` moves when the round
 * being played finishes. A round the reader opened by hand is untouched — its
 * prop is false on both renders — but the round that WAS the focus closes as
 * the focus moves on to the next one. That is the behaviour worth having (the
 * open round follows play) and it costs one tap to undo, but it is not "the
 * browser owns it from then on", and a comment saying so would be a lie a
 * future reader would build on.
 */
function RoundDisclosure({
  title, count, open, children,
}: {
  title: string;
  count: number;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group border border-[var(--border)] rounded-[8px] overflow-hidden">
      {/* 44px minimum, and the whole strip is the target rather than the
          triangle. list-none plus the webkit rule removes the default marker,
          which cannot be laid out inside a flex summary. */}
      <summary className="flex items-center justify-between gap-2 px-3 min-h-[44px] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className="eyebrow">{title}</span>
        <span className="flex items-center gap-2">
          <span className="nums text-[11px] text-[var(--text-dim)]">
            {count} {count === 1 ? 'match' : 'matches'}
          </span>
          <span aria-hidden="true" className="text-[10px] text-[var(--text-dim)] transition-transform group-open:rotate-180">
            ▼
          </span>
        </span>
      </summary>
      <div className="space-y-1.5 px-3 pb-3 pt-1">{children}</div>
    </details>
  );
}

/**
 * ONE MATCH ON A PHONE: the two entrants STACKED, each with its own games down
 * the right, not side by side across the row.
 *
 * Side by side was measured at 390px and does not work. The row is 358px wide;
 * a best-of-3 printed once in the middle ("21-19, 15-21, 21-18") is 100px of
 * it, which leaves 129px a side and truncates "Jonathan Smithson" to
 * "Jonathan..." on both entrants at once. Stacked, each name gets its own row
 * and the digits read down a column the way a scorecard does.
 *
 * Re-measured since: with this side's OWN digits on the row the name field is
 * 202.5px, not the 287px this note used to claim — that was the width before
 * the digits were moved onto it. A doubles label needs 232px, so it still
 * truncated, which is why the name goes through EntryName here as well as on
 * the chart.
 */
function ListRow({
  m, nameOf, seedOf,
}: { m: DrawMatch; nameOf: Record<string, string>; seedOf: Record<string, number | null> }) {
  const decided = m.status === 'completed' || m.status === 'walkover';
  const played = !!m.scores && m.scores.length > 0;
  // The strip only appears when it has something to say. On an unplayed match
  // the two stacked names already read as "these two play each other".
  const note = m.is_bye ? SKIP_STATUS_LABEL
    : played && m.status === 'walkover' ? 'Walkover'
    : !played && decided ? 'Walkover'
    : m.status === 'live' ? 'In progress'
    : null;

  return (
    <div className={`border border-[var(--border)] ${m.is_bye ? 'opacity-50' : ''}`}>
      {(['a', 'b'] as const).map((s) => {
        const won = isWinner(m, s);
        const digits = played ? m.scores!.map((g) => (s === 'a' ? g.a : g.b)).join('  ') : null;
        return (
          <div
            key={s}
            className={`flex items-center gap-2 px-2.5 py-2 text-sm ${
              s === 'b' ? 'border-t border-[var(--border)]' : ''
            } ${won ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'}`}
          >
            <span className="nums text-[10px] text-[var(--text-dim)] w-4 text-right shrink-0">
              {entrySeed(m, s, seedOf) ?? ''}
            </span>
            <EntryName label={entryName(m, s, nameOf)} size="list" />
            {won && <span className="sr-only">(Winner)</span>}
            {digits && <span className="nums text-xs text-[var(--text-dim)] shrink-0">{digits}</span>}
          </div>
        );
      })}
      {note && (
        <div className="nums px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--text-dim)] border-t border-[var(--border)]">
          {note}
        </div>
      )}
    </div>
  );
}
