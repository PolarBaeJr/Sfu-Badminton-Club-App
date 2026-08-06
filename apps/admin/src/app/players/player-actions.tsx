'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Select, Switch, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { PAYMENT_METHODS, PAYMENT_METHOD_CUSTOM, resolvePaymentMethod } from '@badminton/shared';
import { updatePlayer, updatePlayerFlags, approvePlayer, banPlayer, reinstatePlayer, requireWaiverResignature } from '@/lib/actions';

interface Props {
  // One button per mode; /players decides WHICH modes a row gets from the tab
  // it is on (see lib/roster-actions.ts). Every mode here is exec-allowed, so
  // nothing rendered by this component rejects on click.
  mode: 'edit' | 'ban' | 'unban' | 'restore' | 'inactive' | 'assign';
  /** 'assign' only — the division the button puts them in. */
  assignStatus?: 'competitive' | 'recreational';
  playerId: string;
  playerName?: string;
  playerData?: Record<string, unknown>;
  // Execs get the roster controls; role, fee-exempt and the reinstatement fee
  // stay with admins. Server-side guards are the boundary — this only keeps
  // execs from seeing a control that would reject them.
  isAdmin: boolean;
}

// Where a Restore puts someone. Not the full status list: "suspended" and
// "pending approval" are not places to restore INTO, and inactive is the state
// being left. Edit still reaches all four.
const RESTORE_STATUS_OPTIONS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

const STATUS_OPTIONS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'pending_approval', label: 'Pending Approval' },
  // Not a status column value: selecting this clears active_flag. Presented
  // here because "inactive" is how the club thinks of it, and there was no
  // way to set or clear it from the console at all.
  { value: 'inactive', label: 'Inactive' },
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

