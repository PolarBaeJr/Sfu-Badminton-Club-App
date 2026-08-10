'use client';

import { useState } from 'react';
import { Button, Input, Select, Switch, Textarea } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, MIN_ELO, MAX_ELO, MEMBERSHIP_TYPES } from '@badminton/shared';
import { updatePlayer, approvePlayer } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import type { Player, Rating } from '@badminton/shared';

// One question — what console access does this person have — instead of a role
// select plus an is_exec flag plus a trainer switch. "Admin + Executive" is gone
// because admin already outranks exec everywhere (accessLevelFor takes the
// highest level held), so the pair was never a distinct state.
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

// Admin implies is_exec: they hold every exec power already, and the club's
// admin sits on the exec team, so they belong on the public /exec page too.
function fromRoleValue(v: ExecRole): { role: 'player' | 'admin'; is_exec: boolean; is_trainer: boolean } {
  switch (v) {
    case 'admin':     return { role: 'admin',  is_exec: true,  is_trainer: false };
    case 'executive': return { role: 'player', is_exec: true,  is_trainer: false };
    case 'trainer':   return { role: 'player', is_exec: false, is_trainer: true };
    default:          return { role: 'player', is_exec: false, is_trainer: false };
  }
}

// isAdmin gates the privilege/money block: role, exec title, exec photo,
// fee-exempt and the varsity-trainer marker. Execs keep status and membership.
// The server action rejects the admin-only fields outright, so an exec must
// never be shown a control that sends one.
//
// A varsity trainer never sees this form at all — the whole card is dropped on
// the detail page, because updatePlayer does not admit them.
export function PlayerEditForm({
  player,
  rating,
  isAdmin,
  canApprove,
}: {
  player: Player;
  rating: Rating | null;
  isAdmin: boolean;
  // APPROVING AND EDITING ARE ONE SAVE, and they are two capabilities. This
  // form calls approvePlayer for a pending signup and updatePlayer for everyone
  // else, so somebody holding players.update.write without
  // players.approve.write would be shown a form whose only outcome is a
  // refusal. It cannot be fully removed without splitting the form; disabling
  // it and saying why is the honest version.
  canApprove: boolean;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(player.status);
  const [roleValue, setRoleValue] = useState<ExecRole>(toRoleValue(player.role, player.is_exec ?? false, player.is_trainer ?? false));
  const [membershipType, setMembershipType] = useState(
    (player as { membership_type?: string }).membership_type ?? 'internal',
  );
  const [singlesElo, setSinglesElo] = useState(rating?.singles_elo ?? 400);
  const [doublesElo, setDoublesElo] = useState(rating?.doubles_elo ?? 400);
  const [execTitle, setExecTitle] = useState(player.exec_title ?? '');
  const [execPhotoUrl, setExecPhotoUrl] = useState(
    (player as { exec_photo_url?: string | null }).exec_photo_url ?? '',
  );
  const [feeExempt, setFeeExempt] = useState(player.fee_exempt ?? false);
  const [reason, setReason] = useState('');

  const isPending = player.status === 'pending_approval';
  const approvalBlocked = isPending && !canApprove;
  const { role: nextRole, is_exec: isExec, is_trainer: wantsTrainer } = fromRoleValue(roleValue);

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
          // Guarded on presence server-side, so a non-admin must send nothing
          // at all for these — not even an unchanged value.
          role: isAdmin && nextRole !== player.role ? nextRole as Player['role'] : undefined,
          membership_type:
            membershipType !== ((player as { membership_type?: string }).membership_type ?? 'internal')
              ? (membershipType as 'internal' | 'alumni' | 'external')
              : undefined,
          // Ratings are admin-only: a hand-edited number bypasses every K
          // factor, bound and margin rule the engine applies.
          singles_elo: isAdmin && singlesElo !== (rating?.singles_elo ?? 400) ? singlesElo : undefined,
          doubles_elo: isAdmin && doublesElo !== (rating?.doubles_elo ?? 400) ? doublesElo : undefined,
          is_exec: isAdmin && isExec !== (player.is_exec ?? false) ? isExec : undefined,
          // Sent ONLY when an admin actually changed it. The server guard
          // rejects a non-admin who supplies the key at all, so an
          // unconditional `is_trainer: false` would fail every exec's Save —
          // exactly the bug `role` had (see actions/players.ts).
          is_trainer: isAdmin && wantsTrainer !== (player.is_trainer ?? false) ? wantsTrainer : undefined,
          exec_title: isAdmin && execTitle !== (player.exec_title ?? '') ? execTitle : undefined,
          exec_photo_url:
            isAdmin && execPhotoUrl !== ((player as { exec_photo_url?: string | null }).exec_photo_url ?? '')
              ? execPhotoUrl
              : undefined,
          fee_exempt: isAdmin && feeExempt !== (player.fee_exempt ?? false) ? feeExempt : undefined,
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
      {isAdmin && (
        <Select
          label="Console access"
          options={EXEC_ROLE_OPTIONS}
          value={roleValue}
          onChange={(e) => setRoleValue(e.target.value as ExecRole)}
        />
      )}
      {/* Separate from Role on purpose: an exec is still an internal member,
          so promoting someone must not change which events they can enter. */}
      <Select
        label="Membership"
        options={MEMBERSHIP_TYPES.map((m) => ({ value: m.value, label: m.label }))}
        value={membershipType}
        onChange={(e) => setMembershipType(e.target.value)}
      />
      <p className="text-xs text-[var(--text-muted)] -mt-2">
        {MEMBERSHIP_TYPES.find((m) => m.value === membershipType)?.description}
      </p>
      {isAdmin && (
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
      )}
      {isAdmin && (
      <div className="rounded-lg border border-[var(--border)] p-3 space-y-1">
        {isExec && (
          <>
            <Input
              label="Executive title"
              value={execTitle}
              onChange={(e) => setExecTitle(e.target.value)}
              placeholder="e.g. President, VP, Treasurer"
              maxLength={60}
            />
            {/* Separate from their profile avatar on purpose — this is the
                club's public-facing page, and it should not change because
                someone updated their ladder picture. */}
            <Input
              label="Exec photo URL"
              value={execPhotoUrl}
              onChange={(e) => setExecPhotoUrl(e.target.value)}
              placeholder="https://…"
              maxLength={500}
            />
            <p className="text-xs text-[var(--text-muted)]">
              Shown on the public exec page, along with this member&apos;s bio. Falls
              back to their initials if left blank. Their profile avatar is never used here.
            </p>
          </>
        )}
        <Switch
          label="Fee exempt"
          description="Exempts a non-executive contributor from club and competition fees."
          checked={feeExempt}
          onChange={setFeeExempt}
        />
      </div>
      )}
      <Textarea
        label="Reason (required for audit)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Explain the change..."
      />
      {approvalBlocked && (
        <p className="text-xs text-[var(--color-danger)]">
          This member is waiting to be approved, and letting them in is a separate permission
          you do not hold. Ask an admin.
        </p>
      )}
      <Button type="submit" loading={loading} className="w-full" disabled={approvalBlocked}>
        {isPending ? 'Approve Player' : 'Save Changes'}
      </Button>
    </form>
  );
}
