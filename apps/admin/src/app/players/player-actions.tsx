'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Select, Switch, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { PAYMENT_METHODS, PAYMENT_METHOD_CUSTOM, resolvePaymentMethod } from '@badminton/shared';
import { removePlayer, updatePlayer, updatePlayerFlags, approvePlayer, banPlayer, reinstatePlayer, requireWaiverResignature } from '@/lib/actions';
import { isApprovalEdit } from '@/lib/player-approval';
// Shared with /permissions, which asks the same question about the same three
// columns. See lib/console-access.ts for why it is one mapping and not two.
import { EXEC_ROLE_OPTIONS, fromRoleValue, toRoleValue, type ExecRole } from '@/lib/console-access';

interface Props {
  // One button per mode; /players decides WHICH modes a row gets from the tab
  // it is on (see lib/roster-actions.ts). Every mode here is exec-allowed, so
  // nothing rendered by this component rejects on click.
  mode: 'edit' | 'ban' | 'unban' | 'restore' | 'inactive' | 'remove';
  playerId: string;
  playerName?: string;
  playerData?: Record<string, unknown>;
  // Execs get the roster controls; role, fee-exempt and the reinstatement fee
  // stay with admins. Server-side guards are the boundary — this only keeps
  // execs from seeing a control that would reject them.
  isAdmin: boolean;
  // APPROVING AND EDITING ARE ONE SAVE, and they are two capabilities. Picking
  // a division for a pending signup goes through approvePlayer rather than
  // updatePlayer (see lib/player-approval.ts), so somebody holding
  // players.update.write without players.approve.write would be offered a
  // Status select whose only outcome is a refusal. It cannot be removed
  // entirely without splitting the dialog; locking that one control and saying
  // why is the honest version.
  canApprove: boolean;
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
  { value: 'pending_approval', label: 'Pending Approval' },
  // Not a status column value: selecting this clears active_flag. Presented
  // here because "inactive" is how the club thinks of it, and there was no
  // way to set or clear it from the console at all.
  { value: 'inactive', label: 'Inactive' },
];

export function PlayerActions({ mode, playerId, playerName, playerData, isAdmin, canApprove }: Props) {
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

  const approvalBlocked = playerData?.status === 'pending_approval' && !canApprove;

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
        // Everything except the status/active_flag pair, which the approval
        // branch below writes through approvePlayer instead.
        const fields = {
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
        };
        // Letting a pending signup in belongs to approvePlayer, not
        // updatePlayer — see lib/player-approval.ts for why. Edit is the only
        // control the Needs Attention tab has left, so if Edit did not make
        // this choice, approving somebody would quietly stop emailing them and
        // stop being recorded anywhere.
        const approving = isApprovalEdit(playerData?.status as string | undefined, status);
        // Belt as well as braces: the Status select below is locked when this
        // is true, but a client-side lock is a rendering decision and the
        // refusal it prevents is worth spelling out here too.
        if (approving && !canApprove) {
          toast('Letting a pending signup in is a separate permission you do not hold.', 'error');
          return;
        }
        const res = approving
          ? await approvePlayer(playerId, status, reason)
          : await updatePlayer(playerId, {
              status: isInactive
                ? undefined
                : (status as 'competitive' | 'recreational' | 'suspended' | 'pending_approval'),
              active_flag: isInactive ? false : true,
              ...fields,
              reason,
            });
        if (!res.ok) { toast(res.error, 'error'); return; }
        // approvePlayer writes status and active_flag and nothing else, so an
        // admin who set a role or a rating in the same Save still needs the
        // ordinary update afterwards.
        if (approving && Object.values(fields).some((v) => v !== undefined)) {
          const rest = await updatePlayer(playerId, { ...fields, reason });
          if (!rest.ok) { toast(rest.error, 'error'); return; }
        }
        // updatePlayerFlags is admin-only (is_exec + fee_exempt). For an exec
        // the two controls are not rendered and the state still mirrors
        // playerData, so this comparison is false and the call never fires —
        // otherwise the save would half-succeed and then throw.
        if (isAdmin && (isExec !== Boolean(playerData?.is_exec) || feeExempt !== Boolean(playerData?.fee_exempt))) {
          await updatePlayerFlags(playerId, { is_exec: isExec, fee_exempt: feeExempt });
        }
        toast(approving ? 'Player approved' : 'Player updated', 'success');
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
                : ' Recording a reinstatement fee is admin-only. Go ahead and unban — if money changed hands, an admin records it afterwards from the Fees page.'}
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

  if (mode === 'remove') {
    return (
      <>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Remove</Button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Remove Player">
          <div className="space-y-4">
            <p className="text-[var(--text-secondary)]">
              Take <strong className="text-[var(--text-primary)]">{playerName}</strong> off the
              roster. Their history and ratings are kept — this suspends the account and
              deactivates it. Use <strong className="text-[var(--text-primary)]">Ban</strong>
              {' '}instead if this is disciplinary.
            </p>
            <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this player being removed?" />
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => run(() => removePlayer(playerId, reason), 'Player removed', 'Failed to remove player')}
                loading={isPending}
                disabled={reason.trim().length < 2}
              >
                Remove Player
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

  // Edit — the only control that still reaches every field, including the
  // 'inactive' pseudo-status and (for an admin) role and ratings. It is also
  // the whole of the Needs Attention tab: picking a division here for a pending
  // signup approves them.
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Edit</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit Player">
        <div className="space-y-4">
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={status}
            disabled={approvalBlocked}
            onChange={(e) => setStatus(e.target.value)}
          />
          {approvalBlocked && (
            <p className="text-xs text-[var(--color-danger)]">
              This member is waiting to be approved, and letting them in is a separate permission
              you do not hold. Ask an admin.
            </p>
          )}
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
