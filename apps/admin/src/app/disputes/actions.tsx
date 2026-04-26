'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog, Select, Textarea, Input } from '@badminton/ui';
import { resolveDispute } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { createClient } from '@/lib/supabase-browser';

type Game = { game_number: number; side_a_score: number; side_b_score: number };

export function DisputeActions({ disputeId, matchId }: { disputeId: string; matchId: string }) {
  const [open, setOpen] = useState(false);
  const [resType, setResType] = useState<'accepted' | 'edited' | 'voided' | 'converted_to_casual'>('accepted');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [editedWinner, setEditedWinner] = useState<'a' | 'b'>('a');
  const [editedGames, setEditedGames] = useState<Game[]>([]);
  const [matchFormat, setMatchFormat] = useState<string>('single_21');
  const [hydrated, setHydrated] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!open || hydrated) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data: m } = await supabase
        .from('matches')
        .select('format, winner_side, match_games(game_number, side_a_score, side_b_score)')
        .eq('id', matchId)
        .single();
      if (cancelled || !m) return;
      const games = ((m.match_games as Game[] | null) ?? []).slice().sort((a, b) => a.game_number - b.game_number);
      const formatStr = (m.format as string) || 'single_21';
      const isBO3 = formatStr === 'bo3_21';
      const filled: Game[] = isBO3
        ? [1, 2, 3].map((n) => games.find((g) => g.game_number === n) ?? { game_number: n, side_a_score: 0, side_b_score: 0 })
        : [games[0] ?? { game_number: 1, side_a_score: 0, side_b_score: 0 }];
      setEditedGames(filled);
      setEditedWinner(((m.winner_side as 'a' | 'b' | null) ?? 'a'));
      setMatchFormat(formatStr);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, [open, hydrated, matchId]);

  async function handleResolve() {
    if (!note.trim()) { toast('Resolution note required', 'error'); return; }
    if (resType === 'edited') {
      const valid = editedGames.every((g) => g.side_a_score >= 0 && g.side_b_score >= 0 && (g.side_a_score > 0 || g.side_b_score > 0));
      if (!valid) { toast('Enter scores for each game', 'error'); return; }
    }
    setLoading(true);
    try {
      await resolveDispute({
        dispute_id: disputeId,
        resolution_type: resType,
        resolution_note: note,
        ...(resType === 'edited' ? { edited_winner_side: editedWinner, edited_games: editedGames } : {}),
      });
      toast('Dispute resolved', 'success');
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  function setGameScore(idx: number, side: 'a' | 'b', value: number) {
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
              <Select
                label="Winner"
                value={editedWinner}
                onChange={(e) => setEditedWinner(e.target.value as 'a' | 'b')}
                options={[
                  { value: 'a', label: 'Team A' },
                  { value: 'b', label: 'Team B' },
                ]}
              />
              {editedGames.map((g, i) => (
                <div key={i} className="grid grid-cols-2 gap-3">
                  <Input
                    label={`Game ${g.game_number} — Team A`}
                    type="number"
                    min={0}
                    value={g.side_a_score}
                    onChange={(e) => setGameScore(i, 'a', parseInt(e.target.value) || 0)}
                  />
                  <Input
                    label={`Game ${g.game_number} — Team B`}
                    type="number"
                    min={0}
                    value={g.side_b_score}
                    onChange={(e) => setGameScore(i, 'b', parseInt(e.target.value) || 0)}
                  />
                </div>
              ))}
              {matchFormat === 'bo3_21' && (
                <p className="text-xs text-[var(--text-muted)]">BO3: leave game 3 at 0–0 if it wasn&apos;t played.</p>
              )}
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
