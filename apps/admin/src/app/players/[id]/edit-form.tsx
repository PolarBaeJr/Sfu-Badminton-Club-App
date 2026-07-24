'use client';

import { useState } from 'react';
import { Button, Input, Select, Switch, Textarea } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, MIN_ELO, MAX_ELO } from '@badminton/shared';
import { updatePlayer, approvePlayer } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import type { Player, Rating } from '@badminton/shared';

const ROLE_OPTIONS = [
  { value: 'player', label: 'Player' },
  { value: 'exec', label: 'Executive' },
  { value: 'admin', label: 'Admin' },
  { value: 'admin_exec', label: 'Admin + Executive' },
];

function toRoleValue(role: string, isExec: boolean) {
  if (role === 'admin') return isExec ? 'admin_exec' : 'admin';
  return isExec ? 'exec' : 'player';
}

export function PlayerEditForm({ player, rating }: { player: Player; rating: Rating | null }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(player.status);
  const [roleValue, setRoleValue] = useState(toRoleValue(player.role, player.is_exec ?? false));
  const [singlesElo, setSinglesElo] = useState(rating?.singles_elo ?? 400);
  const [doublesElo, setDoublesElo] = useState(rating?.doubles_elo ?? 400);
  const [execTitle, setExecTitle] = useState(player.exec_title ?? '');
  const [feeExempt, setFeeExempt] = useState(player.fee_exempt ?? false);
  const [reason, setReason] = useState('');

  const isPending = player.status === 'pending_approval';
  const role = roleValue === 'admin' || roleValue === 'admin_exec' ? 'admin' : 'player';
  const isExec = roleValue === 'exec' || roleValue === 'admin_exec';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) { toast('Reason is required', 'error'); return; }
    setLoading(true);

    try {
      if (isPending) {
        const res = await approvePlayer(player.id, status as 'competitive' | 'recreational', reason);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Player approved', 'success');
      } else {
        const res = await updatePlayer(player.id, {
          status: status !== player.status ? status as Player['status'] : undefined,
          role: role !== player.role ? role as Player['role'] : undefined,
          singles_elo: singlesElo !== (rating?.singles_elo ?? 400) ? singlesElo : undefined,
          doubles_elo: doublesElo !== (rating?.doubles_elo ?? 400) ? doublesElo : undefined,
          is_exec: isExec !== (player.is_exec ?? false) ? isExec : undefined,
          exec_title: execTitle !== (player.exec_title ?? '') ? execTitle : undefined,
          fee_exempt: feeExempt !== (player.fee_exempt ?? false) ? feeExempt : undefined,
          reason,
        });
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
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
        options={ROLE_OPTIONS}
        value={roleValue}
        onChange={(e) => setRoleValue(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Singles Elo"
          type="number"
          min={MIN_ELO}
          max={MAX_ELO}
          value={singlesElo}
          onChange={(e) => setSinglesElo(Number(e.target.value))}
        />
        <Input
          label="Doubles Elo"
          type="number"
          min={MIN_ELO}
          max={MAX_ELO}
          value={doublesElo}
          onChange={(e) => setDoublesElo(Number(e.target.value))}
        />
      </div>
      <div className="rounded-lg border border-[var(--border)] p-3 space-y-1">
        {isExec && (
          <Input
            label="Executive title"
            value={execTitle}
            onChange={(e) => setExecTitle(e.target.value)}
            placeholder="e.g. President, VP, Treasurer"
            maxLength={60}
          />
        )}
        <Switch
          label="Fee exempt"
          description="Exempts a non-executive contributor from club and competition fees."
          checked={feeExempt}
          onChange={setFeeExempt}
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
