'use client';

import { useState } from 'react';
import { Button, Input, Select, Switch, Textarea } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, MIN_ELO, MAX_ELO, MEMBERSHIP_TYPES } from '@badminton/shared';
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
}: { player: Player; rating: Rating | null; isAdmin: boolean }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(player.status);
  const [roleValue, setRoleValue] = useState(toRoleValue(player.role, player.is_exec ?? false));
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
  // Its own control rather than another entry in the Role select: is_trainer
  // composes with role and is_exec, so folding it in would need a row per
  // combination (trainer, exec+trainer, admin+trainer, ...).
  const [isTrainer, setIsTrainer] = useState(player.is_trainer ?? false);
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
          // Guarded on presence server-side, so a non-admin must send nothing
          // at all for these — not even an unchanged value.
          role: isAdmin && role !== player.role ? role as Player['role'] : undefined,
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
          is_trainer: isAdmin && isTrainer !== (player.is_trainer ?? false) ? isTrainer : undefined,
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
          label="Role"
          options={ROLE_OPTIONS}
          value={roleValue}
          onChange={(e) => setRoleValue(e.target.value)}
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
        <Switch
          label="Varsity trainer"
          description="Admin console access limited to reading the roster and writing varsity notes. Stacks with Executive or Admin — the higher level wins."
          checked={isTrainer}
          onChange={setIsTrainer}
        />
      </div>
      )}
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
