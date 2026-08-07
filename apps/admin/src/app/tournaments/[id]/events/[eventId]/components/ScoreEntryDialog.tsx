'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select, Switch } from '@badminton/ui';
import { getEventRules, previewEloChange, tallyGames, isLegalGameScore } from '@badminton/shared';
import type { TournamentMatchFormat, MatchFormat } from '@badminton/shared';
import {
  enterMatchResult, enterWalkover, voidMatch, unvoidMatch, setMatchEntry, recordDoubleNoShow,
  editMatchResult,
} from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

interface Props {
  match: TournamentMatchRow;
  event: TournamentEventRow;
  nameMap: Record<string, string>;
  seedMap: Record<string, number>;
  isDoubles: boolean;
  // Every entry still eligible to be placed in the draw, for the slot editor.
  entries: Array<{ id: string; name: string }>;
  onClose: () => void;
}

// Which panel the dialog opens on. A voided match can only be restored, and a
// match missing a side cannot be scored — so the dialog leads with the action
// that is actually available instead of an unusable score form.
//
// 'correct' is the panel for a match that ALREADY has a result. It is separate
// from 'score' rather than a mode of it because the two do different things to
// the ladder: 'score' rates a match for the first time and refuses anything
// already decided, while 'correct' reverses the existing rating and re-applies
// it. Sharing one Submit button between them is how somebody ends up pressing
// "enter" on a settled match and being told, opaquely, that it is not playable.
type View = 'score' | 'walkover' | 'slots' | 'restore' | 'correct';

