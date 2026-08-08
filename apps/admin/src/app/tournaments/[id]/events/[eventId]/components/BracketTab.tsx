'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { getRoundName } from '@badminton/shared';
import { ScoreEntryDialog } from './ScoreEntryDialog';
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
 * Bracket geometry — the single source of truth for every offset on this page.
 * Connectors are absolutely positioned from these numbers, so a card that grows
 * or a gap that changes only needs an edit here; nothing else is hand-tuned.
 * CARD_H is enforced on every card (see MatchCard) because the elbow maths only
 * holds while all cards in a column are the same height — a shorter skip card
 * or a taller "Enter Score" card is what throws the lines off centre.
 */
const CARD_H = 100;               // fixed outer height of one match card
const CARD_GAP = 16;              // gap between sibling cards in the first round
const PITCH = CARD_H + CARD_GAP;  // centre-to-centre distance in the first round
const COL_W = 244;                // width of a round column
const LINK_W = 40;                // width of the connector gutter between rounds
const HEAD_H = 34;                // round heading block; keeps gutters in step
const META_H = 20;                // card meta strip (match number / court)
const FOOT_H = 26;                // card footer strip (status / score button)
const PLAYOFF_CAPTION_H = 46;     // heading + explanatory line under the playoff card

/** Zoom stops, smallest first. 1 is always in the list so "actual size" exists. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1;
/** Below this, a card's action strip is too small to press. Bounds the DEFAULT only. */
const ZOOM_USABLE_FLOOR = 0.5;

/** Vertical centre of match `idx` in the round at 0-based depth `depth`. */
function cardCentre(depth: number, idx: number) {
  const mult = Math.pow(2, depth);
  const padTop = ((mult - 1) * PITCH) / 2;
  return padTop + idx * mult * PITCH + CARD_H / 2;
}

interface Props {
  event: TournamentEventRow;
  matches: TournamentMatchRow[];
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
}

/**
 * Zoom controls. Its own component so the bracket body below stays readable,
 * and so the buttons keep working while the diagram is transformed — a scaled
 * button is a smaller hit target, and these must not shrink with the bracket.
 */
function ZoomBar({
  zoom, onZoom, fitZoom,
}: { zoom: number; onZoom: (z: number) => void; fitZoom: number }) {
  const step = (delta: number) =>
    onZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + delta) * 20) / 20)));

  // Nothing to zoom: the diagram already fits. Showing a disabled control on
  // every eight-player event is noise.
  if (fitZoom >= 1) return null;

  const btn =
    'px-2 py-1 rounded-md border border-[var(--border)] text-[11px] uppercase tracking-[0.08em] ' +
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
      <button type="button" className={btn} onClick={() => onZoom(fitZoom)}>Fit width</button>
      <button type="button" className={btn} onClick={() => onZoom(1)}>100%</button>
    </div>
  );
}

