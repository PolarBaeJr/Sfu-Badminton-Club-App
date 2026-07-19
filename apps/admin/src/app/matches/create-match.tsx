'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select, Switch, Textarea } from '@badminton/ui';
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
  const [format, setFormat] = useState('single_21');
  const [rated, setRated] = useState(true);
  const [sideA1, setSideA1] = useState('');
  const [sideA2, setSideA2] = useState('');
  const [sideB1, setSideB1] = useState('');
  const [sideB2, setSideB2] = useState('');
  const [winnerSide, setWinnerSide] = useState('a');
  const [games, setGames] = useState([{ game_number: 1, side_a_score: 0, side_b_score: 0 }]);
  const [note, setNote] = useState('');
  const { toast } = useToast();

  function addGame() {
    if (games.length >= 3) return;
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

    const sideAPlayers = matchType === 'doubles' ? [sideA1, sideA2] : [sideA1];
    const sideBPlayers = matchType === 'doubles' ? [sideB1, sideB2] : [sideB1];

    setLoading(true);
    try {
      await adminCreateMatch({
        match_type: matchType,
        format,
        rated_flag: rated,
        side_a_players: sideAPlayers,
        side_b_players: sideBPlayers,
        winner_side: winnerSide,
        games,
        admin_note: note || undefined,
      });
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
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Match Type"
              value={matchType}
              onChange={(e) => setMatchType(e.target.value)}
              options={[
                { value: 'singles', label: 'Singles' },
                { value: 'doubles', label: 'Doubles' },
              ]}
            />
            <Select
              label="Format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              options={[
                { value: 'bo3_21', label: 'Best of 3 to 21' },
                { value: 'single_21', label: '1 Game to 21' },
                { value: 'single_15', label: '1 Game to 15' },
                { value: 'single_11', label: '1 Game to 11' },
              ]}
            />
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

          <Select
            label="Winner"
            value={winnerSide}
            onChange={(e) => setWinnerSide(e.target.value)}
            options={[
              { value: 'a', label: 'Side A' },
              { value: 'b', label: 'Side B' },
            ]}
          />

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

          <Textarea label="Admin Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} onInput={autoGrow} />

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading}>Create Match</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
