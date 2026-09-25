'use client';

import { useState } from 'react';
import { Button, Dialog, Input, PlayerPicker, Switch, Textarea } from '@badminton/ui';
import {
  tallyGames,
  CUSTOM_FORMAT_BOUNDS,
  customFormatHint,
  isLegalCustomGames,
  isLegalCustomPoints,
} from '@badminton/shared';
import { adminCreateMatch } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

type Player = { id: string; full_name: string; avatar_url?: string | null };

/** Auto-grow the textarea with its content, capped at ~60vh (dialog scrolls past that). */
function autoGrow(e: React.FormEvent<HTMLTextAreaElement>) {
  const el = e.currentTarget;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.6)}px`;
}

export function CreateMatchForm({ players }: { players: Player[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [matchType, setMatchType] = useState('singles');
  // The four presets were only (games, points) pairs — "Best of 3 to 21" IS 3
  // and 21 — so the dropdown was a step with nothing behind it. Both numbers are
  // typed instead. Held as text so a field can be cleared while it is retyped;
  // the defaults are the old bo3_21.
  const [customGames, setCustomGames] = useState('3');
  const [customPoints, setCustomPoints] = useState('21');
  const formatInvalid = !isLegalCustomGames(Number(customGames)) || !isLegalCustomPoints(Number(customPoints));
  // The enum is only what the DB coalesces to when the custom columns are null
  // (migration 00031), so all it has to record is "more than one game or not".
  const format = Number(customGames) > 1 ? 'bo3_21' : 'single_21';
  const [rated, setRated] = useState(true);
  const [sideA1, setSideA1] = useState('');
  const [sideA2, setSideA2] = useState('');
  const [sideB1, setSideB1] = useState('');
  const [sideB2, setSideB2] = useState('');
  const [games, setGames] = useState([{ game_number: 1, side_a_score: 0, side_b_score: 0 }]);
  const [note, setNote] = useState('');
  const { toast } = useToast();

  // Derived from the scores rather than held in state — the same helper the
  // challenge form and the tournament bracket use, so no two entry points can
  // disagree about who won the same scoreline.
  const tally = tallyGames(games);

  // A best-of-N stops the moment someone clinches, so N is the most games the
  // match can contain — the old flat 3 predates typed formats. While the field
  // is mid-edit and unusable, fall back to the widest shape allowed; the form
  // cannot be submitted in that state anyway.
  const maxGames = isLegalCustomGames(Number(customGames)) ? Number(customGames) : CUSTOM_FORMAT_BOUNDS.maxGames;

  function addGame() {
    if (games.length >= maxGames) return;
    setGames([...games, { game_number: games.length + 1, side_a_score: 0, side_b_score: 0 }]);
  }

  function removeGame() {
    if (games.length <= 1) return;
    setGames(games.slice(0, -1));
  }

  function updateGame(index: number, field: 'side_a_score' | 'side_b_score', value: number) {
    const updated = games.map((g, i) =>
      i === index ? { game_number: g.game_number, side_a_score: g.side_a_score, side_b_score: g.side_b_score, [field]: value } : g
    );
    setGames(updated);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!sideA1 || !sideB1) { toast('Select players for both sides', 'error'); return; }
    if (matchType === 'doubles' && (!sideA2 || !sideB2)) { toast('Doubles requires 2 players per side', 'error'); return; }
    // Format first: an invalid best-of/points pair makes the winner check
    // meaningless, since maxGames falls back to the widest shape while the
    // field is mid-edit.
    if (formatInvalid) { toast(customFormatHint(Number(customGames), Number(customPoints)), 'error'); return; }
    // Level or unplayed games have no winner, and guessing one here would write
    // a rating change nobody could trace back to a wrong scoreline.
    if (!tally.winner) { toast('No winner yet: enter the scores that decide the match', 'error'); return; }

    const sideAPlayers = matchType === 'doubles' ? [sideA1, sideA2] : [sideA1];
    const sideBPlayers = matchType === 'doubles' ? [sideB1, sideB2] : [sideB1];

    setLoading(true);
    try {
      const res = await adminCreateMatch({
        match_type: matchType,
        // The enum stays the fallback; the custom columns win when present.
        format,
        games_per_match: Number(customGames),
        points_per_game: Number(customPoints),
        rated_flag: rated,
        side_a_players: sideAPlayers,
        side_b_players: sideBPlayers,
        winner_side: tally.winner,
        games,
        admin_note: note || undefined,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Match created', 'success');
      setOpen(false);
      setSideA1(''); setSideA2(''); setSideB1(''); setSideB2('');
      setGames([{ game_number: 1, side_a_score: 0, side_b_score: 0 }]);
      setNote('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }


  const playerOptions = players.map(p => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url }));

  // Scores are typed on a numeric keypad, not spun: a text field with digits
  // only, and an empty box standing for 0 so a score is typed, not edited.
  const scoreInput = (i: number, field: 'side_a_score' | 'side_b_score', label: string, won: boolean) => (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      placeholder="0"
      value={games[i]![field] === 0 ? '' : String(games[i]![field])}
      onChange={(e) => updateGame(i, field, Number(e.target.value.replace(/\D/g, '').slice(0, 2)))}
      className={`h-12 w-full rounded-[var(--r-control,8px)] border bg-[var(--bg-surface)] text-center font-mono text-lg tabular-nums placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition-colors ${
        won ? 'border-[var(--color-success)] text-[var(--color-success)]' : 'border-[var(--border)] text-[var(--text-primary)]'
      }`}
    />
  );

  return (
    <>
      <Button onClick={() => setOpen(true)}>Enter Match</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Admin Match Entry">
        {/* No scroll of its own: the Dialog panel already scrolls at 90vh, and a
            second scroller inside it showed two scrollbars. */}
        <form onSubmit={handleCreate} className="space-y-5">
          <div className="space-y-1.5">
            <p className="block text-[13px] font-medium text-[var(--text-secondary)]" id="match-type-label">Match type</p>
            <div
              role="radiogroup"
              aria-labelledby="match-type-label"
              className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]"
            >
              {[
                { value: 'singles', label: 'Singles' },
                { value: 'doubles', label: 'Doubles' },
              ].map((o) => {
                const on = matchType === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setMatchType(o.value)}
                    className={`min-h-[40px] rounded-md text-sm transition-colors ${
                      on
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-[inset_0_-2px_0_var(--color-accent)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Best of (games)"
              type="text"
              inputMode="numeric"
              value={customGames}
              onChange={(e) => {
                const next = e.target.value.replace(/\D/g, '').slice(0, 1);
                setCustomGames(next);
                // Shortening the match must not leave more score rows than it
                // can hold: those rows are submitted, and a best-of-1 with
                // three games recorded is not a result that could have happened.
                if (isLegalCustomGames(Number(next))) {
                  setGames((current) => current.slice(0, Number(next)));
                }
              }}
              placeholder="3"
            />
            <Input
              label="Points per game"
              type="text"
              inputMode="numeric"
              value={customPoints}
              onChange={(e) => setCustomPoints(e.target.value.replace(/\D/g, '').slice(0, 2))}
              placeholder="21"
            />
            <p className={`col-span-2 -mt-1 text-xs ${formatInvalid ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}`}>
              {customFormatHint(Number(customGames), Number(customPoints))}
            </p>
          </div>

          <Switch
            checked={rated}
            onChange={setRated}
            label="Rated match"
            description={rated ? 'Moves both sides’ ratings.' : 'Recorded, but no rating changes.'}
          />

          {/* role=group ties the pickers to their side heading: without it a
              screen reader hears "Player 1" twice with nothing to tell them apart. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              { key: 'a', title: 'Side A', one: [sideA1, setSideA1], two: [sideA2, setSideA2] },
              { key: 'b', title: 'Side B', one: [sideB1, setSideB1], two: [sideB2, setSideB2] },
            ] as const).map((side) => (
              <div key={side.key} className="dialog-group space-y-3" role="group" aria-labelledby={`side-${side.key}-heading`}>
                <p className="dialog-group-label !mb-0" id={`side-${side.key}-heading`}>{side.title}</p>
                <PlayerPicker
                  label={matchType === 'doubles' ? 'Player 1' : 'Player'}
                  value={side.one[0]}
                  onChange={side.one[1]}
                  players={playerOptions}
                />
                {matchType === 'doubles' && (
                  <PlayerPicker label="Player 2" value={side.two[0]} onChange={side.two[1]} players={playerOptions} />
                )}
              </div>
            ))}
          </div>

          <div className="dialog-group">
            <div className="flex items-center justify-between mb-3">
              <p className="dialog-group-label !mb-0">Games</p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--text-muted)] tabular-nums">{games.length} of {maxGames}</span>
                <button type="button" className="stepper-btn" onClick={removeGame} disabled={games.length <= 1} aria-label="Remove game">&minus;</button>
                <button type="button" className="stepper-btn" onClick={addGame} disabled={games.length >= maxGames} aria-label="Add game">+</button>
              </div>
            </div>
            <div className="grid grid-cols-[4.5rem_1fr_1fr] gap-x-2 gap-y-2 items-center">
              <span />
              <span className="text-center text-xs font-medium text-[var(--text-secondary)]">Side A</span>
              <span className="text-center text-xs font-medium text-[var(--text-secondary)]">Side B</span>
              {games.map((g, i) => (
                <div key={i} className="contents">
                  <span className="text-xs text-[var(--text-muted)]">Game {g.game_number}</span>
                  {scoreInput(i, 'side_a_score', `Game ${g.game_number}, Side A score`, g.side_a_score > g.side_b_score)}
                  {scoreInput(i, 'side_b_score', `Game ${g.game_number}, Side B score`, g.side_b_score > g.side_a_score)}
                </div>
              ))}
            </div>
          </div>

          {/* Read-only: the scores above already answer this. The tally is shown
              alongside so a typo is visible as a wrong games count, not just as
              a winner the admin has no way to check. */}
          <div
            role="status"
            aria-live="polite"
            className={`rounded-lg border px-4 py-3 text-sm ${
              tally.winner
                ? 'border-[var(--color-success)] text-[var(--color-success)]'
                : 'border-[var(--border)] text-[var(--text-muted)]'
            }`}
          >
            {tally.winner
              ? <><span className="font-semibold">{tally.winner === 'a' ? 'Side A' : 'Side B'} wins</span>, {tally.aGamesWon}-{tally.bGamesWon} in games</>
              : <>No winner yet ({tally.aGamesWon}-{tally.bGamesWon} in games). Enter the deciding scores.</>}
          </div>

          <Textarea label="Admin note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onInput={autoGrow} />

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading} disabled={formatInvalid}>Create match</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
