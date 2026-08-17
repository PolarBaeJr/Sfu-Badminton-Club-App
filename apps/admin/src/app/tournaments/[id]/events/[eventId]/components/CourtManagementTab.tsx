'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Check, Loader2, AlertCircle, Play, Square, ArrowRight } from 'lucide-react';
import { courtLabel, isPlayedMatch, eventIsPlaying } from '@badminton/shared';
import { setMatchCourt, setMatchReadyForPlayer, setMatchLive } from '@/lib/tournament-actions';
import type {
  TournamentMatchRow,
  TournamentEventRow,
  ParticipantWithPlayer,
  PairWithPlayers,
} from '@/lib/tournament-types';
import { getName } from './entry-name';
import { ScoreEntryDialog } from './ScoreEntryDialog';

// ---------------------------------------------------------------------------
// COURT MANAGEMENT — where an event is RUN rather than recorded.
//
// "give us a location setter / show which location the match is at before the
// score ... so we can tell them where to play through the app", then "this
// should follow the order of the matches, and should be showing 'next one'",
// then "this should show 'active match' and also allow insert of data on this
// side instead of the main thing". Four asks, one screen, and together they
// describe the desk's actual job end to end:
//
//     name the court -> confirm they are here -> call them on -> record it
//
// Until now the last step lived somewhere else and the middle two did not exist.
//
// A TAB RATHER THAN CONTROLS BOLTED TO THE BRACKET, and the reason is structural
// rather than aesthetic: the bracket's match card is a single <button> wrapping
// the whole card (BracketTab), so a text input or a ready pill inside it would
// nest interactive elements. This row therefore follows RoundRobinTab's pattern
// instead — a plain <div> with its own inline controls.
//
// ---------------------------------------------------------------------------
// THE ORDER: THE DRAW'S OWN SEQUENCE, AND NOTHING ELSE
// ---------------------------------------------------------------------------
// This list used to sort uncourted matches first, on the theory that "which
// matches still need a court" was the working question. In practice the owner's
// screenshot read "95 of 98 unplayed matches have no court yet — they are listed
// first", which is the sort admitting it does nothing: on any real draw almost
// everything is uncourted, so the rule never differentiates and its only effect
// is to hide the sequence the desk actually works in.
//
// It was also quietly hostile. Saving a court moved that row from the top group
// to the bottom one, so the reward for typing "3" was watching the row you were
// looking at jump off screen.
//
// So: phase, then round, then match number. Nothing about a match's STATE touches
// the order, which means no row ever moves under the desk's hands — not when a
// court is saved, not when someone is marked ready, not when a result lands
// elsewhere and the whole list repaints. The states are shown as badges on rows
// that stay put. That is the property that makes this safe to type into.
//
// PHASE OUTRANKS ROUND, and it has to (00107). This tab is given the whole event
// rather than one half of it, because the desk calls matches from both halves of
// a pool_to_bracket event out of one queue — but `round_number` restarts at 1 in
// the bracket, so ordering on it alone would interleave a pool round 1 with a
// quarter-final.
//
// MATCH NUMBER RATHER THAN bracket_position, because the number is what the desk
// and the entrant both say out loud — the row prints "ROUND OF 128 · M4" and
// M4 is the ordinal in that round. bracket_position is the layout's coordinate
// and can differ. It falls back to bracket_position where match_number is null,
// which is how a draw generated before 00080's renumbering still sorts sanely.
// ---------------------------------------------------------------------------

interface Props {
  matches: TournamentMatchRow[];
  /** Needed by the shared ScoreEntryDialog — it resolves the per-round shape from it. */
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /** tournaments.draw.checkin.mark.write — courts, ready marks, start/stop. */
  canManageCourts: boolean;
  /** tournaments.results.enter.write — a DIFFERENT key. See participant-controls.ts. */
  canEnterResult: boolean;
}

