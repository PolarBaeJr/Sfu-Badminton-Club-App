'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select, Switch, Textarea } from '@badminton/ui';
import {
  tallyGames,
  CUSTOM_FORMAT_BOUNDS,
  customFormatHint,
  isLegalCustomGames,
  isLegalCustomPoints,
} from '@badminton/shared';
import { adminCreateMatch } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

type Player = { id: string; full_name: string };

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
    if (!tally.winner) { toast('Games are level or incomplete — enter the scores that decide the match', 'error'); return; }

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

  const playerOptions = [{ value: '', label: 'Select player...' }, ...players.map(p => ({ value: p.id, label: p.full_name }))];

  return (
    <>
      <Button onClick={() => setOpen(true)}>Enter Match</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Admin Match Entry">
        <form onSubmit={handleCreate} className="space-y-4 max-h-[70vh] overflow-y-auto">
          <Select
            label="Match Type"
            value={matchType}
            onChange={(e) => setMatchType(e.target.value)}
            options={[
              { value: 'singles', label: 'Singles' },
              { value: 'doubles', label: 'Doubles' },
            ]}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Best of (games)"
              type="text"
              inputMode="numeric"
              value={customGames}
              onChange={(e) => {
                const next = e.target.value.replace(/\D/g, '').slice(0, 1);
                setCustomGames(next);
                // Shortening the match must not leave more score rows than it
                // can hold — those rows are submitted, and a best-of-1 with
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
            <p className={`col-span-2 text-xs ${formatInvalid ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}`}>
              {customFormatHint(Number(customGames), Number(customPoints))}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={rated} onChange={setRated} />
            <span className="text-sm text-[var(--text-secondary)]">Rated match</span>
          </div>

          <div className="dialog-group space-y-3">
            <p className="dialog-group-label">Side A</p>
            <Select label="Player 1" value={sideA1} onChange={(e) => setSideA1(e.target.value)} options={playerOptions} />
            {matchType === 'doubles' && (
              <Select label="Player 2" value={sideA2} onChange={(e) => setSideA2(e.target.value)} options={playerOptions} />
            )}
          </div>

          <div className="dialog-group space-y-3">
            <p className="dialog-group-label">Side B</p>
            <Select label="Player 1" value={sideB1} onChange={(e) => setSideB1(e.target.value)} options={playerOptions} />
            {matchType === 'doubles' && (
              <Select label="Player 2" value={sideB2} onChange={(e) => setSideB2(e.target.value)} options={playerOptions} />
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-[var(--text-secondary)]">Games</p>
              <div className="flex gap-2">
                <button type="button" className="stepper-btn" onClick={removeGame} aria-label="Remove game">&minus;</button>
                <button type="button" className="stepper-btn" onClick={addGame} aria-label="Add game">+</button>
              </div>
            </div>
            {games.map((g, i) => (
              <div key={i} className="grid grid-cols-3 gap-2 items-end">
                <span className="text-xs text-[var(--text-muted)] py-2">Game {g.game_number}</span>
                <Input
                  label="A Score"
                  type="number"
                  value={String(g.side_a_score)}
                  onChange={(e) => updateGame(i, 'side_a_score', Number(e.target.value))}
                />
                <Input
                  label="B Score"
                  type="number"
                  value={String(g.side_b_score)}
                  onChange={(e) => updateGame(i, 'side_b_score', Number(e.target.value))}
                />
              </div>
            ))}
          </div>

          {/* Read-only: the scores above already answer this. The tally is shown
              alongside so a typo is visible as a wrong games count, not just as
              a winner the admin has no way to check. */}
          <div className="dialog-group" role="status" aria-live="polite">
            <p className="dialog-group-label">Winner</p>
            <p className={`text-sm font-medium ${tally.winner ? 'text-[var(--color-success)]' : 'text-[var(--text-muted)]'}`}>
              {tally.winner
                ? `${tally.winner === 'a' ? 'Side A' : 'Side B'} — ${tally.aGamesWon}-${tally.bGamesWon} in games`
                : `Level or incomplete (${tally.aGamesWon}-${tally.bGamesWon} in games) — enter the deciding scores`}
            </p>
          </div>

          <Textarea label="Admin Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onInput={autoGrow} />

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading} disabled={formatInvalid}>Create Match</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
