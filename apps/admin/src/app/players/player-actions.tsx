'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Select, Switch, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { updatePlayer, updatePlayerFlags, removePlayer, banPlayer, reinstatePlayer } from '@/lib/actions';

interface Props {
  mode: 'edit' | 'delete' | 'ban';
  playerId: string;
  playerName?: string;
  playerData?: Record<string, unknown>;
  // Execs get the roster controls; role, fee-exempt, removal and the
  // reinstatement fee stay with admins. Server-side guards are the boundary —
  // this only keeps execs from seeing a control that would reject them.
  isAdmin: boolean;
}

const STATUS_OPTIONS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'pending_approval', label: 'Pending Approval' },
];

// ONE question — what console access does this person have — instead of a
// role select, an is_exec flag and a trainer switch that had to be combined in
// the reader's head. "Admin + Executive" is gone because admin already outranks
// exec everywhere (accessLevelFor resolves the highest level held, and
// atLeast() orders admin > exec > trainer), so the pair was never a distinct
// state — only a way to get it wrong.
const EXEC_ROLE_OPTIONS = [
  { value: 'none', label: 'None — ordinary member' },
  { value: 'executive', label: 'Executive' },
  { value: 'trainer', label: 'Varsity trainer' },
  { value: 'admin', label: 'Admin' },
];

type ExecRole = 'none' | 'executive' | 'trainer' | 'admin';

function toRoleValue(role: string, isExec: boolean, isTrainer: boolean): ExecRole {
  if (role === 'admin') return 'admin';
  if (isExec) return 'executive';
  if (isTrainer) return 'trainer';
  return 'none';
}

// Admin implies is_exec: an admin already has every exec power, and the club's
// admin sits on the exec team, so they belong on the public /exec page too.
function fromRoleValue(v: ExecRole): { role: 'player' | 'admin'; is_exec: boolean; is_trainer: boolean } {
  switch (v) {
    case 'admin':     return { role: 'admin',  is_exec: true,  is_trainer: false };
    case 'executive': return { role: 'player', is_exec: true,  is_trainer: false };
    case 'trainer':   return { role: 'player', is_exec: false, is_trainer: true };
    default:          return { role: 'player', is_exec: false, is_trainer: false };
  }
}