/** One person on one side of a match — the unit the ready control acts on. */
interface DeskPlayer {
  playerId: string;
  name: string;
}

interface DeskSide {
  entryId: string | null;
  label: string;
  players: DeskPlayer[];
}

/**
 * The three states an unplayed match can be in, which is the whole information
 * content of this screen.
 *
 *   live     BEING PLAYED RIGHT NOW. Occupying a court, so it is what the desk
 *            needs to know about before anything else — and, until 00136, a state
 *            nothing in either app could produce.
 *   callable Both entrants known and not started. Can be sent on now.
 *   waiting  An entrant is still TBD, because a feeder match has not been played.
 *            Not callable however free the courts are.
 */
type DeskState = 'live' | 'callable' | 'waiting';

export function CourtManagementTab({
  matches,
  event,
  participants,
  pairs,
  isDoubles,
  canManageCourts,
  canEnterResult,
}: Props) {
  // Entry id -> the people behind it. A singles entry is one person; a doubles
  // entry is two, and 00135 exists because knowing one of four has turned up is
  // worth something.
  const sides = useMemo(() => {
    const map = new Map<string, DeskSide>();
    if (isDoubles) {
      for (const p of pairs) {
        const people: DeskPlayer[] = [];
        if (p.player1) people.push({ playerId: p.player1.id, name: p.player1.full_name });
        if (p.player2) people.push({ playerId: p.player2.id, name: p.player2.full_name });
        // getName, not a locally joined string: the dialog and the bracket both
        // render the shared form, and a pair reading "A & B" here while the
        // bracket says "A / B" is the kind of drift that makes an exec ask
        // whether they are looking at the same match.
        map.set(p.id, { entryId: p.id, label: getName(p, isDoubles), players: people });
      }
    } else {
      for (const p of participants) {
        map.set(p.id, {
          entryId: p.id,
          label: getName(p, isDoubles),
          players: p.player ? [{ playerId: p.player.id, name: p.player.full_name }] : [],
        });
      }
    }
    return map;
  }, [isDoubles, pairs, participants]);

  // What the shared ScoreEntryDialog needs, derived FRESH rather than reused from
  // `sides` above: its contract is Record<string, string> keyed by entry id, and
  // its doubles label has to match the bracket's.
  const { nameMap, seedMap, placeableEntries } = useMemo(() => {
    const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
    const nameMap: Record<string, string> = {};
    const seedMap: Record<string, number> = {};
    for (const e of entries) {
      nameMap[e.id] = getName(e, isDoubles);
      if (e.seed_number) seedMap[e.id] = e.seed_number;
    }
    const placeableEntries = entries
      .filter((e) => e.status !== 'withdrawn' && e.status !== 'disqualified')
      .map((e) => ({ id: e.id, name: nameMap[e.id] ?? 'Unknown' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { nameMap, seedMap, placeableEntries };
  }, [isDoubles, pairs, participants]);

  /**
   * THE OPEN DIALOG, HELD AS AN ID RATHER THAN A ROW.
   *
   * RoundRobinTab and BracketTab both stash the match OBJECT, which means the
   * dialog goes on rendering the row as it was when it was clicked. That is
   * survivable there; here it is not, because this tab is the one that repaints
   * constantly — every court, ready mark and start on the whole event nudges it.
   * Looking the row up again on each render means the dialog always shows the
   * live one.
   *
   * LOOKED UP IN `matches`, THE UNFILTERED LIST, on purpose. Entering a score
   * makes the match `completed`, which drops it out of the working list below —
   * and the dialog's after-game summary is rendered AFTER that happens. Resolving
   * against the filtered list would unmount the dialog at the exact moment it had
   * something to say.
   */
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const scoreMatch = scoreMatchId ? matches.find((m) => m.id === scoreMatchId) ?? null : null;

  // Only while the event is actually being played, matching what BracketTab asks
  // before it offers score entry at all. A draw that exists but has not started
  // is not a thing anybody is standing at a desk for.
  const eventPlaying = eventIsPlaying(event.status) || event.status === 'bracket_generated';

  const phaseRank = (m: TournamentMatchRow) => (m.phase === 'bracket' ? 1 : 0);
  const ordinal = (m: TournamentMatchRow) => m.match_number ?? m.bracket_position ?? 0;

  const rows = useMemo(() => {
    const sideOf = (entryId: unknown): DeskSide =>
      (typeof entryId === 'string' ? sides.get(entryId) : undefined) ??
      { entryId: null, label: 'TBD', players: [] };

    return matches
      .filter((m) => !isPlayedMatch(m) && !m.is_bye && m.status !== 'voided')
      .map((m) => {
        const a = sideOf(isDoubles ? m.pair_a_id : m.participant_a_id);
        const b = sideOf(isDoubles ? m.pair_b_id : m.participant_b_id);
        const bothKnown = !!a.entryId && !!b.entryId;
        const state: DeskState =
          m.status === 'live' ? 'live' : bothKnown ? 'callable' : 'waiting';
        return { match: m, a, b, state };
      })
      .sort((x, y) => {
        if (phaseRank(x.match) !== phaseRank(y.match)) return phaseRank(x.match) - phaseRank(y.match);
        if (x.match.round_number !== y.match.round_number) return x.match.round_number - y.match.round_number;
        return ordinal(x.match) - ordinal(y.match);
      });
  }, [matches, sides, isDoubles]);

  /**
   * WHICH ONE IS "NEXT", AND WHY IT IS ONE AND NOT A SET.
   *
   * The earliest `callable` row in the order above. Three decisions in that:
   *
   * A `live` MATCH DOES NOT OUTRANK IT — it is excluded. "Next" means the one to
   * send on now, and a match already being played is not something you call; it is
   * something you wait for. Live matches carry their own ON COURT badge and are
   * counted separately, which is the fact the desk needs from them (how many
   * courts are busy).
   *
   * TBD IS NOT CALLABLE. A round-of-64 slot fed by unplayed round-of-128 matches
   * has no names in it, so however many courts are free it cannot be sent
   * anywhere. Those rows say what they are waiting for instead.
   *
   * ONE, THOUGH SEVERAL COURTS RUN AT ONCE — and the owner's "next one" is right
   * even though his need is plural. Several matches genuinely ARE callable: on a
   * fresh round of 128, all 64 of them. Badging 64 rows "callable now" would be
   * badging the whole list, which is not information. And the app CANNOT compute
   * "the next four", because nothing in this schema knows how many courts the club
   * has — `sessions` has no court column and nothing else counts them, which is
   * written down in two places already (admin dashboard/page.tsx, sessions/page.tsx).
   *
   * What makes one badge sufficient is the ordering above: the rows immediately
   * BELOW the one marked NEXT are, by construction, the ones after next. The desk
   * reads down. That is the whole reason ordering by the draw's own sequence and
   * marking a single next are the same feature rather than two.
   */
  const nextRow = rows.find((r) => r.state === 'callable') ?? null;

  const liveCount = rows.filter((r) => r.state === 'live').length;
  const callableCount = rows.filter((r) => r.state === 'callable').length;
  const uncourted = rows.filter((r) => !courtLabel(r.match.court)).length;

  if (rows.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-[var(--text-muted)]">
        Nothing left to call — every match in this event has been played.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {/* THE SUMMARY, WHICH IS THE ONE THING WORTH READING BEFORE THE LIST. It
            answers "what am I calling next" without scrolling, which is the ask,
            and it names the match rather than just counting — a desk holding a
            phone wants the two names it is about to shout. */}
        <div className="border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2">
          {nextRow ? (
            <div className="flex items-start gap-2">
              <ArrowRight className="w-4 h-4 text-[var(--color-accent)] mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-[var(--color-accent)] font-semibold">
                  Next up
                </p>
                <p className="text-sm text-[var(--text-primary)] break-words" role="status">
                  {nextRow.a.label} <span className="text-[var(--text-muted)]">vs</span> {nextRow.b.label}
                </p>
                <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-0.5">
                  {roundLine(nextRow.match)}
                  {' · '}
                  {courtLabel(nextRow.match.court) ?? 'no court yet'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]" role="status">
              {liveCount > 0
                ? `Nothing to call — ${liveCount === 1 ? 'the last match is' : `all ${liveCount} remaining matches are`} on court.`
                : 'Nothing can be called yet — every remaining match is waiting on an earlier result.'}
            </p>
          )}
          <div className="flex items-start gap-2 text-xs text-[var(--text-muted)] pt-1 border-t border-[var(--border)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
            {/* THE UNCOURTED COUNT SURVIVED THE SORT CHANGE, because it is
                genuinely useful — it just no longer decides the order. */}
            <p role="status">
              {liveCount} on court · {callableCount} ready to call · {rows.length - liveCount - callableCount} waiting
              {uncourted > 0 && ` · ${uncourted} with no court yet (entrants see “Court TBC”)`}
            </p>
          </div>
        </div>

        {rows.map(({ match, a, b, state }) => (
          <DeskRow
            key={match.id}
            match={match}
            a={a}
            b={b}
            state={state}
            isNext={nextRow?.match.id === match.id}
            canManageCourts={canManageCourts}
            canEnterResult={canEnterResult && eventPlaying}
            onEnterScore={() => setScoreMatchId(match.id)}
          />
        ))}
      </div>

      {/* THE SHARED DIALOG, NOT A SECOND SCORE FORM. It already owns the per-round
          shape (resolveMatchShape), best-of-3, legal-score and time-exceeded
          validation, the walkover / void / slot-repair paths, and the after-game
          summary with the entrants' tournament stats. A fork would have drifted
          from all of it inside a week, which is the thing this repo has spent the
          day removing.

          It refreshes the route itself on save, so the list below re-derives its
          states and its "next" from the new data with nothing wired between them. */}
      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          entries={placeableEntries}
          onClose={() => setScoreMatchId(null)}
        />
      )}
    </>
  );
}

/** "Pool · Round 2 · M4" / "Knockout · Round of 128 · M4". */
function roundLine(m: TournamentMatchRow): string {
  const parts: string[] = [];
  if (m.phase === 'pool') parts.push('Pool');
  else if (m.phase === 'bracket') parts.push('Knockout');
  parts.push(m.round_name || `Round ${m.round_number}`);
  if (m.match_number) parts.push(`M${m.match_number}`);
  return parts.join(' · ');
}

function DeskRow({
  match,
  a,
  b,
  state,
  isNext,
  canManageCourts,
  canEnterResult,
  onEnterScore,
}: {
  match: TournamentMatchRow;
  a: DeskSide;
  b: DeskSide;
  state: DeskState;
  isNext: boolean;
  canManageCourts: boolean;
  canEnterResult: boolean;
  onEnterScore: () => void;
}) {
  const readyIds = new Set(match.ready_player_ids ?? []);
  const everyone = [...a.players, ...b.players];
  const readyCount = everyone.filter((p) => readyIds.has(p.playerId)).length;
  const label = courtLabel(match.court);

  // THE THREE STATES, FINDABLE AT A GLANCE ON A PHONE. Colour AND a word, never
  // colour alone — this is read at arm's length under gym lighting, and a badge
  // that only differs by hue is a badge that differs by nothing.
  const badge =
    state === 'live'
      ? { text: 'On court', cls: 'border-[var(--color-success)]/45 bg-[var(--color-success)]/12 text-[var(--color-success)]' }
      : isNext
        ? { text: 'Next up', cls: 'border-[var(--color-accent)]/50 bg-[var(--color-accent)]/12 text-[var(--color-accent)]' }
        : state === 'callable'
          ? { text: 'Ready to call', cls: 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]' }
          : { text: 'Waiting', cls: 'border-[var(--border)] bg-transparent text-[var(--text-dim)]' };

  return (
    <div
      className={`border p-3 space-y-3 ${
        state === 'live'
          ? 'border-[var(--color-success)]/35 bg-[var(--color-success)]/5'
          : isNext
            ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5'
            : 'border-[var(--border)] bg-[var(--bg-elevated)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-flex items-center px-2 py-0.5 mb-1 border text-[10px] font-bold uppercase tracking-wider ${badge.cls}`}>
            {badge.text}
          </span>
          <p className="text-sm text-[var(--text-primary)] break-words">
            {a.label} <span className="text-[var(--text-muted)]">vs</span> {b.label}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-0.5">
            {roundLine(match)}
            {everyone.length > 0 ? ` · ${readyCount} of ${everyone.length} here` : ''}
          </p>
          {/* A WAITING ROW SAYS WHY. Without this the desk sees "TBD vs TBD" and
              wonders whether something is broken, which is how the READY label
              got reported as a bug in the first place. */}
          {state === 'waiting' && (
            <p className="text-[11px] text-[var(--text-dim)] mt-0.5">
              Waiting on an earlier result to fill {!a.entryId && !b.entryId ? 'both slots' : 'a slot'}.
            </p>
          )}
        </div>
        <span className={`shrink-0 text-sm font-semibold ${label ? 'text-[var(--color-accent)]' : 'text-[var(--text-dim)]'}`}>
          {label ?? 'No court'}
        </span>
      </div>

      <CourtField matchId={match.id} current={match.court ?? ''} disabled={!canManageCourts} />

      {everyone.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {everyone.map((p) => (
            <ReadyPill
              key={p.playerId}
              matchId={match.id}
              player={p}
              ready={readyIds.has(p.playerId)}
              disabled={!canManageCourts}
            />
          ))}
        </div>
      )}

      {/* CALL ON / RECORD. Two controls, two capabilities, and the row is honest
          about which it is offering — see participant-controls.ts for why running
          the door and deciding who won are not the same key. */}
      <div className="flex flex-wrap gap-1.5">
        {state !== 'waiting' && canManageCourts && (
          <StartStopButton matchId={match.id} live={state === 'live'} />
        )}
        {state !== 'waiting' && canEnterResult && (
          <button
            type="button"
            onClick={onEnterScore}
            aria-label={`Enter the score for ${a.label} versus ${b.label}`}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-3 border border-[var(--border)] bg-[var(--bg-surface)] text-xs font-medium text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            Enter score
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * PUTTING A MATCH ON COURT.
 *
 * "this should show 'active match'" needed a writer before it could need a badge:
 * `tournament_matches.status` has admitted 'live' since 00001 and nothing in
 * either app has ever written it — see 00136 for the trace. This is that writer's
 * control, and pressing it is also what finally shows an entrant "On court now"
 * on their own phone, a label the player app has carried all along for a state
 * nothing could produce.
 *
 * Stop is a CORRECTION, not an outcome — the way out of 'live' is a result, and
 * an exec who pressed Start on the wrong row should not have to invent one.
 */
function StartStopButton({ matchId, live }: { matchId: string; live: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await setMatchLive(matchId, !live);
            if (!res.ok) { setError(res.error); return; }
            router.refresh();
          })
        }
        className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 border text-xs font-semibold uppercase tracking-wide transition-colors duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          live
            ? 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            : 'border-[var(--color-success)]/45 bg-[var(--color-success)]/12 text-[var(--color-success)]'
        }`}
      >
        {pending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
        ) : live ? (
          <Square className="w-3.5 h-3.5" aria-hidden />
        ) : (
          <Play className="w-3.5 h-3.5" aria-hidden />
        )}
        {live ? 'Take off court' : 'Send on court'}
      </button>
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)]" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The court, as an exec types it.
 *
 * A TEXT BOX AND NOT A PICKER, and 00135 argues it at length: the club has no
 * court model, no agreed numbering, and no request for one, so a picker would be
 * a setup step somebody has to remember at 9am on a Saturday. `courtLabel`
 * absorbs "Court 3" as readily as "3", so the desk does not have to be taught a
 * convention either.
 *
 * SAVES ON BLUR AS WELL AS ON SUBMIT. This is typed one-handed between calling
 * matches; requiring a deliberate second press to commit is how a court gets set
 * on the console and never reaches anybody's phone.
 *
 * A HALF-TYPED COURT SURVIVES A REPAINT, which matters more now than it did.
 * This tab repaints on every tournament write in the event — a score landing on
 * another court, somebody's phone marking them ready — and the desk may well be
 * mid-keystroke when one arrives. `value` is component state seeded once from the
 * prop, so a re-render with a new `current` leaves what is being typed alone; and
 * since the list is now ordered by the draw's own sequence, no state change can
 * reorder the row out from under the cursor either. Both halves of that are
 * needed: keeping the state but moving the node loses the focus instead.
 */
function CourtField({ matchId, current, disabled }: { matchId: string; current: string; disabled: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function commit() {
    if (value.trim() === current.trim()) return;
    setError(null);
    startTransition(async () => {
      const res = await setMatchCourt(matchId, value);
      if (!res.ok) {
        setError(res.error);
        setValue(current);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <label className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-hidden />
        <span className="sr-only">Court for this match</span>
        <input
          type="text"
          inputMode="text"
          maxLength={32}
          value={value}
          disabled={disabled || pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            // Escape abandons the edit rather than committing a half-typed
            // court to twenty phones.
            if (e.key === 'Escape') { setValue(current); e.currentTarget.blur(); }
          }}
          placeholder="Court — e.g. 3"
          className="flex-1 min-w-0 min-h-[44px] px-3 bg-[var(--bg-surface)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
        />
        {pending && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" aria-hidden />}
      </label>
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)]" role="alert">{error}</p>}
    </div>
  );
}

/**
 * "She is standing right here and has not touched her phone."
 *
 * Gated on tournaments.draw.checkin.mark.write rather than a key of its own: it is
 * the same act of recording that somebody has turned up, at match granularity
 * instead of event granularity. Audited, unlike the member's own tap — see
 * lib/tournament-actions/scheduling.ts.
 *
 * IT NOW SAYS WHEN IT FAILS, which it did not. The click handler used to be
 * `if (res.ok) router.refresh()` with no else, so any refusal — a suspended
 * tournament, a finished match, or PostgREST not having reloaded its schema cache
 * after 00135 created the function — was dropped on the floor and the pill simply
 * did nothing. That is an unfalsifiable bug report waiting to happen, and 00136
 * argues it was very likely the one behind "this doesnt work".
 */
function ReadyPill({
  matchId,
  player,
  ready,
  disabled,
}: {
  matchId: string;
  player: DeskPlayer;
  ready: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={disabled || pending}
        aria-pressed={ready}
        aria-label={`${ready ? 'Clear' : 'Mark'} ${player.name} as ready`}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await setMatchReadyForPlayer(matchId, player.playerId, !ready);
            if (!res.ok) { setError(res.error); return; }
            router.refresh();
          })
        }
        className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 border text-xs font-medium transition-colors duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          ready
            ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/12 text-[var(--color-success)]'
            : 'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        }`}
      >
        {pending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
        ) : ready ? (
          <Check className="w-3.5 h-3.5" aria-hidden />
        ) : null}
        {player.name}
      </button>
      {error && <p className="mt-1 text-[11px] text-[var(--color-accent)] max-w-[16rem]" role="alert">{error}</p>}
    </div>
  );
}
