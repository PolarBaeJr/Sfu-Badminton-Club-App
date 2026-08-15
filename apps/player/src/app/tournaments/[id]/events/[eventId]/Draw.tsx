import { getRoundName, computeDrawLayout } from '@badminton/shared';
import type { DrawSide } from '@badminton/shared';
import { DrawScroller } from './DrawScroller';

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

export function Draw({ matches, thirdPlace, nameOf, seedOf }: DrawProps) {
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
  const roundLabel = (roundNumber: number, side: DrawSide) =>
    side === 'centre'
      ? roundName(roundNumber)
      : `${roundName(roundNumber)}, ${side === 'left' ? 'top' : 'bottom'} half`;

  return (
    <>
      {/* THE CHART — tablet and up only. `display: none` below 768px, so on a
          phone it contributes no width at all and the page body cannot be
          pushed sideways by it. */}
      <div className="draw-chart-wrap px-4 pb-4">
        <p className="text-xs text-[var(--text-muted)] mb-2">
          {layout.mode === 'converging'
            ? 'The top half runs inwards from the left, the bottom half from the right, and they meet at the final in the middle.'
            : 'This draw’s rounds do not halve, so it is shown as a plain left-to-right ladder.'}
        </p>
        <DrawScroller>
          <div
            className="relative"
            style={{ width: layout.width, height: layout.height }}
          >
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

              {/* THE 3RD PLACE PLAYOFF, in the clear space under the final. The
                  centre column holds one card, so a converging draw has a whole
                  column of room right where the reader is already looking.

                  Nothing is drawn joining it to anything: its two entrants are
                  the beaten semi-finalists, who in a converging draw sit on
                  OPPOSITE sides of the final, so there is no single line back to
                  them that would not cross the final and say something about it.
                  The caption carries it instead. */}
              {thirdPlace && layout.thirdPlace && (
                <div
                  className="absolute"
                  style={{ left: layout.thirdPlace.x, top: layout.thirdPlace.y, width: COL_W }}
                >
                  <ChartCard
                    m={thirdPlace}
                    side="centre"
                    roundLabel="3rd Place Playoff"
                    nameOf={nameOf}
                    seedOf={seedOf}
                  />
                  <h3 className="eyebrow mt-2">3rd Place Playoff</h3>
                  <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                    The two beaten semi-finalists, one from each half. The winner does not advance
                    to the final.
                  </p>
                </div>
              )}
            </div>
          </div>
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
            <span className="truncate flex-1 min-w-0">{entryName(m, s, nameOf)}</span>
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

  return (
    <div className="draw-rounds px-4 pb-4 space-y-4">
      {rounds.map((r) => (
        <div key={r.roundNumber}>
          <h3 className="eyebrow mb-2">{roundName(r.roundNumber)}</h3>
          <div className="space-y-1.5">
            {r.nodes.map((node) => (
              <ListRow key={node.id} m={node.match} nameOf={nameOf} seedOf={seedOf} />
            ))}
          </div>
        </div>
      ))}
      {thirdPlace && (
        <div>
          <h3 className="eyebrow mb-2">3rd Place Playoff</h3>
          <div className="space-y-1.5">
            <ListRow m={thirdPlace} nameOf={nameOf} seedOf={seedOf} />
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            The two beaten semi-finalists. The winner does not advance to the final.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * ONE MATCH ON A PHONE: the two entrants STACKED, each with its own games down
 * the right, not side by side across the row.
 *
 * Side by side was measured at 390px and does not work. The row is 358px wide;
 * a best-of-3 printed once in the middle ("21-19, 15-21, 21-18") is 100px of
 * it, which leaves 129px a side and truncates "Jonathan Smithson" to
 * "Jonathan..." on both entrants at once. Stacked, each name gets 287px — forty
 * characters — and the digits read down a column the way a scorecard does.
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
            <span className="truncate flex-1 min-w-0">{entryName(m, s, nameOf)}</span>
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