export function PlayerActions({ mode, assignStatus, playerId, playerName, playerData, isAdmin }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // active_flag=false presents as "Inactive" regardless of the stored status —
  // that is what the badge shows and what the club calls it.
  const [status, setStatus] = useState(
    playerData?.active_flag === false ? 'inactive' : ((playerData?.status as string) || 'pending_approval')
  );
  const [roleValue, setRoleValue] = useState(
    toRoleValue((playerData?.role as string) || 'player', Boolean(playerData?.is_exec), Boolean(playerData?.is_trainer))
  );
  const [feeExempt, setFeeExempt] = useState(Boolean(playerData?.fee_exempt));
  const [isTrainer, setIsTrainer] = useState(Boolean(playerData?.is_trainer));
  const [singlesElo, setSinglesElo] = useState('');
  const [doublesElo, setDoublesElo] = useState('');
  const [reason, setReason] = useState('');
  // Restoring someone needs a division, and their stored status is no guide:
  // removePlayer parks it at 'suspended', so a restore that reused it would
  // drop them straight back into the Suspended tab. Their own status when it is
  // a real division, recreational otherwise — the roster people return to.
  const [restoreStatus, setRestoreStatus] = useState(
    playerData?.status === 'competitive' ? 'competitive' : 'recreational'
  );
  const [banReason, setBanReason] = useState('');
  // Someone coming back after months away should re-sign before playing. Opt-in
  // rather than automatic: a player deactivated by mistake last week does not
  // need to re-sign, and forcing it would block them at the door.
  const [requireResign, setRequireResign] = useState(false);
  const [reinstateAmount, setReinstateAmount] = useState('');
  const [reinstateMethod, setReinstateMethod] = useState('');
  const [reinstateMethodCustom, setReinstateMethodCustom] = useState('');
  const [reinstateReference, setReinstateReference] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  function handleEdit() {
    startTransition(async () => {
      const { role, is_exec: isExec, is_trainer: wantsTrainer } = fromRoleValue(roleValue as ExecRole);
      const roleChanged = role !== ((playerData?.role as string) || 'player');
      try {
        // "Inactive" is active_flag, not a status. Selecting it deactivates and
        // leaves the stored status alone; selecting any real status reactivates,
        // which is the only way back from removePlayer or the nightly
        // mark-inactive-players job.
        const isInactive = status === 'inactive';
        const res = await updatePlayer(playerId, {
          status: isInactive
            ? undefined
            : (status as 'competitive' | 'recreational' | 'suspended' | 'pending_approval'),
          active_flag: isInactive ? false : true,
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

  // Every one of these writes an audit row keyed on the reason typed into its
  // dialog. None of them ships a placeholder: the Save button stays disabled
  // until a real reason is there, because a reason nobody wrote is a reason
  // nobody can read back.
  function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string, failed: string) {
    startTransition(async () => {
      try {
        const res = await work();
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(done, 'success');
        setOpen(false);
        setReason('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : failed, 'error');
      }
    });
  }

  // Back onto the active roster: active_flag AND a division, because
  // active_flag alone would leave a removed player active-but-suspended.
  function handleRestore() {
    run(
      async () => {
        const res = await updatePlayer(playerId, {
          status: restoreStatus as 'competitive' | 'recreational',
          active_flag: true,
          reason,
        });
        // Only after the restore lands: a failed re-signature must not leave
        // them un-restored, and a failed restore must not reset their waiver.
        if (res.ok && requireResign) return requireWaiverResignature(playerId);
        return res;
      },
      requireResign ? 'Player restored — waiver re-signature required' : 'Player restored',
      'Failed to restore player',
    );
  }

  // active_flag only. The stored status is left exactly as it is so a later
  // Restore is a decision, not a guess at what they used to be — and so this
  // never doubles as a suspension.
  function handleDeactivate() {
    run(
      () => updatePlayer(playerId, { active_flag: false, reason }),
      'Player marked inactive',
      'Failed to deactivate player',
    );
  }

  // The Needs Attention tab holds two different situations. Someone who never
  // got in goes through approvePlayer — that is the action that mails them
  // "you're in" and files a player_approved audit row. Someone who was
  // SUSPENDED and is being let back does not get a welcome email or an
  // approval record; that is an ordinary status change.
  function handleAssign() {
    const status = assignStatus ?? 'recreational';
    const isPending = playerData?.status === 'pending_approval';
    run(
      () => (isPending
        ? approvePlayer(playerId, status, reason)
        : updatePlayer(playerId, { status, active_flag: true, reason })),
      isPending ? 'Player approved' : 'Player updated',
      'Failed to update player',
    );
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
          method: resolvePaymentMethod(reinstateMethod, reinstateMethodCustom) || undefined,
          reference: reinstateReference.trim() || undefined,
        });
        // After the unban lands, not before: a failed re-signature must not
        // leave them banned, and a failed unban must not reset their waiver.
        if (requireResign) await requireWaiverResignature(playerId);
        toast('Player unbanned', 'success');
        setOpen(false);
        setReinstateAmount('');
        setReinstateMethod('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to reinstate player', 'error');
      }
    });
  }

  if (mode === 'unban') {
    return (
      <>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Unban</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Unban Player">
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
              <>
                <div className="flex gap-2">
                  <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={reinstateAmount} onChange={(e) => setReinstateAmount(e.target.value)} placeholder="e.g. 20.00" />
                  {/* The same list the club-fees ledger uses, not a second
                      free-text box — "E-transfer" / "etransfer" / "e transfer"
                      is why PAYMENT_METHODS exists. */}
                  <Select
                    label="Method (optional)"
                    options={[{ value: '', label: '—' }, ...PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))]}
                    value={reinstateMethod}
                    onChange={(e) => setReinstateMethod(e.target.value)}
                  />
                </div>
                {reinstateMethod === PAYMENT_METHOD_CUSTOM && (
                  <Input label="Custom method" value={reinstateMethodCustom} onChange={(e) => setReinstateMethodCustom(e.target.value)} placeholder="How was it paid?" />
                )}
                <Input
                  label="Transaction ID (optional)"
                  value={reinstateReference}
                  onChange={(e) => setReinstateReference(e.target.value)}
                  placeholder="e.g. e-transfer confirmation number"
                />
              </>
            )}
            <Switch
              label="Require waiver re-signature"
              description="They re-sign the waiver on their next visit before they can play."
              checked={requireResign}
              onChange={setRequireResign}
            />
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleReinstate} loading={isPending}>Unban</Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  if (mode === 'ban') {
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

  if (mode === 'restore') {
    return (
      <>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Restore</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Restore Player">
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              Put <strong className="text-[var(--text-primary)]">{playerName}</strong> back on the
              active roster. Their history, ratings and waiver are untouched — this only
              reactivates the account and sets which roster they rejoin.
            </p>
            <Select label="Restore to" options={RESTORE_STATUS_OPTIONS} value={restoreStatus} onChange={(e) => setRestoreStatus(e.target.value)} />
            <Switch
              label="Require waiver re-signature"
              description="They re-sign the waiver on their next visit before they can play. Use this for someone who has been away a while."
              checked={requireResign}
              onChange={setRequireResign}
            />
            <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this player being restored?" />
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleRestore} loading={isPending} disabled={reason.trim().length < 2}>
                Restore Player
              </Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  if (mode === 'inactive') {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Inactive</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Mark Player Inactive">
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              Take <strong className="text-[var(--text-primary)]">{playerName}</strong> off the
              active roster. This is not a ban and not a suspension: they keep their status and
              their history, and Restore on the Inactive tab brings them back.
            </p>
            <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this player being deactivated?" />
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleDeactivate} loading={isPending} disabled={reason.trim().length < 2}>
                Mark Inactive
              </Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  if (mode === 'assign') {
    const label = assignStatus === 'competitive' ? 'Competitive' : 'Recreational';
    const wasPending = playerData?.status === 'pending_approval';
    return (
      <>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{label}</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title={`Move to ${label}`}>
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              {wasPending ? 'Approve' : 'Move'}{' '}
              <strong className="text-[var(--text-primary)]">{playerName}</strong> into the {label.toLowerCase()} roster and activate the account.
              {wasPending && ' They will be emailed that they are in.'}
            </p>
            <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Why is this player being moved to ${label.toLowerCase()}?`} />
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleAssign} loading={isPending} disabled={reason.trim().length < 2}>
                {wasPending ? 'Approve' : 'Move'} to {label}
              </Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  // Edit — the only control that still reaches every field, including the
  // 'inactive' pseudo-status and (for an admin) role and ratings.
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