export function PlayerActions({ mode, playerId, playerName, playerData, isAdmin }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState((playerData?.status as string) || 'pending_approval');
  const [roleValue, setRoleValue] = useState(
    toRoleValue((playerData?.role as string) || 'player', Boolean(playerData?.is_exec), Boolean(playerData?.is_trainer))
  );
  const [feeExempt, setFeeExempt] = useState(Boolean(playerData?.fee_exempt));
  const [isTrainer, setIsTrainer] = useState(Boolean(playerData?.is_trainer));
  const [singlesElo, setSinglesElo] = useState('');
  const [doublesElo, setDoublesElo] = useState('');
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [banReason, setBanReason] = useState('');
  const [reinstateAmount, setReinstateAmount] = useState('');
  const [reinstateMethod, setReinstateMethod] = useState('');
  const { toast } = useToast();
  const router = useRouter();
  const isBanned = Boolean(playerData?.is_banned);

  function handleEdit() {
    startTransition(async () => {
      const { role, is_exec: isExec, is_trainer: wantsTrainer } = fromRoleValue(roleValue as ExecRole);
      const roleChanged = role !== ((playerData?.role as string) || 'player');
      try {
        const res = await updatePlayer(playerId, {
          status: status as 'competitive' | 'recreational' | 'suspended' | 'pending_approval',
          // Only sent when it actually changed. The server guard rejects a
          // non-admin who supplies `role` AT ALL, so sending it unconditionally
          // — as this dialog used to — would fail every exec's Save even when
          // they only touched the status.
          role: isAdmin && roleChanged ? (role as 'player' | 'admin') : undefined,
          // Admin-only: a hand-set rating bypasses the engine's K factors,
          // bounds and margin rules.
          singles_elo: isAdmin && singlesElo ? parseInt(singlesElo) : undefined,
          doubles_elo: isAdmin && doublesElo ? parseInt(doublesElo) : undefined,
          // Same "only when it changed" rule as `role` above: the server guard
          // rejects a non-admin who supplies this key at all, so sending it
          // unconditionally would break every exec's Save.
          is_trainer:
            isAdmin && wantsTrainer !== Boolean(playerData?.is_trainer) ? wantsTrainer : undefined,
          reason,
        });
        if (!res.ok) { toast(res.error, 'error'); return; }
        // updatePlayerFlags is admin-only (is_exec + fee_exempt). For an exec
        // the two controls are not rendered and the state still mirrors
        // playerData, so this comparison is false and the call never fires —
        // otherwise the save would half-succeed and then throw.
        if (isAdmin && (isExec !== Boolean(playerData?.is_exec) || feeExempt !== Boolean(playerData?.fee_exempt))) {
          await updatePlayerFlags(playerId, { is_exec: isExec, fee_exempt: feeExempt });
        }
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
        const res = await removePlayer(playerId, reason || 'Removed by admin');
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast('Player removed', 'success');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to remove player', 'error');
      }
    });
  }

  function handleBan() {
    startTransition(async () => {
      try {
        await banPlayer({ player_id: playerId, reason: banReason });
        toast('Player banned', 'success');
        setOpen(false);
        setBanReason('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to ban player', 'error');
      }
    });
  }

  function handleReinstate() {
    startTransition(async () => {
      try {
        const dollars = reinstateAmount ? parseFloat(reinstateAmount) : undefined;
        await reinstatePlayer({
          player_id: playerId,
          amount_cents: dollars != null && !Number.isNaN(dollars) ? Math.round(dollars * 100) : undefined,
          method: reinstateMethod || undefined,
        });
        toast('Player reinstated', 'success');
        setOpen(false);
        setReinstateAmount('');
        setReinstateMethod('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to reinstate player', 'error');
      }
    });
  }

  if (mode === 'ban') {
    if (isBanned) {
      return (
        <>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Reinstate</Button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Reinstate Player">
            <div className="space-y-4">
              <p className="text-[var(--text-secondary)]">
                Lift the ban on <strong className="text-[var(--text-primary)]">{playerName}</strong>.
                {isAdmin
                  ? ' Recording an amount is optional (leave blank for a free reinstatement).'
                  : ' Recording a reinstatement fee is admin-only — ask an admin if money changed hands.'}
              </p>
              {/* Money stays with admins even though the unban itself does not:
                  this writes a reinstatement_fees row into the admin-only fees
                  ledger. The server action rejects the fields too. */}
              {isAdmin && (
                <div className="flex gap-2">
                  <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={reinstateAmount} onChange={(e) => setReinstateAmount(e.target.value)} placeholder="e.g. 20.00" />
                  <Input label="Method (optional)" value={reinstateMethod} onChange={(e) => setReinstateMethod(e.target.value)} placeholder="e.g. e-transfer, cash" />
                </div>
              )}
              <div className="flex items-center justify-between">
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleReinstate} loading={isPending}>Reinstate</Button>
              </div>
            </div>
          </Dialog>
        </>
      );
    }
    return (
      <>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Ban</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Ban Player">
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              Ban <strong className="text-[var(--text-primary)]">{playerName}</strong>. They will need to be reinstated (with an optional fee) to return.
            </p>
            <Textarea label="Reason" value={banReason} onChange={(e) => setBanReason(e.target.value)} placeholder="Why is this player being banned?" />
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={handleBan} loading={isPending} disabled={banReason.trim().length < 2}>
                Ban Player
              </Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  if (mode === 'edit') {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Edit</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Edit Player">
          <div className="space-y-4">
            <Select label="Status" options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
            {isAdmin && (
              <>
                <Select label="Console access" options={EXEC_ROLE_OPTIONS} value={roleValue} onChange={(e) => setRoleValue(e.target.value as ExecRole)} />
                <Switch label="Fee Exempt" description="Exempted from the club fee (no gameplay effect)" checked={feeExempt} onChange={setFeeExempt} />
              </>
            )}
            {isAdmin && (
              <div className="flex gap-2">
                <Input label="Singles Elo (optional)" type="number" value={singlesElo} onChange={(e) => setSinglesElo(e.target.value)} placeholder="Leave blank to keep current" />
                <Input label="Doubles Elo (optional)" type="number" value={doublesElo} onChange={(e) => setDoublesElo(e.target.value)} placeholder="Leave blank to keep current" />
              </div>
            )}
            <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this change being made?" />
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleEdit} loading={isPending} disabled={!reason || reason.length < 2}>
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
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              loading={isPending}
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
