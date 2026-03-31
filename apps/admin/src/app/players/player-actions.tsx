'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Select, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { updatePlayer, removePlayer } from '@/lib/actions';

interface Props {
  mode: 'edit' | 'delete';
  playerId: string;
  playerName?: string;
  playerData?: Record<string, unknown>;
}

const STATUS_OPTIONS = [
  { value: 'eligible_competitive', label: 'Eligible Competitive' },
  { value: 'competitive_associate', label: 'Competitive Associate' },
  { value: 'recreational', label: 'Recreational' },
  { value: 'alumni_external', label: 'Alumni / External' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'pending_approval', label: 'Pending Approval' },
];

const ROLE_OPTIONS = [
  { value: 'player', label: 'Player' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'admin', label: 'Admin' },
  { value: 'coach_executive', label: 'Coach / Executive' },
];

export function PlayerActions({ mode, playerId, playerName, playerData }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState((playerData?.status as string) || 'pending_approval');
  const [role, setRole] = useState((playerData?.role as string) || 'player');
  const [eligible, setEligible] = useState(playerData?.eligibility_flag !== false);
  const [singlesElo, setSinglesElo] = useState('');
  const [doublesElo, setDoublesElo] = useState('');
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  function handleEdit() {
    startTransition(async () => {
      try {
        await updatePlayer(playerId, {
          status: status as 'eligible_competitive' | 'competitive_associate' | 'recreational' | 'alumni_external' | 'suspended' | 'inactive' | 'pending_approval',
          role: role as 'player' | 'moderator' | 'admin' | 'coach_executive',
          eligibility_flag: eligible,
          singles_elo: singlesElo ? parseInt(singlesElo) : undefined,
          doubles_elo: doublesElo ? parseInt(doublesElo) : undefined,
          reason,
        });
        toast('Player updated', 'success');
        setOpen(false);
        setReason('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to update player', 'error');
      }
    });
  }

  function handleDelete() {
    startTransition(async () => {
      try {
        await removePlayer(playerId, reason || 'Removed by admin');
        toast('Player removed', 'success');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to remove player', 'error');
      }
    });
  }

  if (mode === 'edit') {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Edit</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Edit Player">
          <div className="space-y-4">
            <Select label="Status" options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
            <Select label="Role" options={ROLE_OPTIONS} value={role} onChange={(e) => setRole(e.target.value)} />
            <div className="flex items-center gap-2">
              <label className="text-sm text-[var(--text-secondary)]">Eligible</label>
              <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
            </div>
            <div className="flex gap-2">
              <Input label="Singles Elo (optional)" type="number" value={singlesElo} onChange={(e) => setSinglesElo(e.target.value)} placeholder="Leave blank to keep current" />
              <Input label="Doubles Elo (optional)" type="number" value={doublesElo} onChange={(e) => setDoublesElo(e.target.value)} placeholder="Leave blank to keep current" />
            </div>
            <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this change being made?" />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleEdit} loading={isPending} className="flex-1" disabled={!reason || reason.length < 2}>
                Save Changes
              </Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  // Delete mode
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Remove</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Remove Player">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            This will deactivate <strong className="text-[var(--text-primary)]">{playerName}</strong> and mark them as inactive.
          </p>
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this player being removed?" />
          <Input
            label={`Type "${playerName}" to confirm`}
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={playerName}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              loading={isPending}
              className="flex-1"
              disabled={confirmName !== playerName}
            >
              Remove Player
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
