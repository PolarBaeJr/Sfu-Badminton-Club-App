'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog, Select, Textarea, Input } from '@badminton/ui';
import { tallyGames } from '@badminton/shared';
import { resolveDispute } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { createClient } from '@/lib/supabase-browser';

type Game = { game_number: number; side_a_score: number; side_b_score: number };

export function DisputeActions({ disputeId, matchId }: { disputeId: string; matchId: string }) {
  const [open, setOpen] = useState(false);
  const [resType, setResType] = useState<'accepted' | 'edited' | 'voided' | 'converted_to_casual'>('accepted');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  // Scores held as text: with `parseInt(x) || 0` the input snapped back to 0 as
  // soon as it was cleared, so the zero could never be deleted to type over.
  const [editedGames, setEditedGames] = useState<
    { game_number: number; side_a_score: string; side_b_score: string }[]
  >([]);
  const [matchFormat, setMatchFormat] = useState<string>('single_21');
  const [hydrated, setHydrated] = useState(false);
  const { toast } = useToast();

  // The edited winner follows the edited scores. A dispute is usually opened
  // *because* the recorded result is wrong, so an exec correcting the scoreline
  // must not be able to leave a stale winner sitting beside it.
  const editedTally = tallyGames(editedGames);

  useEffect(() => {
    if (!open || hydrated) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data: m } = await supabase
        .from('matches')
        .select('format, match_games(game_number, side_a_score, side_b_score)')
        .eq('id', matchId)
        .single();
      if (cancelled || !m) return;
      const games = ((m.match_games as Game[] | null) ?? []).slice().sort((a, b) => a.game_number - b.game_number);
      const formatStr = (m.format as string) || 'single_21';
      const isBO3 = formatStr === 'bo3_21';
      // Existing scores become text; an unplayed game starts blank rather than
      // pre-filled with 0, which the admin would then have to delete.
      const asText = (g?: Game, n?: number) => ({
        game_number: g?.game_number ?? n ?? 1,
        side_a_score: g ? String(g.side_a_score) : '',
        side_b_score: g ? String(g.side_b_score) : '',
      });
      const filled = isBO3
        ? [1, 2, 3].map((n) => asText(games.find((g) => g.game_number === n), n))
        : [asText(games[0], 1)];
      setEditedGames(filled);
      setMatchFormat(formatStr);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, [open, hydrated, matchId]);

  async function handleResolve() {
    if (!note.trim()) { toast('Resolution note required', 'error'); return; }
    // Built here rather than at the call site so the winner sent is the one
    // these guards proved the corrected games actually produce.
    let edited: { edited_winner_side: 'a' | 'b'; edited_games: ReturnType<typeof toNumericGames> } | undefined;
    if (resType === 'edited') {
      const games = toNumericGames();
      if (games.length === 0) { toast('Enter scores for each game', 'error'); return; }
      if (!editedTally.winner) { toast('Games are level or incomplete — the corrected scores must decide the match', 'error'); return; }
      edited = { edited_winner_side: editedTally.winner, edited_games: games };
    }
    setLoading(true);
    try {
      const res = await resolveDispute({
        dispute_id: disputeId,
        resolution_type: resType,
        resolution_note: note,
        ...edited,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Dispute resolved', 'success');
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // Text state -> the numeric shape the action expects, dropping games that
  // were never played (both sides blank/zero).
  function toNumericGames() {
    return editedGames
      .map((g) => ({
        game_number: g.game_number,
        side_a_score: Number(g.side_a_score || 0),
        side_b_score: Number(g.side_b_score || 0),
      }))
      .filter((g) => g.side_a_score > 0 || g.side_b_score > 0);
  }

  function setGameScore(idx: number, side: 'a' | 'b', value: string) {
    setEditedGames((games) =>
      games.map((g, i) => (i === idx ? { ...g, [side === 'a' ? 'side_a_score' : 'side_b_score']: value } : g))
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Resolve</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Resolve Dispute">
        <div className="space-y-4">
          <Select
            label="Resolution"
            value={resType}
            onChange={(e) => setResType(e.target.value as typeof resType)}
            options={[
              { value: 'accepted', label: 'Accept Result As-Is' },
              { value: 'edited', label: 'Edit Result (change scores)' },
              { value: 'voided', label: 'Void Match' },
              { value: 'converted_to_casual', label: 'Convert to Casual' },
            ]}
          />

          {resType === 'edited' && (
            <div className="space-y-3">
              {editedGames.map((g, i) => (
                <div key={i} className="grid grid-cols-2 gap-3">
                  <Input
                    label={`Game ${g.game_number} — Team A`}
                    type="text"
                    inputMode="numeric"
                    value={g.side_a_score}
                    onChange={(e) => setGameScore(i, 'a', e.target.value.replace(/\D/g, ''))}
                  />
                  <Input
                    label={`Game ${g.game_number} — Team B`}
                    type="text"
                    inputMode="numeric"
                    value={g.side_b_score}
                    onChange={(e) => setGameScore(i, 'b', e.target.value.replace(/\D/g, ''))}
                  />
                </div>
              ))}
              {matchFormat === 'bo3_21' && (
                <p className="text-xs text-[var(--text-muted)]">BO3: leave game 3 at 0–0 if it wasn&apos;t played.</p>
              )}
              {/* Read-only: the corrected scores decide this, and the games
                  tally is shown so a mistyped score reads as a wrong count. */}
              <div className="dialog-group" role="status" aria-live="polite">
                <p className="dialog-group-label">Winner</p>
                <p className={`text-sm font-medium ${editedTally.winner ? 'text-[var(--color-success)]' : 'text-[var(--text-muted)]'}`}>
                  {editedTally.winner
                    ? `${editedTally.winner === 'a' ? 'Team A' : 'Team B'} — ${editedTally.aGamesWon}-${editedTally.bGamesWon} in games`
                    : `Level or incomplete (${editedTally.aGamesWon}-${editedTally.bGamesWon} in games) — enter the deciding scores`}
                </p>
              </div>
            </div>
          )}

          <Textarea label="Resolution Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button onClick={handleResolve} loading={loading}>Resolve</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