export function ScoreEntryDialog({ match, event, nameMap, seedMap, isDoubles, entries, onClose }: Props) {
  const matchFormat = event.match_format as TournamentMatchFormat;
  // The typed shape wins over the enum, so an event shortened to one game to 15
  // offers one score row rather than three.
  const maxGames = getEventRules(event).bestOf;

  const aId = isDoubles ? match.pair_a_id : match.participant_a_id;
  const bId = isDoubles ? match.pair_b_id : match.participant_b_id;
  const nameA = nameMap[aId ?? ''] ?? 'Side A';
  const nameB = nameMap[bId ?? ''] ?? 'Side B';
  const seedA = seedMap[aId ?? ''];
  const seedB = seedMap[bId ?? ''];

  const isVoided = match.status === 'voided';
  const isDecided = match.status === 'completed' || match.status === 'walkover';
  const hasBothSides = Boolean(aId && bId);

  const [view, setView] = useState<View>(
    isVoided ? 'restore' : isDecided ? 'correct' : hasBothSides ? 'score' : 'slots',
  );
  // Prefilled from the recorded result when there is one, so a correction that
  // only changes the third game does not make the exec retype the first two —
  // and, more importantly, so the form starts from what is actually on the row
  // rather than from blank, which would silently propose wiping the scoreline.
  // A walkover has no scores, so it starts empty and the reason field carries
  // the explanation.
  const recorded = (match.scores as Array<{ a: number; b: number }> | null) ?? [];
  const [games, setGames] = useState<Array<{ a: string; b: string }>>(
    recorded.length > 0
      ? recorded.map((g) => ({ a: String(g.a), b: String(g.b) }))
      : Array.from({ length: maxGames === 1 ? 1 : 2 }, () => ({ a: '', b: '' }))
  );
  const [loading, setLoading] = useState(false);
  // The gym slot ends before the game does often enough that this needs to be
  // one tap away, not a support request (00047). It only widens what the server
  // will accept — the server re-checks the score against the same rules either
  // way, so flipping it cannot smuggle in an impossible scoreline.
  const [timeExceeded, setTimeExceeded] = useState(false);
  const [walkoverLoading, setWalkoverLoading] = useState(false);
  const [walkoverReason, setWalkoverReason] = useState('');
  const [slotPick, setSlotPick] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const { toast } = useToast();
  const router = useRouter();

  // Shared with the challenge result form so the two cannot disagree about who
  // won the same scoreline.
  const { winner: tallyWinner } = tallyGames(
    games.map((g) => ({ side_a_score: g.a, side_b_score: g.b })),
  );

  // Every filled row must be a plain non-negative integer. <input type="number">
  // accepts "e", "E" and "+" as scientific notation, and parseInt(x) || 0 below
  // would turn that into a recorded score of ZERO — type "e" instead of "8" and
  // the match is saved wrong, silently, with no error anywhere.
  const filled = games.filter((g) => g.a !== '' || g.b !== '');
  const scoresAreIntegers = filled.every(
    (g) => /^\d+$/.test(g.a.trim()) && /^\d+$/.test(g.b.trim()),
  );

  // tallyGames only asks who scored more, so 21-15 counts as a won game even in
  // an event played to 30. The dialog then showed "Winner: X" in green for a
  // scoreline the server correctly refuses, and the rejection toast was the only
  // hint. Judge each game against THIS event's target before claiming a winner.
  const gamesAreLegal = scoresAreIntegers && filled.every((g) =>
    isLegalGameScore(
      parseInt(g.a, 10), parseInt(g.b, 10),
      matchFormat as unknown as MatchFormat,
      event.games_per_match, event.points_per_game, timeExceeded,
    ),
  );

  // Only a legal, fully-numeric scoreline names a winner. Everything downstream
  // — the green highlight, the Elo preview, submit — keys off this.
  const autoWinner = scoresAreIntegers && gamesAreLegal ? tallyWinner : null;

  // The dialog holds a snapshot of the match row, so any mutation invalidates
  // what it is displaying — close and let the refreshed bracket re-open it.
  function done(message: string) {
    toast(message, 'success');
    onClose();
    router.refresh();
  }

  function addGame() {
    if (games.length < maxGames) {
      setGames([...games, { a: '', b: '' }]);
    }
  }

  async function handleSubmit() {
    // Say WHICH problem it is. "Cannot determine winner" for a 21-15 game in an
    // event to 30 sends an exec looking for the wrong mistake.
    if (!scoresAreIntegers) { toast('Scores must be whole numbers', 'error'); return; }
    if (!gamesAreLegal) {
      toast(`That scoreline cannot end a game to ${getEventRules(event).target}`, 'error');
      return;
    }
    if (!autoWinner) { toast('Games are level — enter the scores that decide the match', 'error'); return; }
    setLoading(true);
    try {
      const scores = games
        .filter(g => g.a || g.b)
        .map(g => ({ a: parseInt(g.a) || 0, b: parseInt(g.b) || 0 }));
      const res = await enterMatchResult(match.id, scores, autoWinner, timeExceeded);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      done('Score submitted');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // Change a result that is already recorded, without voiding it first.
  //
  // The reason is mandatory here as well as on the server. The server refusal is
  // the boundary; requiring it in the form is what stops the exec discovering it
  // after they have already retyped three games.
  // Change a result that is already recorded, without voiding it first.
  //
  // `winner` is passed explicitly rather than taken from autoWinner, because a
  // WALKOVER has no scoreline to derive one from. Gating the button on
  // autoWinner made the server's scoreless-walkover correction — which exists,
  // and is tested — unreachable from the console: the only way to fix a walkover
  // awarded to the wrong side was to void it, losing the record that it was a
  // walkover at all.
  //
  // The reason is mandatory here as well as on the server. The server refusal is
  // the boundary; requiring it in the form is what stops the exec discovering it
  // after they have already retyped three games.
  async function handleCorrect(winner: 'a' | 'b') {
    if (!walkoverReason.trim()) { toast('Enter a reason for changing the result', 'error'); return; }
    setLoading(true);
    try {
      const scores = games
        .filter(g => g.a || g.b)
        .map(g => ({ a: parseInt(g.a) || 0, b: parseInt(g.b) || 0 }));
      const res = await editMatchResult(match.id, scores, winner, walkoverReason);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      done(
        scores.length > 0
          ? 'Result changed — ratings have been re-applied'
          : 'Walkover re-awarded — ratings have been re-applied',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleWalkover(winner: 'a' | 'b') {
    if (!walkoverReason.trim()) { toast('Enter a reason', 'error'); return; }
    setWalkoverLoading(true);
    try {
      const res = await enterWalkover(match.id, winner, walkoverReason);
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Walkover recorded');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleDoubleNoShow() {
    setWalkoverLoading(true);
    try {
      const res = await recordDoubleNoShow(match.id, walkoverReason || 'Neither side present');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Recorded — neither side present');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleVoid() {
    setWalkoverLoading(true);
    try {
      const res = await voidMatch(match.id, walkoverReason || 'Voided by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Match voided');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleRestore() {
    setWalkoverLoading(true);
    try {
      const res = await unvoidMatch(match.id, walkoverReason || 'Restored by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Match restored — enter the result when it has been played');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleSetSlot(side: 'a' | 'b', entryId: string | null) {
    setWalkoverLoading(true);
    try {
      const res = await setMatchEntry(match.id, side, entryId, walkoverReason || 'Draw corrected by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done(entryId ? 'Entry placed' : 'Slot cleared');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  // Anyone already in this match is not a candidate for its other slot.
  const slotOptions = (occupiedByOther: string | null) => [
    { value: '', label: 'Select entry…' },
    ...entries
      .filter((e) => e.id !== aId && e.id !== bId && e.id !== occupiedByOther)
      .map((e) => ({ value: e.id, label: e.name })),
  ];

  function renderSlotRow(side: 'a' | 'b') {
    const id = side === 'a' ? aId : bId;
    const otherId = side === 'a' ? bId : aId;
    const pick = slotPick[side];

    return (
      <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Side {side.toUpperCase()}
          </span>
          <span className="text-sm text-[var(--text-primary)]">
            {id ? (nameMap[id] ?? 'Unknown') : <em className="text-[var(--text-muted)]">Empty</em>}
          </span>
        </div>
        {id ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => handleSetSlot(side, null)}
            loading={walkoverLoading}
            className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            Clear this slot
          </Button>
        ) : (
          <div className="flex gap-2">
            <Select
              aria-label={`Entry for side ${side.toUpperCase()}`}
              value={pick}
              onChange={(e) => setSlotPick({ ...slotPick, [side]: e.target.value })}
              options={slotOptions(otherId)}
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => handleSetSlot(side, pick)}
              disabled={!pick}
              loading={walkoverLoading}
              className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              Place
            </Button>
          </div>
        )}
      </div>
    );
  }

  const title = isVoided
    ? 'Restore Voided Match'
    : view === 'slots'
    ? 'Fix Match Slots'
    : view === 'correct'
    ? 'Change Recorded Result'
    : 'Enter Match Score';

  // What the row says today, so the exec can see what they are replacing rather
  // than trusting the prefilled boxes to be the same thing.
  const recordedWinnerId = isDoubles ? match.winner_pair_id : match.winner_participant_id;
  // Whether the exec has typed anything at all, which is what distinguishes
  // "rescore this match" from "re-award this walkover".
  const anyScoreTyped = games.some((g) => g.a !== '' || g.b !== '');
  const recordedSummary = recorded.length > 0
    ? recorded.map((g) => `${g.a}-${g.b}`).join(', ')
    : match.status === 'walkover'
    ? `walkover${match.walkover_reason ? ` — ${match.walkover_reason}` : ''}`
    : 'no scores recorded';

  return (
    <Dialog open={true} onClose={onClose} title={title}>
      <div className="space-y-5">
        {/* Players header */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-elevated)]">
          <div className="text-center flex-1">
            {seedA && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedA}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'a' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {aId ? nameA : 'TBD'}
            </span>
          </div>
          <span className="text-xs text-[var(--text-muted)] px-3 font-bold">VS</span>
          <div className="text-center flex-1">
            {seedB && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedB}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'b' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {bId ? nameB : 'TBD'}
            </span>
          </div>
        </div>

        {/* Restore — the only thing a voided match can do */}
        {view === 'restore' && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              This match was voided{match.notes ? `: “${match.notes}”` : ''}. Restoring puts it back in
              play with no result. Any Elo the voided result applied is reversed, so replaying it counts once.
            </p>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is this match being restored?"
            />
            <Button onClick={handleRestore} loading={walkoverLoading} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Restore Match
            </Button>
          </>
        )}

        {/* Slot editor — the escape hatch for a next-round slot nothing will fill */}
        {view === 'slots' && (
          <>
            {!hasBothSides && (
              <p className="text-sm text-[var(--text-muted)]">
                One side of this match is empty, usually because the match feeding it was voided or was
                a branch of byes. Place an entry here, or send the side that is present through unopposed.
              </p>
            )}
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is the draw being changed?"
            />
            {renderSlotRow('a')}
            {renderSlotRow('b')}

            {/* Exactly one side present: push them forward unopposed. Recorded as
                a walkover, which is unrated when there is no opponent. */}
            {(Boolean(aId) !== Boolean(bId)) && (
              <Button
                size="sm"
                onClick={() => handleWalkover(aId ? 'a' : 'b')}
                loading={walkoverLoading}
                className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
              >
                Advance {aId ? nameA : nameB} unopposed
              </Button>
            )}

            {hasBothSides && (
              <Button variant="ghost" size="sm" onClick={() => setView('score')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Back to Score Entry
              </Button>
            )}
          </>
        )}

        {/* Correction — the override for a match that already has a result */}
        {view === 'correct' && (
          <>
            <div className="rounded-lg border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] p-3 space-y-1">
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Currently recorded: {recordedWinnerId ? (nameMap[recordedWinnerId] ?? 'Unknown') : 'no winner'} — {recordedSummary}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Saving reverses the Elo, statistics and streak this result applied, then re-applies them from
                the corrected one. The match is never counted twice, and the change is recorded in the audit
                log with both the old and the new result.
              </p>
            </div>

            {/* Said out loud rather than left to be discovered. Ratings ARE
                corrected; final placings are not, because finalizeEvent only
                runs on a live event and the placement bonuses are not
                idempotent — re-running them would pay every bonus twice. */}
            {event.status === 'completed' && (
              <p className="text-xs text-[var(--color-warning)]">
                This event is already finalised. The correction fixes the ratings and the match record, but
                the final placings, points and any placement bonus were worked out at finalisation and are
                not recalculated. Adjust those by hand if this changes who finished where.
              </p>
            )}

            {games.map((g, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-muted)] w-16">Game {i + 1}</span>
                <Input
                  type="number"
                  aria-label={`Corrected game ${i + 1} score for ${nameA}`}
                  value={g.a}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, a: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
                <span className="text-[var(--text-muted)]">-</span>
                <Input
                  type="number"
                  aria-label={`Corrected game ${i + 1} score for ${nameB}`}
                  value={g.b}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, b: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
              </div>
            ))}

            {games.length < maxGames && (
              <Button variant="ghost" size="sm" onClick={addGame} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">+ Add Game</Button>
            )}

            {autoWinner && (
              <div className="text-center text-sm" role="status" aria-live="polite">
                <span className="text-[var(--color-success)] font-medium">
                  New winner: {autoWinner === 'a' ? nameA : nameB}
                </span>
              </div>
            )}

            <Input
              label="Reason (required)"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is the recorded result wrong?"
            />

            {/* No scores typed at all — a walkover being re-awarded, not a match
                being rescored. There is no scoreline to derive a winner from, so
                the side is named outright. */}
            {!anyScoreTyped ? (
              <>
                <p className="text-xs text-[var(--text-muted)]">
                  No scores entered, so this stays a walkover. Choose who it should be awarded to, or type
                  the real scores above to turn it into a played match.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleCorrect('a')} loading={loading} disabled={!aId || !walkoverReason.trim()} className="flex-1 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Award to {nameA}
                  </Button>
                  <Button size="sm" onClick={() => handleCorrect('b')} loading={loading} disabled={!bId || !walkoverReason.trim()} className="flex-1 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Award to {nameB}
                  </Button>
                </div>
              </>
            ) : (
              <Button
                onClick={() => autoWinner && handleCorrect(autoWinner)}
                loading={loading}
                disabled={!autoWinner || !walkoverReason.trim()}
                className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
              >
                Save Corrected Result
              </Button>
            )}
            {/* Voiding stays reachable from here: a result that should never have
                existed is erased, not corrected, and the two are different
                things to the standings. */}
            <Button variant="ghost" size="sm" onClick={() => setView('walkover')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Void this match instead
            </Button>
          </>
        )}

        {/* Game scores */}
        {view === 'score' && (
          <>
            {games.map((g, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-muted)] w-16">Game {i + 1}</span>
                <Input
                  type="number"
                  value={g.a}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, a: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
                <span className="text-[var(--text-muted)]">-</span>
                <Input
                  type="number"
                  value={g.b}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, b: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
              </div>
            ))}

            {games.length < maxGames && (
              <Button variant="ghost" size="sm" onClick={addGame} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">+ Add Game</Button>
            )}

            {/* Time exceeded — the score stands as it was when time was called */}
            <div className="rounded-lg bg-[var(--bg-elevated)] px-3">
              <Switch
                checked={timeExceeded}
                onChange={setTimeExceeded}
                label="Time exceeded"
                description="Court time ran out mid-game — record the score as it stood."
              />
            </div>

            {/* Winner indicator */}
            {autoWinner && (
              <div className="text-center text-sm" role="status" aria-live="polite">
                <span className="text-[var(--color-success)] font-medium">
                  Winner: {autoWinner === 'a' ? nameA : nameB}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setView('walkover')} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover / Void
              </Button>
              <Button onClick={handleSubmit} loading={loading} disabled={!autoWinner} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Submit Score
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setView('slots')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Fix match slots
            </Button>
          </>
        )}

        {/* Walkover/Void section */}
        {view === 'walkover' && (
          <>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Reason for walkover or void..."
            />
            {/* Every entry point here except Void needs a match that is still
                playable — the server refuses a walkover or a no-show on a
                decided match — so a settled match is offered Void alone rather
                than three buttons that can only fail. Correcting it is the
                other option, and it is the panel this one was reached from. */}
            {!isDecided && (
              <>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleWalkover('a')} loading={walkoverLoading} disabled={!aId} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Walkover → {nameA}
                  </Button>
                  <Button size="sm" onClick={() => handleWalkover('b')} loading={walkoverLoading} disabled={!bId} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                    Walkover → {nameB}
                  </Button>
                </div>
                {/* Neither side present. Distinct from a walkover, which needs
                    somebody to award it to, and from a plain void, which says
                    nothing about why. Disabled unless BOTH sides are known — one
                    empty side is an unopposed walkover, not a no-show. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDoubleNoShow}
                  loading={walkoverLoading}
                  disabled={!aId || !bId}
                  className="w-full text-[var(--color-warning)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                >
                  Neither side turned up
                </Button>
                <p className="text-xs text-[var(--text-muted)]">
                  &ldquo;Neither side turned up&rdquo; marks both entries as a no-show — which counts toward
                  their reliability record — and leaves the next round empty for you to fill.
                </p>
              </>
            )}
            <p className="text-xs text-[var(--text-muted)]">
              Voiding erases the match: any Elo it applied is reversed and its winner is taken back out
              of the next round. It can be restored later.
            </p>
            <Button size="sm" variant="ghost" onClick={handleVoid} loading={walkoverLoading} className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Void Match
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setView(isDecided ? 'correct' : hasBothSides ? 'score' : 'slots')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Back
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