export function BracketTab({ event, matches, participants, pairs, isDoubles }: Props) {
  const [scoreMatch, setScoreMatch] = useState<TournamentMatchRow | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(0);
  // null means "the user has not touched the controls", which is what lets the
  // default track the window while a deliberate 100% survives a resize.
  const [userZoom, setUserZoom] = useState<number | null>(null);

  // Measured rather than assumed: the page is full-width on this route, so the
  // available space depends on the window, the sidebar and the scrollbar, and
  // any figure hard-coded here would be wrong on somebody's screen.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The third-place playoff shares round_number with the final so the two are
  // scheduled together, but it is held OUT of `columns` on purpose.
  //
  // Put in the final's column as a real sibling, the connector maths would see a
  // round with two cards feeding a round with one — the exact shape of "these
  // two matches feed that one". `canLink` would refuse to draw the elbows
  // (2 !== 1 * 2), so the SEMI-FINALS would silently lose their connectors too,
  // and the playoff would still look like a second final. So it stays out of the
  // column data and is drawn by hand below the semi-finals instead (see
  // `isSemiRound`), hanging off a dashed line: near enough to read as part of
  // the bracket, drawn differently enough to read as a branch rather than the
  // path to the title.
  const thirdPlace = matches.find((m) => m.is_third_place) ?? null;
  const allMatches = matches.filter((m) => !m.is_third_place);
  const isLive = event.status === 'live' || event.status === 'bracket_generated';

  if (allMatches.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
        <Trophy className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
        <p className="text-sm text-[var(--text-muted)]">Bracket not generated yet.</p>
      </div>
    );
  }

  // Group matches by round
  const rounds: Record<number, TournamentMatchRow[]> = {};
  for (const m of allMatches) {
    if (!rounds[m.round_number]) rounds[m.round_number] = [];
    rounds[m.round_number]!.push(m);
  }
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  const totalRounds = Math.max(...roundNumbers);

  const columns = roundNumbers.map((roundNum) => ({
    roundNum,
    matches: rounds[roundNum]!.slice().sort((a, b) => a.bracket_position - b.bracket_position),
  }));

  // Every column is padded to the same height, so the bracket sits in one tidy
  // block and the connector gutters share the first round's coordinate space.
  const firstRoundCount = columns[0]?.matches.length ?? 1;
  const bracketH = (firstRoundCount - 1) * PITCH + CARD_H;

  // Build name lookup
  const nameMap: Record<string, string> = {};
  if (isDoubles) {
    for (const p of pairs) {
      nameMap[p.id] = getName(p, isDoubles);
    }
  } else {
    for (const p of participants) {
      nameMap[p.id] = getName(p, isDoubles);
    }
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

  // Natural size of the diagram, from the same constants the connectors use.
  // The playoff block hangs off the bottom of the semi-final column, so it adds
  // to the height without adding a column.
  const naturalW = columns.length * COL_W + Math.max(columns.length - 1, 0) * LINK_W;
  const naturalH = HEAD_H + bracketH + (thirdPlace && columns.length >= 2 ? CARD_H + PLAYOFF_CAPTION_H : 0);

  // Never magnify: a four-player draw blown up to fill a monitor looks broken,
  // and the point of this control is only to bring a big draw back into view.
  const fitZoom = viewportW > 0 ? Math.min(1, Math.max(ZOOM_MIN, viewportW / naturalW)) : 1;

  // The DEFAULT will not go below half size, even though the control will. A
  // 128-slot draw fitted to a phone lands at 25%, which turns the 26px "Enter
  // Score" strip into a 6px target — the bracket is on screen and none of it can
  // be used. Below the floor, open at the scale the cards were designed for and
  // let the reader scroll, which is what the page did before this control
  // existed. Fit width is still one press away.
  const zoom = userZoom ?? (fitZoom < ZOOM_USABLE_FLOOR ? 1 : fitZoom);

  return (
    <>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4" role="region" aria-label="Tournament bracket">
        <ZoomBar zoom={zoom} onZoom={setUserZoom} fitZoom={fitZoom} />
        {/* Two nested boxes because a CSS transform does not change layout size:
            the scaled diagram would still reserve its FULL width and height, so
            a zoomed-out bracket left a screen of blank card behind it and the
            scrollbars never shrank. The outer box scrolls, the middle box is
            sized to the SCALED dimensions, and only the inner one is
            transformed. */}
        {/* The height cap is only for draws that needed zooming out in the first
            place. Applying it unconditionally would put an inner scrollbar on an
            eight-player bracket that used to flow with the page, and cost the
            reader the event header while they scrolled. */}
        <div
          ref={viewportRef}
          className="overflow-auto"
          style={fitZoom < 1 ? { maxHeight: '78vh' } : undefined}
        >
          <div style={{ width: naturalW * zoom, height: naturalH * zoom }}>
            <div
              className="flex items-start"
              role="table"
              aria-label="Bracket rounds"
              style={{ width: naturalW, transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            >
          {columns.map((col, depth) => {
            const roundMatches = col.matches;
            const roundName = roundMatches[0]?.round_name ?? getRoundName(col.roundNum, totalRounds);
            const isFinal = col.roundNum === totalRounds;

            const mult = Math.pow(2, depth);
            const padY = ((mult - 1) * PITCH) / 2;
            const gap = mult * PITCH - CARD_H;

            const next = columns[depth + 1];
            // The playoff hangs under the round that FEEDS it — the semi-finals,
            // i.e. the column immediately before the final. Guarded on there
            // actually being one: a two-entry event has a final and nothing
            // else, and there is nothing to hang it from.
            const isSemiRound = !!thirdPlace && columns.length >= 2 && depth === columns.length - 2;
            // The dashed drop starts at the bottom edge of the last semi-final
            // card and ends where the playoff card begins, which is the foot of
            // the column body. Derived, not tuned: change PITCH or CARD_H and
            // the line still lands on both.
            const lastCardBottom = cardCentre(depth, roundMatches.length - 1) + CARD_H / 2;
            // How much empty column there already is under the last semi-final.
            // In a FOUR-entry draw the semi-finals are the first round, so the
            // last card ends exactly at the foot of the column and this is zero
            // — a riser drawn upward from there would be painted straight
            // through that card's footer. Whatever is missing is added as real
            // space below instead, so the line always has somewhere to live.
            const slack = Math.max(bracketH - lastCardBottom, 0);
            const riserH = Math.max(slack, CARD_GAP);
            const extraGap = riserH - slack;
            // Elbows are only meaningful when the next round is exactly half the
            // size of this one; anything else means the bracket data is odd and
            // a guessed line would point at the wrong card.
            const canLink = !!next && roundMatches.length === next.matches.length * 2;

            return (
              <Fragment key={col.roundNum}>
                <div className="flex flex-col shrink-0" style={{ width: COL_W }} role="rowgroup" aria-label={roundName}>
                  <div className="flex items-center justify-center" style={{ height: HEAD_H }}>
                    <h3
                      role="columnheader"
                      className={`text-[11px] font-bold uppercase tracking-[0.12em] ${
                        isFinal ? 'text-[var(--color-warning)]' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {roundName}
                    </h3>
                  </div>

                  <div
                    className="flex flex-col"
                    style={{ paddingTop: padY, paddingBottom: padY, gap: `${gap}px` }}
                  >
                    {roundMatches.map((m) => (
                      <MatchCard
                        key={m.id}
                        m={m}
                        isDoubles={isDoubles}
                        isLive={isLive}
                        getEntryName={getEntryName}
                        getSeed={getSeed}
                        onEnterScore={() => setScoreMatch(m)}
                      />
                    ))}
                  </div>

                  {isSemiRound && thirdPlace && (
                    <div className="relative" style={{ width: COL_W, marginTop: extraGap }}>
                      {/* Dashed, and dropping out of the semi-finals rather than
                          running through the gutter: a solid elbow like the ones
                          between rounds means "the winner advances to here", and
                          this match is fed by the LOSERS and leads nowhere. */}
                      <span
                        aria-hidden="true"
                        className="absolute border-l border-dashed border-[var(--border-hover)]"
                        style={{ left: COL_W / 2, top: -riserH, height: riserH }}
                      />
                      <MatchCard
                        m={thirdPlace}
                        isDoubles={isDoubles}
                        isLive={isLive}
                        getEntryName={getEntryName}
                        getSeed={getSeed}
                        onEnterScore={() => setScoreMatch(thirdPlace)}
                      />
                      <h3 className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                        3rd Place Playoff
                      </h3>
                      {/* Says what it is and, just as importantly, what it is
                          not. Now that a line touches the card, a reader can no
                          longer infer from the absence of one that the winner
                          stops here — so the sentence has to say it. */}
                      <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                        The two semi-final losers. Decides 3rd and 4th — the winner does not advance to the final.
                      </p>
                    </div>
                  )}
                </div>

                {next && (
                  <div className="flex flex-col shrink-0" style={{ width: LINK_W }} aria-hidden="true">
                    <div style={{ height: HEAD_H }} />
                    <div className="relative" style={{ height: bracketH }}>
                      {canLink &&
                        next.matches.map((_, k) => {
                          const yTop = cardCentre(depth, k * 2);
                          const yBottom = cardCentre(depth, k * 2 + 1);
                          const yMid = cardCentre(depth + 1, k);
                          const half = LINK_W / 2;
                          return (
                            <div key={k}>
                              {/* stubs out of each feeder, the riser joining them, then into the winner's card */}
                              <span className="absolute bg-[var(--border-hover)]" style={{ left: 0, top: yTop, width: half, height: 1 }} />
                              <span className="absolute bg-[var(--border-hover)]" style={{ left: 0, top: yBottom, width: half, height: 1 }} />
                              <span className="absolute bg-[var(--border-hover)]" style={{ left: half, top: yTop, width: 1, height: yBottom - yTop }} />
                              <span className="absolute bg-[var(--border-hover)]" style={{ left: half, top: yMid, width: half, height: 1 }} />
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
            </div>
          </div>
        </div>
      </div>

      {/* Fallback only. With no semi-final column there is nothing to hang the
          playoff from, so it keeps its own panel rather than vanishing — an
          event whose bracket data is odd enough to reach here still has a real
          match that needs a score entered. */}
      {thirdPlace && columns.length < 2 && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="flex items-baseline gap-3 mb-3">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
              3rd Place Playoff
            </h3>
            <p className="text-[11px] text-[var(--text-muted)]">
              The two semi-final losers. Decides 3rd and 4th — the winner does not advance to the final.
            </p>
          </div>
          <div style={{ width: COL_W }}>
            <MatchCard
              m={thirdPlace}
              isDoubles={isDoubles}
              isLive={isLive}
              getEntryName={getEntryName}
              getSeed={getSeed}
              onEnterScore={() => setScoreMatch(thirdPlace)}
            />
          </div>
        </div>
      )}

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
  isDoubles: boolean;
  isLive: boolean;
  getEntryName: (id: string | null) => string;
  getSeed: (id: string | null) => number | null;
  onEnterScore: () => void;
}

function MatchCard({ m, isDoubles, isLive, getEntryName, getSeed, onEnterScore }: CardProps) {
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

  const scores = m.scores as GameScore[] | null;
  // Either side can be the empty one — the generator gives the skip to whichever
  // slot the seed landed in, not always slot B.
  const sideLabel = (id: string | null) => (isSkip && !id ? 'skip' : getEntryName(id));
  const label = `Match ${m.match_number ?? ''}: ${sideLabel(aId)} vs ${sideLabel(bId)}${
    isCompleted ? `, winner: ${getEntryName(winnerId)}` : ''
  }`;

  return (
    <div
      role="row"
      aria-label={label}
      style={{ height: CARD_H }}
      className={`flex flex-col rounded-lg border overflow-hidden transition-colors ${
        isReady && isLive
          ? 'border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] shadow-[0_0_0_1px_rgba(204,0,0,0.18)]'
          : isSkip
          ? 'border-dashed border-[var(--border)] opacity-60'
          : 'border-[var(--border)]'
      }`}
    >
      <div
        className="flex items-center justify-between px-2.5 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-elevated)] border-b border-[var(--border)] shrink-0"
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
        score={scores?.map((g) => `${g.a}-${g.b}`).join(' ') ?? null}
      />
      <div className="border-t border-[var(--border)]" />
      <Side
        name={isSkip && !bId ? 'SKIP' : getEntryName(bId)}
        seed={getSeed(bId)}
        isPlaceholder={!bId}
        won={isCompleted && winnerId === bId}
        lost={isCompleted && !!winnerId && !!bId && winnerId !== bId}
        score={scores?.map((g) => `${g.b}-${g.a}`).join(' ') ?? null}
      />

      <div className="shrink-0 border-t border-[var(--border)]" style={{ height: FOOT_H }}>
        {canEnterScore ? (
          <button
            onClick={onEnterScore}
            aria-label={`Enter score for match ${m.match_number ?? ''}`}
            className="w-full h-full text-xs font-medium text-[var(--color-accent)] bg-[var(--bg-elevated)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
          >
            Enter Score
          </button>
        ) : canRecover ? (
          <button
            onClick={onEnterScore}
            aria-label={`${isVoided ? 'Restore match' : 'Fix slots for match'} ${m.match_number ?? ''}`}
            className="w-full h-full text-xs font-medium text-[var(--color-warning)] bg-[var(--bg-elevated)] hover:bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:outline-none"
          >
            {isVoided ? 'Restore Match' : 'Fix Slots'}
          </button>
        ) : canChangeResult ? (
          <button
            onClick={onEnterScore}
            aria-label={`Change the recorded result for match ${m.match_number ?? ''}`}
            className="w-full h-full flex items-center justify-center gap-2 text-xs font-medium bg-[var(--bg-elevated)] hover:bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:outline-none"
          >
            {/* The status stays visible. This is a settled match, and the button
                must not read as though the result is still being entered — the
                label is the secondary thing on the row, not the headline. */}
            <StatusLabel status={m.status} isSkip={false} />
            <span className="text-[var(--text-muted)]">· Change</span>
          </button>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-[var(--bg-elevated)]">
            <StatusLabel status={m.status} isSkip={!!isSkip} />
          </div>
        )}
      </div>
    </div>
  );
}

function Side({
  name,
  seed,
  isPlaceholder,
  won,
  lost,
  score,
}: {
  name: string;
  seed: number | null;
  isPlaceholder: boolean;
  won: boolean;
  lost: boolean;
  score: string | null;
}) {
  return (
    <div
      className={`flex-1 min-h-0 flex items-center gap-2 px-2.5 text-sm ${
        // Inset bar rather than a real border so the winner's name stays on the
        // same baseline as the loser's. The wash is spelled out as color-mix
        // because Tailwind 3 silently drops `/10` on an arbitrary var() colour.
        won
          ? 'bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] shadow-[inset_2px_0_0_var(--color-success)]'
          : 'bg-[var(--bg-card)]'
      }`}
    >
      <span className="w-5 shrink-0 text-right font-mono text-[10px] text-[var(--text-muted)]">
        {seed ? seed : ''}
      </span>
      <span
        className={`flex-1 truncate ${
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
      {score && <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">{score}</span>}
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
