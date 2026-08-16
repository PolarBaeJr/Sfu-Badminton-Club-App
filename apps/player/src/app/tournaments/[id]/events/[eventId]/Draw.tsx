import type { ReactNode } from 'react';
import { getRoundName, computeDrawLayout, drawHalves, splitPairLabel } from '@badminton/shared';
import type { DrawSide, DrawLayout } from '@badminton/shared';
import { DrawScroller, type DrawPage } from './DrawScroller';

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
const LINK_W = 24;
const HEAD_H = 26;
const PLAYOFF_CAPTION_H = 64;

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
 * (four rounds, 1320×608) fits both axes at 1.0 with room to spare, and at
 * 1280×720 — the worst projector this feature admits to — it still fits at
 * 0.94. A 32-draw is the first that does not: it needs 0.73 at 720p, below the
 * 0.80 floor, and so is the first that has anything to gain.
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
}

/** A skip match has one real entry and one empty slot; only the empty side is labelled. */
function entryName(m: DrawMatch, side: 'a' | 'b', nameOf: Record<string, string>): string {
  const id = side === 'a' ? m.aId : m.bId;
  if (!id) return m.is_bye ? 'SKIP' : 'TBD';
  return nameOf[id] || 'TBD';
}

function entrySeed(m: DrawMatch, side: 'a' | 'b', seedOf: Record<string, number | null>): number | null {
  const id = side === 'a' ? m.aId : m.bId;
  return id ? seedOf[id] ?? null : null;
}

function isWinner(m: DrawMatch, side: 'a' | 'b'): boolean {
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
  if (m.is_bye) return 'Skip';
  const line = scoreLine(m);
  if (line) return m.status === 'walkover' ? `${line} W/O` : line;
  if (m.status === 'completed' || m.status === 'walkover') return 'W/O';
  if (m.status === 'live') return 'Playing';
  return 'vs';
}

export function Draw({ matches, thirdPlace, nameOf, seedOf, title, subtitle }: DrawProps) {
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

  const pages: DrawPage[] = halves && finalMatch
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
        return {
          key: half,
          label: half === 'top' ? 'Top half' : 'Bottom half',
          width: pageLayout.width,
          height: pageLayout.height,
          note: `The ${half} half of the draw, meeting at its semi-final in the middle. `
            + `The final is repeated on both halves.`,
          body: (
            <ChartBody
              layout={pageLayout}
              half={half}
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
                      heading: '3rd Place Playoff',
                      caption: 'The two beaten semi-finalists, one from each half. '
                        + 'The winner does not advance to the final.',
                    }]
                  : []),
              ]}
            />
          ),
        };
      })
    : [];

  return (
    <>
      {/* THE CHART — tablet and up only. `display: none` below 768px, so on a
          phone it contributes no width at all and the page body cannot be
          pushed sideways by it. */}
      <div className="draw-chart-wrap px-4 pb-4">
        {/* ONE STRING, TWO PLACES. This sits above the shell, so it is outside
            the element that goes full screen and would vanish there; the same
            text is handed to DrawScroller for its full-screen header rather
            than written out twice and left to drift. */}
        <p className="text-xs text-[var(--text-muted)] mb-2">{readingNote}</p>
        {/* The sized, positioned box the absolute offsets below are relative to
            is DrawScroller's innermost one — it owns it because it is the one
            being transformed to fit. Everything here is laid out at full size
            and scaled as a whole. */}
        <DrawScroller
          width={layout.width}
          height={layout.height}
          title={title}
          subtitle={subtitle}
          note={readingNote}
          pages={pages}
        >
          <ChartBody
            layout={layout}
            half={null}
            roundName={roundName}
            nameOf={nameOf}
            seedOf={seedOf}
            extras={thirdPlace && layout.thirdPlace
              ? [{
                  key: 'third',
                  pos: layout.thirdPlace,
                  match: thirdPlace,
                  heading: '3rd Place Playoff',
                  caption: 'The two beaten semi-finalists, one from each half. '
                    + 'The winner does not advance to the final.',
                }]
              : []}
          />
        </DrawScroller>
      </div>

      <DrawRounds
        layout={layout}
        thirdPlace={thirdPlace}
        nameOf={nameOf}
        seedOf={seedOf}
        roundName={roundName}
      />
    </>
  );
}

/**
 * A card that is drawn in the centre column but is NOT part of the tree the
 * layout was built from — the third-place playoff on a whole draw, and on a
 * half page the final as well.
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
 * ONE RENDERER FOR THE WHOLE DRAW AND FOR A HALF OF IT. A half is the same
 * shape — a converging tree with a centre column — so it is the same markup
 * with a different layout, and writing it twice is how the two would come to
 * disagree about a card that had been edited on one of them.
 *
 * `half` IS THE PAGE'S HALF, AND IT OVERRIDES THE NODE'S SIDE FOR LABELLING.
 * On a half page `node.side` is the side of THAT page's own converging chart,
 * which is a quarter of the real draw — so reading the aria-label off it would
 * announce half the cards on the top-half page as being in the bottom half.
 * The draw has no name for a quarter, so a half page says only which half it
 * is, on every card.
 */
function ChartBody({
  layout, half, roundName, nameOf, seedOf, extras,
}: {
  layout: DrawLayout<DrawMatch>;
  half: 'top' | 'bottom' | null;
  roundName: (roundNumber: number) => string;
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
  extras: CentreExtra[];
}) {
  const roundLabel = (roundNumber: number, side: DrawSide) => {
    if (half) return `${roundName(roundNumber)}, ${half} half`;
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
        {layout.connectors.map((c) => (
          <span
            key={c.key}
            className="absolute bg-[var(--border)]"
            style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
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
  layout, thirdPlace, nameOf, seedOf, roundName,
}: {
  layout: ReturnType<typeof computeDrawLayout<DrawMatch>>;
  thirdPlace: DrawMatch | null;
  nameOf: Record<string, string>;
  seedOf: Record<string, number | null>;
  roundName: (roundNumber: number) => string;
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
    <div className="draw-rounds px-4 pb-4 space-y-2">
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
  const note = m.is_bye ? 'Skip - auto-advance'
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
