'use client';

import { useEffect, useRef, useState } from 'react';
import { getRoundName, eventIsPlaying, computeDrawLayout, fitScale } from '@badminton/shared';
import type { DrawSide } from '@badminton/shared';
import { ScoreEntryDialog } from './ScoreEntryDialog';
import { RoundShapeControl } from './RoundShapeControl';
import { Trophy } from 'lucide-react';
import { getName } from './entry-name';
import type {
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
  GameScore,
} from '@/lib/tournament-types';

/**
 * THE CONSOLE'S HALF OF THE CONVERGING DRAW.
 *
 * Where every offset comes from is `computeDrawLayout` in @badminton/shared —
 * the same function the player app's chart is built on, so the two diagrams
 * cannot drift the way the two hand-maintained copies of this geometry did
 * (92px cards here, 100px there). This file owns the SIZES it draws at and the
 * markup; it owns no arithmetic.
 *
 * The sizes are picked from the bottom up: 88px is 44px at the 0.5 zoom floor,
 * and the whole card is the button, so the smallest tap target this tab will
 * open at is exactly the minimum.
 */
const META_H = 18;                // card meta strip (match number / court)
const SIDE_H = 23;                // one entrant's row
const FOOT_H = 24;                // card footer strip (status / action)
const CARD_H = META_H + SIDE_H * 2 + FOOT_H;   // 88
const CARD_GAP = 12;              // gap between sibling cards in the first round
const COL_W = 196;                // width of a round column
const LINK_W = 28;                // width of the connector gutter between rounds
const HEAD_H = 30;                // round heading strip above the diagram
// Heading + the explanatory sentence under the playoff card, measured for the
// sentence WRAPPING at COL_W rather than for one line: this number only feeds
// the diagram's height, and being short by a line clips the caption.
const PLAYOFF_CAPTION_H = 76;

const GEOMETRY = {
  cardH: CARD_H,
  cardGap: CARD_GAP,
  colW: COL_W,
  linkW: LINK_W,
  headH: HEAD_H,
  playoffCaptionH: PLAYOFF_CAPTION_H,
};

/** Zoom stops. 1 is always reachable so "actual size" exists. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1;
/** Below this, a card is too small to press. Bounds the DEFAULT only. */
const ZOOM_USABLE_FLOOR = 0.5;
/**
 * The share of the window the diagram may claim before it scrolls inside its
 * own box. Used for the fit arithmetic as well as for the cap, so the scale
 * that "Fit" reports is the scale that actually fits.
 */
const VIEWPORT_H_SHARE = 0.78;

interface Props {
  event: TournamentEventRow;
  matches: TournamentMatchRow[];
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /**
   * 'bracket' when this is the knockout half of a pool_to_bracket event, null
   * on a single_elimination event whose matches carry no phase (00107).
   */
  phase?: 'bracket' | null;
}

/**
 * Zoom controls. Its own component so the bracket body below stays readable,
 * and so the buttons keep working while the diagram is transformed — a scaled
 * button is a smaller hit target, and these must not shrink with the bracket.
 */
