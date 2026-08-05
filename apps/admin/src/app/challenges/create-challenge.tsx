'use client';

import { useState } from 'react';
import { Button, Dialog, Input, PlayerPicker, Select, Switch, Textarea, DatePicker } from '@badminton/ui';
import { adminCreateChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

type Player = { id: string; full_name: string; avatar_url?: string | null };

export function CreateChallengeForm({ players }: { players: Player[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [type, setType] = useState('singles');
  const [format, setFormat] = useState('single_21');
  const [rated, setRated] = useState(true);
  const [sideA1, setSideA1] = useState('');
  const [sideA2, setSideA2] = useState('');
  const [sideB1, setSideB1] = useState('');
  const [sideB2, setSideB2] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [note, setNote] = useState('');
  const { toast } = useToast();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!sideA1 || !sideB1) { toast('Select players for both sides', 'error'); return; }
    if (type === 'doubles' && (!sideA2 || !sideB2)) { toast('Doubles requires 2 players per side', 'error'); return; }

    const sideAPlayers = type === 'doubles' ? [sideA1, sideA2] : [sideA1];
    const sideBPlayers = type === 'doubles' ? [sideB1, sideB2] : [sideB1];

    setLoading(true);
    try {
      const res = await adminCreateChallenge({
        type,
        format,
        rated_flag: rated,
        side_a_players: sideAPlayers,
        side_b_players: sideBPlayers,
        scheduled_date: scheduledDate || undefined,
        scheduled_time: scheduledTime || undefined,
        note: note || undefined,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Challenge created', 'success');
      setOpen(false);
      setSideA1(''); setSideA2(''); setSideB1(''); setSideB2('');
      setScheduledDate(''); setScheduledTime(''); setNote('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const playerOptions = players.map(p => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url }));

  return (
    <>
      <Button onClick={() => setOpen(true)}>New Challenge</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Challenge (Admin)">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value)}
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
            <span className="text-sm text-[var(--text-secondary)]">Rated</span>
          </div>

          {/* role=group ties the two pickers to their side heading — without it a
              screen reader hears "Player 1" twice with nothing to tell them apart. */}
          <div className="border border-[var(--border)] rounded-lg p-3 space-y-3" role="group" aria-labelledby="challenge-side-a">
            <p className="text-xs font-medium text-[var(--text-muted)] uppercase" id="challenge-side-a">Side A</p>
            <PlayerPicker label="Player 1" value={sideA1} onChange={setSideA1} players={playerOptions} />
            {type === 'doubles' && (
              <PlayerPicker label="Player 2" value={sideA2} onChange={setSideA2} players={playerOptions} />
            )}
          </div>

          <div className="border border-[var(--border)] rounded-lg p-3 space-y-3" role="group" aria-labelledby="challenge-side-b">
            <p className="text-xs font-medium text-[var(--text-muted)] uppercase" id="challenge-side-b">Side B</p>
            <PlayerPicker label="Player 1" value={sideB1} onChange={setSideB1} players={playerOptions} />
            {type === 'doubles' && (
              <PlayerPicker label="Player 2" value={sideB2} onChange={setSideB2} players={playerOptions} />
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <DatePicker label="Date (optional)" value={scheduledDate} onChange={setScheduledDate} />
            <Input label="Time (optional)" type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
          </div>

          <Textarea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />

          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Create Challenge</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
