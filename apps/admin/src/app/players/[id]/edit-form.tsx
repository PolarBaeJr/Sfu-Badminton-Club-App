'use client';

import { useState } from 'react';
import { Button, Input, Select, Textarea } from '@badminton/ui';
import { PLAYER_STATUS_LABELS } from '@badminton/shared';
import { updatePlayer, approvePlayer } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import type { Player, Rating } from '@badminton/shared';

export function PlayerEditForm({ player, rating }: { player: Player; rating: Rating | null }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(player.status);
  const [role, setRole] = useState(player.role);
  const [singlesElo, setSinglesElo] = useState(rating?.singles_elo ?? 1200);
  const [doublesElo, setDoublesElo] = useState(rating?.doubles_elo ?? 1200);
  const [reason, setReason] = useState('');

  const isPending = player.status === 'pending_approval';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) { toast('Reason is required', 'error'); return; }
    setLoading(true);

    try {
      if (isPending) {
        await approvePlayer(player.id, status as 'competitive' | 'recreational', reason);
        toast('Player approved', 'success');
      } else {
        await updatePlayer(player.id, {
          status: status !== player.status ? status as Player['status'] : undefined,
          role: role !== player.role ? role as Player['role'] : undefined,
          singles_elo: singlesElo !== (rating?.singles_elo ?? 1200) ? singlesElo : undefined,
          doubles_elo: doublesElo !== (rating?.doubles_elo ?? 1200) ? doublesElo : undefined,
          reason,
        });
        toast('Player updated', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const statusOptions = Object.entries(PLAYER_STATUS_LABELS)
    .filter(([v]) => v !== 'pending_approval')
    .map(([value, label]) => ({ value, label }));

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Select
        label="Status"
        options={statusOptions}
        value={status}
        onChange={(e) => setStatus(e.target.value as Player['status'])}
      />
      <Select
        label="Role"
        options={[
          { value: 'player', label: 'Player' },
          { value: 'admin', label: 'Admin' },
        ]}
        value={role}
        onChange={(e) => setRole(e.target.value as Player['role'])}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Singles Elo"
          type="number"
          value={singlesElo}
          onChange={(e) => setSinglesElo(Number(e.target.value))}
        />
        <Input
          label="Doubles Elo"
          type="number"
          value={doublesElo}
          onChange={(e) => setDoublesElo(Number(e.target.value))}
        />
      </div>
      <Textarea
        label="Reason (required for audit)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Explain the change..."
      />
      <Button type="submit" loading={loading} className="w-full">
        {isPending ? 'Approve Player' : 'Save Changes'}
      </Button>
    </form>
  );
}