function ZoomBar({
  zoom, onZoom, fitBoth, fitWidth,
}: { zoom: number; onZoom: (z: number) => void; fitBoth: number; fitWidth: number }) {
  const step = (delta: number) =>
    onZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + delta) * 20) / 20)));

  // Nothing to zoom: the diagram already fits AND is being shown at full size.
  // Showing a dead control on every eight-player event is noise.
  //
  // The second half of that condition is load-bearing. Gated on the fit alone,
  // someone who zoomed out on a narrow window and then widened it past the point
  // where the draw fits lost the controls while the bracket was still scaled —
  // a shrunken diagram with no way back to 100%.
  if (fitBoth >= 1 && zoom >= 1) return null;

  const btn =
    'px-2 py-1 border border-[var(--border)] text-[11px] uppercase tracking-[0.08em] ' +
    'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ' +
    'disabled:opacity-40 disabled:hover:text-[var(--text-muted)]';

  return (
    <div className="flex items-center justify-end gap-2 mb-3">
      <button type="button" className={btn} onClick={() => step(-0.1)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
      <span className="text-[11px] font-mono text-[var(--text-muted)] w-10 text-center" aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
      <button type="button" className={btn} onClick={() => step(0.1)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
      {/* WHOLE DRAW, not just its width, and that is the control this tab was
          missing. A converging chart is short and wide; fitting the width alone
          reports a comfortable number and still leaves the reader scrolling —
          which is what "unreadable above 32" was. "Fit width" stays for the big
          draws where the whole-draw scale is too small to read at all. */}
      <button type="button" className={btn} onClick={() => onZoom(fitBoth)}>Fit</button>
      <button type="button" className={btn} onClick={() => onZoom(fitWidth)}>Fit width</button>
      <button type="button" className={btn} onClick={() => onZoom(1)}>100%</button>
    </div>
  );
}

export function BracketTab({ event, matches, participants, pairs, isDoubles, phase = null }: Props) {
  const [scoreMatch, setScoreMatch] = useState<TournamentMatchRow | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // null means "the user has not touched the controls", which is what lets the
  // default track the window while a deliberate 100% survives a resize.
  const [userZoom, setUserZoom] = useState<number | null>(null);

  // Measured rather than assumed: the page is full-width on this route, so the
  // available space depends on the window, the sidebar and the scrollbar, and
  // any figure hard-coded here would be wrong on somebody's screen. The HEIGHT
  // is taken from the window rather than from the box, because the box's own
  // height is content-driven until the cap bites — measuring it would fit the
  // diagram to whatever height the diagram already had.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      setViewportW(el.clientWidth);
      setViewportH(Math.max(320, Math.round(window.innerHeight * VIEWPORT_H_SHARE)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // The third-place playoff shares round_number with the final so the two are
  // scheduled together, but it is held OUT of the tree on purpose: as a real
  // sibling of the final it is a round of two feeding a round of one — the
  // exact shape of "these two matches feed that one" — and every elbow in the
  // semi-finals would be drawn from that false premise. It is placed by the
  // layout engine instead, in the clear space under the final.
  const thirdPlace = matches.find((m) => m.is_third_place) ?? null;
  const treeMatches = matches.filter((m) => !m.is_third_place);
  // eventIsPlaying rather than `=== 'live'` (00107). It reads the same on a
  // single_elimination event; on a pool_to_bracket one it is what keeps the
  // knockout scoreable at `live` while the pool tab stays scoreable at
  // `pool_live`.
  const isLive = eventIsPlaying(event.status) || event.status === 'bracket_generated';

  const layout = computeDrawLayout(treeMatches, GEOMETRY, { thirdPlace: !!thirdPlace });

  // Build name lookup
  const nameMap: Record<string, string> = {};
  if (isDoubles) {
    for (const p of pairs) nameMap[p.id] = getName(p, isDoubles);
  } else {
    for (const p of participants) nameMap[p.id] = getName(p, isDoubles);
  }

  // Seed lookup
  const seedMap: Record<string, number> = {};
  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;

  // Candidates the slot editor may place into an orphaned bracket position.
  // Withdrawn and disqualified entries are excluded here and refused again
  // server-side — the client list is a convenience, not the rule.
  const placeableEntries = entries
    .filter((e) => e.status !== 'withdrawn' && e.status !== 'disqualified')
    .map((e) => ({ id: e.id, name: nameMap[e.id] ?? 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const p of entries) {
    if (p.seed_number) seedMap[p.id] = p.seed_number;
  }

  function getEntryName(id: string | null) {
    if (!id) return 'TBD';
    return nameMap[id] ?? 'TBD';
  }

  function getSeed(id: string | null) {
    if (!id) return null;
    return seedMap[id] ?? null;
  }

  if (treeMatches.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
        <Trophy className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
        <p className="text-sm text-[var(--text-muted)]">Bracket not generated yet.</p>
      </div>
    );
  }

  // The "played to" strip names each round ONCE, even though a converging draw
  // heads most of them twice — the shape is a property of the round, not of the
  // half, and two identical selects side by side would invite somebody to set
  // them differently.
  // THE HIGHEST round_number, not the COUNT of rounds. getRoundName counts back
  // from the final — `totalRounds - roundNumber + 1` — so the two arguments have
  // to be in the same numbering. Handed a count, a draw whose rounds are not
  // numbered 1..R goes negative and prints "Round of 0.0078125". Only the
  // fallback is affected, since the generator stamps round_name on every row,
  // which is exactly why it would have gone unnoticed.
  const lastRoundNumber = treeMatches.reduce((max, m) => Math.max(max, m.round_number), 0);

  const roundsInOrder: Array<{ roundNumber: number; matches: TournamentMatchRow[]; name: string }> = [];
  for (const col of layout.columns) {
    if (roundsInOrder.some((r) => r.roundNumber === col.roundNumber)) continue;
    const roundMatches = treeMatches.filter((m) => m.round_number === col.roundNumber);
    roundsInOrder.push({
      roundNumber: col.roundNumber,
      matches: roundMatches,
      name: roundMatches[0]?.round_name ?? getRoundName(col.roundNumber, lastRoundNumber),
    });
  }
  roundsInOrder.sort((a, b) => a.roundNumber - b.roundNumber);

  const fitBoth = fitScale(layout, viewportW, viewportH, ZOOM_MIN);
  const fitWidth = viewportW > 0 && layout.width > 0
    ? Math.min(1, Math.max(ZOOM_MIN, viewportW / layout.width))
    : 1;

  // THE WHOLE DRAW, BUT NEVER SMALLER THAN THE FLOOR. A 128-slot draw fitted
  // whole to this pane lands near 25%, which turns an 88px card into a 22px one
  // — the bracket is on screen and none of it can be read or pressed. So the
  // default is clamped UP to the floor rather than abandoned: at 0.5 the card is
  // exactly 44px, the minimum tap target, and the reader still sees most of the
  // chart's width instead of the left quarter of it.
  //
  // Measured on a 1192px pane: a 32-draw opens whole at 60%, a 64-draw at the
  // 50% floor showing 98% of its width, a 128-draw at 50% showing 83%. The old
  // fallback — open at 100% and scroll — put a 64-draw's reader back where the
  // complaint started, looking at a quarter of the sheet.
  const zoom = userZoom ?? Math.min(1, Math.max(fitBoth, ZOOM_USABLE_FLOOR));

  const roundNameOf = (roundNumber: number) =>
    roundsInOrder.find((r) => r.roundNumber === roundNumber)?.name
    ?? getRoundName(roundNumber, lastRoundNumber);

  // WHICH HALF, spoken. Sighted readers get the half from where the card is on
  // the sheet; a screen reader gets nothing from that, and in a converging draw
  // "Semi-Final" on its own is now ambiguous between two cards.
  const roundLabelOf = (roundNumber: number, side: DrawSide) => {
    const name = roundNameOf(roundNumber);
    return side === 'centre' ? name : `${name}, ${side === 'left' ? 'top' : 'bottom'} half`;
  };

  return (
    <>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4" role="region" aria-label="Tournament bracket">
        {/* WHAT EACH ROUND IS PLAYED TO (00108), in a strip above the diagram
            rather than on the round headings themselves. The headings sit
            inside the CSS transform that zooms the bracket, so a select there
            would shrink with it — at "fit" on a 32-draw it would be a
            four-pixel control. Here it is always full size, always in one
            place, and reads as the ladder it is: 11s, 15s, 21s, best of 3. */}
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Played to
          </span>
          {roundsInOrder.map((round) => (
            <span key={round.roundNumber} className="flex items-center gap-1.5">
              <span className="text-[11px] text-[var(--text-secondary)]">{round.name}</span>
              <RoundShapeControl
                event={event}
                matches={round.matches}
                phase={phase}
                roundNumber={round.roundNumber}
              />
            </span>
          ))}
          {thirdPlace && (
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] text-[var(--text-secondary)]">3rd Place</span>
              <RoundShapeControl
                event={event}
                matches={[thirdPlace]}
                phase={phase}
                roundNumber={null}
                thirdPlace
              />
            </span>
          )}
        </div>

        {/* THE DRAW READS INWARDS FROM BOTH EDGES, which is not how anybody
            expects a bracket to read until they are told once. */}
        <p className="mb-3 text-[11px] text-[var(--text-muted)]">
          {layout.mode === 'converging'
            ? 'The top half runs inwards from the left, the bottom half inwards from the right, and they meet at the final in the middle.'
            : 'This draw’s rounds do not halve, so it is shown as a plain left-to-right ladder.'}
        </p>

        <ZoomBar zoom={zoom} onZoom={setUserZoom} fitBoth={fitBoth} fitWidth={fitWidth} />

        {/* Two nested boxes because a CSS transform does not change layout size:
            the scaled diagram would still reserve its FULL width and height, so
            a zoomed-out bracket left a screen of blank card behind it and the
            scrollbars never shrank. The outer box scrolls, the middle box is
            sized to the SCALED dimensions, and only the inner one is
            transformed.

            The height cap is unconditional and costs a short draw nothing: a
            max-height only bites once the content exceeds it, so an eight-player
            bracket still flows with the page and grows no inner scrollbar. */}
        <div
          ref={viewportRef}
          className="overflow-auto"
          style={{ maxHeight: `${Math.round(VIEWPORT_H_SHARE * 100)}vh` }}
        >
          <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div
              className="relative"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
            >
              {/* Round headings. One per column, so a converging draw names
                  each round over both of its halves. */}
              {layout.columns.map((col) => (
                <div
                  key={col.key}
                  className="absolute flex items-center justify-center"
                  style={{ left: col.x, top: 0, width: COL_W, height: HEAD_H }}
                >
                  <h3
                    className={`text-[11px] font-bold uppercase tracking-[0.12em] ${
                      col.side === 'centre' ? 'text-[var(--color-warning)]' : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {roundsInOrder.find((r) => r.roundNumber === col.roundNumber)?.name
                      ?? getRoundName(col.roundNumber, lastRoundNumber)}
                  </h3>
                </div>
              ))}

              {/* The connector work, as flat boxes the engine positioned. */}
              <div className="absolute inset-x-0" style={{ top: HEAD_H, height: layout.bodyH }} aria-hidden="true">
                {layout.connectors.map((c) => (
                  <span
                    key={c.key}
                    className="absolute bg-[var(--border-hover)]"
                    style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
                  />
                ))}
              </div>

              <div className="absolute inset-x-0" style={{ top: HEAD_H, height: layout.bodyH }}>
                {layout.nodes.map((node) => (
                  <div
                    key={node.id}
                    className="absolute"
                    style={{ left: node.x, top: node.y, width: COL_W }}
                  >
                    <MatchCard
                      m={node.match}
                      side={node.side}
                      roundLabel={roundLabelOf(node.roundNumber, node.side)}
                      isDoubles={isDoubles}
                      isLive={isLive}
                      getEntryName={getEntryName}
                      getSeed={getSeed}
                      onEnterScore={() => setScoreMatch(node.match)}
                    />
                  </div>
                ))}

                {/* THE 3RD PLACE PLAYOFF, in the clear space under the final.
                    The centre column carries one card, so a converging draw has
                    a whole column of room exactly where the reader is already
                    looking — and it is the other match that ends somebody's
                    tournament, decided on the same day.

                    NO LINE TOUCHES IT, and that is a change from the linear
                    draw, which reached a dashed elbow back to the semi-finals.
                    In a converging draw the two beaten semi-finalists are on
                    OPPOSITE sides of the final, so there is no single path back
                    to draw and any line long enough to reach one of them has to
                    cross the final — which would say something about the final.
                    The caption does the work instead, and now has to, since a
                    reader can no longer infer "leads nowhere" from a line that
                    is not there. */}
                {thirdPlace && layout.thirdPlace && (
                  <div
                    className="absolute"
                    style={{ left: layout.thirdPlace.x, top: layout.thirdPlace.y, width: COL_W }}
                  >
                    <MatchCard
                      m={thirdPlace}
                      side="centre"
                      roundLabel="3rd Place Playoff"
                      isDoubles={isDoubles}
                      isLive={isLive}
                      getEntryName={getEntryName}
                      getSeed={getSeed}
                      onEnterScore={() => setScoreMatch(thirdPlace)}
                    />
                    <h3 className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                      3rd Place Playoff
                    </h3>
                    <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                      The two beaten semi-finalists, one from each half. Decides 3rd and 4th — the
                      winner does not advance to the final.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          entries={placeableEntries}
          onClose={() => setScoreMatch(null)}
        />
      )}
    </>
  );
}

interface CardProps {
  m: TournamentMatchRow;
  side: DrawSide;
  roundLabel: string;
  isDoubles: boolean;
  isLive: boolean;
  getEntryName: (id: string | null) => string;
  getSeed: (id: string | null) => number | null;
  onEnterScore: () => void;
}

function MatchCard({ m, side, roundLabel, isDoubles, isLive, getEntryName, getSeed, onEnterScore }: CardProps) {
  const aId = isDoubles ? m.pair_a_id : m.participant_a_id;
  const bId = isDoubles ? m.pair_b_id : m.participant_b_id;
  const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
  const isCompleted = m.status === 'completed' || m.status === 'walkover';
  const isSkip = m.is_bye;
  const isReady = m.status === 'ready' && aId && bId;
  const canEnterScore =
    isLive && (isReady || m.status === 'live' || m.status === 'pending') && aId && bId && !isCompleted && !isSkip;
  // A voided match, or one missing a side, used to render with NO action at all
  // — which is exactly how a bracket got stuck on TBD forever. Both now open the
  // dialog, on its restore or slot-editing panel.
  const isVoided = m.status === 'voided';
  const canRecover = isLive && !isCompleted && !isSkip && !canEnterScore;
  // ...and a match that already HAS a result used to render with no action
  // either, which is what made editMatchResult unreachable: the only way to fix
  // a wrong scoreline was to void it, restore it and type it again. A decided
  // match now opens the dialog on its correction panel.
  //
  // A skip is excluded. It is "completed" with a winner the generator placed
  // there, and it has no scoreline to correct — the slot editor on the next
  // round is the tool for a wrong bye.
  //
  // Not gated on isLive: an event flips to 'completed' the moment it is
  // finalised, and finalising is when a wrong result gets noticed. The server
  // allows a correction on a live OR completed event, so gating the button on
  // isLive would hide the affordance exactly where it is wanted.
  const canChangeResult = isCompleted && !isSkip;

  // THE WHOLE CARD IS THE BUTTON, where it used to be the 26px footer strip.
  // All four of those states already opened the same dialog, so the split
  // bought nothing and cost the tab its tap target: 26px was under the 44px
  // minimum at 100%, never mind at the scale a 32-draw opens at. An 88px card
  // is still 44px at the 0.5 zoom floor, which is why 88 is the number.
  const actionable = !!(canEnterScore || canRecover || canChangeResult);
  const actionLabel =
    canEnterScore ? 'Enter Score'
    : canRecover ? (isVoided ? 'Restore Match' : 'Fix Slots')
    : null;

  const scores = m.scores as GameScore[] | null;
  // Either side can be the empty one — the generator gives the skip to whichever
  // slot the seed landed in, not always slot B.
  const sideLabel = (id: string | null) => (isSkip && !id ? 'skip' : getEntryName(id));
  const label = `${roundLabel}. Match ${m.match_number ?? ''}: ${sideLabel(aId)} vs ${sideLabel(bId)}${
    isCompleted ? `, winner: ${getEntryName(winnerId)}` : ''
  }${actionable ? `. ${actionLabel ?? 'Change the recorded result'}` : ''}`;

  // ONE GAME'S DIGITS PER SIDE, not the whole scoreline twice. A best-of-3 read
  // from A's point of view is "21-19 15-21 21-18" — seventeen mono characters
  // next to a doubles pair's name, which did not fit in the old 244px column
  // and certainly does not fit in this one. Split down the middle it is "21 15
  // 21" over "19 21 18", which is the same information in half the width and is
  // how a printed draw sheet has always shown it.
  const scoreFor = (which: 'a' | 'b') =>
    scores?.map((g) => (which === 'a' ? g.a : g.b)).join(' ') ?? null;

  const body = (
    <>
      <div
        className={`flex items-center justify-between px-2 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-elevated)] border-b border-[var(--border)] shrink-0 ${
          side === 'right' ? 'flex-row-reverse' : ''
        }`}
        style={{ height: META_H }}
      >
        <span>{m.match_number ? `M${m.match_number}` : ''}</span>
        <span>{m.court ? `Court ${m.court}` : ''}</span>
      </div>

      <Side
        name={isSkip && !aId ? 'SKIP' : getEntryName(aId)}
        seed={getSeed(aId)}
        isPlaceholder={!aId}
        won={isCompleted && winnerId === aId}
        // An empty slot has no result to strike through — a skip match is
        // "completed" with a winner, so without the id guard SKIP renders struck.
        lost={isCompleted && !!winnerId && !!aId && winnerId !== aId}
        score={scoreFor('a')}
        mirrored={side === 'right'}
      />
      <div className="border-t border-[var(--border)]" />
      <Side
        name={isSkip && !bId ? 'SKIP' : getEntryName(bId)}
        seed={getSeed(bId)}
        isPlaceholder={!bId}
        won={isCompleted && winnerId === bId}
        lost={isCompleted && !!winnerId && !!bId && winnerId !== bId}
        score={scoreFor('b')}
        mirrored={side === 'right'}
      />

      <div
        className={`shrink-0 border-t border-[var(--border)] flex items-center justify-center gap-2 bg-[var(--bg-elevated)] ${
          canEnterScore ? 'text-[var(--color-accent)]' : canRecover ? 'text-[var(--color-warning)]' : ''
        }`}
        style={{ height: FOOT_H }}
      >
        {actionLabel ? (
          <span className="text-xs font-medium">{actionLabel}</span>
        ) : (
          <>
            {/* The status stays visible on a settled match. This is a decided
                result, and the card must not read as though the score is still
                being entered — "Change" is the secondary thing on the row. */}
            <StatusLabel status={m.status} isSkip={!!isSkip} />
            {canChangeResult && <span className="text-[10px] text-[var(--text-muted)]">· Change</span>}
          </>
        )}
      </div>
    </>
  );

  const shell =
    `w-full flex flex-col border overflow-hidden transition-colors text-left ${
      isReady && isLive
        ? 'border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] shadow-[0_0_0_1px_rgba(204,0,0,0.18)]'
        : isSkip
        ? 'border-dashed border-[var(--border)] opacity-60'
        : 'border-[var(--border)]'
    }`;

  if (!actionable) {
    return (
      <div role="group" aria-label={label} style={{ height: CARD_H }} className={shell}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onEnterScore}
      aria-label={label}
      style={{ height: CARD_H }}
      className={`${shell} hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`}
    >
      {body}
    </button>
  );
}

function Side({
  name,
  seed,
  isPlaceholder,
  won,
  lost,
  score,
  mirrored,
}: {
  name: string;
  seed: number | null;
  isPlaceholder: boolean;
  won: boolean;
  lost: boolean;
  score: string | null;
  /**
   * The bottom half of a converging draw runs right to left, so its cards are
   * mirrored: the seed and the score sit on the OUTSIDE edge and the name reads
   * inwards, towards the final. Without this the two halves read as one long
   * chart with a gap in it rather than as two pointing at each other.
   */
  mirrored: boolean;
}) {
  return (
    <div
      className={`flex-1 min-h-0 flex items-center gap-1.5 px-2 text-[13px] ${
        mirrored ? 'flex-row-reverse text-right' : ''
      } ${
        // Inset bar rather than a real border so the winner's name stays on the
        // same baseline as the loser's. The wash is spelled out as color-mix
        // because Tailwind 3 silently drops `/10` on an arbitrary var() colour.
        won
          ? mirrored
            ? 'bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] shadow-[inset_-2px_0_0_var(--color-success)]'
            : 'bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] shadow-[inset_2px_0_0_var(--color-success)]'
          : 'bg-[var(--bg-card)]'
      }`}
    >
      <span className={`w-4 shrink-0 font-mono text-[10px] text-[var(--text-muted)] ${mirrored ? 'text-left' : 'text-right'}`}>
        {seed ? seed : ''}
      </span>
      <span
        className={`flex-1 min-w-0 truncate ${
          won
            ? 'text-[var(--color-success)] font-semibold'
            : lost
            ? 'text-[var(--text-muted)] line-through'
            : isPlaceholder
            ? 'text-[var(--text-muted)] italic'
            : 'text-[var(--text-secondary)]'
        }`}
      >
        {name}
      </span>
      {won && <span className="sr-only">(Winner)</span>}
      {score && <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{score}</span>}
    </div>
  );
}

function StatusLabel({ status, isSkip }: { status: string; isSkip: boolean }) {
  if (status === 'walkover') {
    return <span className="text-[10px] font-medium text-[var(--color-warning)]" role="status">⚠ WALKOVER</span>;
  }
  if (status === 'voided') {
    return <span className="text-[10px] font-medium text-[var(--color-danger)]" role="status">✕ VOIDED</span>;
  }
  if (isSkip) {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Skip · auto-advance</span>;
  }
  if (status === 'completed') {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-success)]">Final</span>;
  }
  if (status === 'live') {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-accent)]" role="status">In progress</span>;
  }
  if (status === 'ready') {
    return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">Ready</span>;
  }
  return <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Pending</span>;
}
