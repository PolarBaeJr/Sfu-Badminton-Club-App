'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Check, Loader2, AlertCircle } from 'lucide-react';
import { courtLabel, isPlayedMatch } from '@badminton/shared';
import { setMatchCourt, setMatchReadyForPlayer } from '@/lib/tournament-actions';
import type {
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
} from '@/lib/tournament-types';

// ---------------------------------------------------------------------------
// THE DESK.
//
// "give us a location setter / show which location the match is at before the
// score ... so we can tell them where to play through the app." Everything on
// this tab exists to answer one question for the person running the event —
// WHICH MATCH DO I CALL NEXT, AND CAN I? — and it answers it with the two facts
// that used to live only in somebody's head:
//
//   * which court is free, read backwards off which matches have one;
//   * who is actually in the building, because the members tell it now.
//
// A TAB RATHER THAN A CONTROL BOLTED TO THE EXISTING ONES, for two reasons that
// are both about where an exec's hands are. The bracket card is a single
// <button> that opens the score dialog, so an inline input inside it would nest
// an interactive element in a button; and the round-robin fixture list prints no
// court at all. More importantly, the coordinator's question — "does the desk
// need to see, at a glance, which matches still have no court" — has one honest
// answer, which is a list sorted so the uncourted ones are at the top. That is
// not a control on another screen. That is this screen.
//
// UNPLAYED MATCHES ONLY, because a court assignment on a finished match is
// history and this is a working list. Byes are excluded for the same reason:
// nobody walks to a court for one.
// ---------------------------------------------------------------------------

interface Props {
  matches: TournamentMatchRow[];
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  /** tournaments.draw.checkin.mark.write, resolved on the server. */
  canRunDesk: boolean;
}

/** One person on one side of a match — the unit both controls here act on. */
interface DeskPlayer {
  playerId: string;
  name: string;
}

interface DeskSide {
  entryId: string | null;
  label: string;
  players: DeskPlayer[];
}

export function MatchDeskTab({ matches, participants, pairs, isDoubles, canRunDesk }: Props) {
  // Entry id -> the people behind it. A singles entry is one person; a doubles
  // entry is two, and 00135 exists because knowing one of four has turned up is
  // worth something.
  const sides = new Map<string, DeskSide>();
  if (isDoubles) {
    for (const p of pairs) {
      const people: DeskPlayer[] = [];
      if (p.player1) people.push({ playerId: p.player1.id, name: p.player1.full_name });
      if (p.player2) people.push({ playerId: p.player2.id, name: p.player2.full_name });
      sides.set(p.id, {
        entryId: p.id,
        label: p.pair_name ?? people.map((x) => x.name).join(' & ') ?? 'Unknown pair',
        players: people,
      });
    }
  } else {
    for (const p of participants) {
      sides.set(p.id, {
        entryId: p.id,
        label: p.player?.full_name ?? 'Unknown',
        players: p.player ? [{ playerId: p.player.id, name: p.player.full_name }] : [],
      });
    }
  }

  const sideOf = (entryId: unknown): DeskSide =>
    (typeof entryId === 'string' ? sides.get(entryId) : undefined) ??
    { entryId: null, label: 'TBD', players: [] };

  // UNCOURTED FIRST, then pool before bracket, then by round and position. The
  // sort IS the feature: an exec scanning this from the top is looking at exactly
  // the matches that still need somewhere to play, which is the list they were
  // keeping on paper.
  //
  // PHASE OUTRANKS ROUND, and it has to (00107). This tab is given the whole
  // event rather than one half of it — unlike every other match tab, which gets
  // poolMatches or bracketMatches — because the desk calls matches from both
  // halves of a pool_to_bracket event out of one queue and does not want to
  // switch tabs to find the next one. But `round_number` restarts at 1 in the
  // bracket, so sorting on it alone would interleave a pool round 1 with a
  // quarter-final and the top-down read would stop meaning anything.
  const phaseRank = (m: TournamentMatchRow) => (m.phase === 'bracket' ? 1 : 0);
  const live = matches
    .filter((m) => !isPlayedMatch(m) && !m.is_bye && m.status !== 'voided')
    .sort((a, b) => {
      const ac = courtLabel(a.court) ? 1 : 0;
      const bc = courtLabel(b.court) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      if (phaseRank(a) !== phaseRank(b)) return phaseRank(a) - phaseRank(b);
      if (a.round_number !== b.round_number) return a.round_number - b.round_number;
      return (a.bracket_position ?? 0) - (b.bracket_position ?? 0);
    });

  const uncourted = live.filter((m) => !courtLabel(m.court)).length;

  if (live.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-[var(--text-muted)]">
        Nothing left to call — every match in this event has been played.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden />
        <p role="status">
          {uncourted === 0
            ? `All ${live.length} unplayed ${live.length === 1 ? 'match has' : 'matches have'} a court.`
            : `${uncourted} of ${live.length} unplayed ${live.length === 1 ? 'match has' : 'matches have'} no court yet — they are listed first. Entrants see “Court TBC” until you set one.`}
        </p>
      </div>

      {live.map((m) => (
        <DeskRow
          key={m.id}
          match={m}
          a={sideOf(isDoubles ? m.pair_a_id : m.participant_a_id)}
          b={sideOf(isDoubles ? m.pair_b_id : m.participant_b_id)}
          canRunDesk={canRunDesk}
        />
      ))}
    </div>
  );
}

function DeskRow({
  match,
  a,
  b,
  canRunDesk,
}: {
  match: TournamentMatchRow;
  a: DeskSide;
  b: DeskSide;
  canRunDesk: boolean;
}) {
  const readyIds = new Set(match.ready_player_ids ?? []);
  const everyone = [...a.players, ...b.players];
  const readyCount = everyone.filter((p) => readyIds.has(p.playerId)).length;
  const label = courtLabel(match.court);

  return (
    <div className="border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)] truncate">
            {a.label} <span className="text-[var(--text-muted)]">vs</span> {b.label}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-0.5">
            {match.phase === 'pool' ? 'Pool · ' : match.phase === 'bracket' ? 'Knockout · ' : ''}
            {match.round_name || `Round ${match.round_number}`}
            {match.match_number ? ` · M${match.match_number}` : ''}
            {everyone.length > 0 ? ` · ${readyCount} of ${everyone.length} here` : ''}
          </p>
        </div>
        <span
          className={`shrink-0 text-sm font-semibold ${label ? 'text-[var(--color-accent)]' : 'text-[var(--text-dim)]'}`}
        >
          {label ?? 'No court'}
        </span>
      </div>

      <CourtField matchId={match.id} current={match.court ?? ''} disabled={!canRunDesk} />

      {everyone.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {everyone.map((p) => (
            <ReadyPill
              key={p.playerId}
              matchId={match.id}
              player={p}
              ready={readyIds.has(p.playerId)}
              disabled={!canRunDesk}
            />
          ))}
        </div>
      )}
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
 * The desk's copy of the member's own control, and the reason it is gated on
 * tournaments.draw.checkin.mark.write rather than on a new key: it is the same
 * act of recording that somebody has turned up, at match granularity instead of
 * event granularity. Audited, unlike the member's own tap — see
 * lib/tournament-actions/scheduling.ts.
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

  return (
    <button
      type="button"
      disabled={disabled || pending}
      aria-pressed={ready}
      onClick={() =>
        startTransition(async () => {
          const res = await setMatchReadyForPlayer(matchId, player.playerId, !ready);
          if (res.ok) router.refresh();
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
  );
}
