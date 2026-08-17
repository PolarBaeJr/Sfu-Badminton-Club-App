'use client';

import { useState } from 'react';
import { Button, Input, Select, Switch, Textarea } from '@badminton/ui';
import {
  PLAYER_STATUS_LABELS,
  MIN_ELO,
  MAX_ELO,
  MEMBERSHIP_TYPES,
  COMPETITION_CATEGORY_CHOICES,
  toCompetitionCategory,
  type CompetitionCategory,
} from '@badminton/shared';
import { updatePlayer, approvePlayer } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import type { Player, Rating } from '@badminton/shared';

// NO CONSOLE-ACCESS CONTROL HERE ANY MORE. This form used to carry a "Console
// access" select between Status and Membership, mapping four answers onto
// role / is_exec / is_trainer and posting them through updatePlayer. The club
// owner: "i dont think the console access should be there anymore… since execs
// wouldnt require it anymore… as its only admins who will be mainly editing
// permissions."
//
// It is decided on /permissions instead, through setConsoleAccess, which is the
// only place that refuses a self-edit, refuses a non-admin touching an admin,
// checks grant closure on the target's whole resolved set both before and after,
// and clears a stored composition the new level would strand. This form had none
// of that — it had `isAdmin`, and a reason box.
//
// REMOVING THE CONTROL IS THE COSMETIC HALF. updatePlayer refuses the three
// columns outright now (assertNoConsoleAccessFields), for admins too, so this is
// not a control that merely stopped being drawn.

// isAdmin gates the money/ladder block: ratings, the exec bio fields and
// fee-exempt. Execs keep status, membership and the category correction.
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
  // 00129 — the member's Gender. THE CONSOLE IS THE ONLY PLACE IT CAN CHANGE
  // once the member has declared one: a database trigger refuses their own
  // second write, including a clear, so this control is the whole remedy for a
  // wrong answer.
  //
  // The value is already on `player` — the detail page fetches the row with
  // createAdminClient().select('*'), the service-role key, which is not subject
  // to the column grants. Nothing was added to that select and NO SELECT GRANT
  // WAS ADDED for it; see 00111 on why granting one to `authenticated` would
  // publish every member's answer to the whole club.
  const [category, setCategory] = useState<CompetitionCategory | ''>(
    toCompetitionCategory((player as { competition_category?: unknown }).competition_category) ?? '',
  );
  const [reason, setReason] = useState('');

  const isPending = player.status === 'pending_approval';
  const approvalBlocked = isPending && !canApprove;
  // Read off the STORED row rather than off a control, because the control that
  // used to decide it is gone. The exec bio fields below are only meaningful on
  // somebody who is already on the exec team, and whether they are is now settled
  // on /permissions before this form is opened.
  const isExec = player.is_exec ?? false;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) { toast('Reason is required', 'error'); return; }
    setLoading(true);

    // EVERYTHING EXCEPT STATUS, which the approval branch below writes through
    // approvePlayer instead. Lifted out of the update call so that BOTH branches
    // can send it: an approval used to take this whole object with it, so an exec
    // who fixed somebody's Gender while letting them in was told "Player
    // approved" and the correction was never written. Nothing said so, and 00129
    // makes the console the only route to that column — the member cannot change
    // their own answer a second time, so a silently dropped write there has no
    // other remedy.
    //
    // Every field is sent ONLY when it actually changed. The server guard is on
    // PRESENCE, not on value, so a non-admin must send nothing at all for an
    // admin-only field — not even an unchanged value.
    //
    // role / is_exec / is_trainer are absent from this payload and from
    // adminPlayerUpdateSchema: they are console access, and console access is set
    // on /permissions.
    const changes = {
      membership_type:
        membershipType !== ((player as { membership_type?: string }).membership_type ?? 'internal')
          ? (membershipType as 'internal' | 'alumni' | 'external')
          : undefined,
      // Ratings are admin-only: a hand-edited number bypasses every K
      // factor, bound and margin rule the engine applies.
      singles_elo: isAdmin && singlesElo !== (rating?.singles_elo ?? 400) ? singlesElo : undefined,
      doubles_elo: isAdmin && doublesElo !== (rating?.doubles_elo ?? 400) ? doublesElo : undefined,
      exec_title: isAdmin && execTitle !== (player.exec_title ?? '') ? execTitle : undefined,
      exec_photo_url:
        isAdmin && execPhotoUrl !== ((player as { exec_photo_url?: string | null }).exec_photo_url ?? '')
          ? execPhotoUrl
          : undefined,
      fee_exempt: isAdmin && feeExempt !== (player.fee_exempt ?? false) ? feeExempt : undefined,
      // NOT gated on isAdmin: this one is exec work by design (00129), and the
      // server guard passes it because it is on neither admin-only list.
      // `null` is a real value — an exec putting a member back to "prefer not to
      // say" — so the ternary yields null rather than undefined for the empty
      // option, and `!== undefined` below still counts it as a change.
      competition_category:
        category !== (toCompetitionCategory(
          (player as { competition_category?: unknown }).competition_category,
        ) ?? '')
          ? (category === '' ? null : category)
          : undefined,
    };
    const hasOtherChanges = Object.values(changes).some((v) => v !== undefined);

    try {
      if (isPending) {
        const res = await approvePlayer(player.id, status as 'competitive' | 'recreational', reason);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        // approvePlayer writes status and active_flag and nothing else, so a
        // Save that also changed something on the form needs the ordinary update
        // behind it. Second, not first: a failed update must not leave somebody
        // approved-and-half-saved without saying so, and the toast below only
        // claims success once both have landed. Same shape the roster dialog's
        // Edit uses (players/player-actions.tsx).
        if (hasOtherChanges) {
          const rest = await updatePlayer(player.id, { ...changes, reason });
          if (!rest.ok) { toast(rest.error, 'error'); setLoading(false); return; }
        }
        toast('Player approved', 'success');
      } else {
        const res = await updatePlayer(player.id, {
          status: status !== player.status ? status as Player['status'] : undefined,
          ...changes,
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
      {/* Membership is NOT console access, and it never was — an exec is still
          an internal member, so promoting someone must not change which events
          they can enter. It stays here; the console-access select that used to
          sit above it does not. */}
      <Select
        label="Membership"
        options={MEMBERSHIP_TYPES.map((m) => ({ value: m.value, label: m.label }))}
        value={membershipType}
        onChange={(e) => setMembershipType(e.target.value)}
      />
      <p className="text-xs text-[var(--text-muted)] -mt-2">
        {MEMBERSHIP_TYPES.find((m) => m.value === membershipType)?.description}
      </p>
      {/* 00129. Not behind isAdmin: correcting this is exec work, which is the
          whole point of the change — the member set it once and the database
          will not take a second write from them.

          It is the one field on this form that is somebody's personal detail
          rather than their standing in the club, so the hint says what it is
          for and who else sees it. Read it as a correction tool, not as data
          entry: an exec should be changing it because the member asked. */}
      <Select
        label="Gender"
        options={COMPETITION_CATEGORY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
        value={category}
        onChange={(e) => setCategory(toCompetitionCategory(e.target.value) ?? '')}
      />
      <p className="text-xs text-[var(--text-muted)] -mt-2">
        The member sets this once themselves and cannot change it afterwards —
        this is where it gets corrected. It decides which gendered draws they
        can enter; Open events ignore it. Shown nowhere else in the console.
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
      {/* Square hairline group, like the rest of the screen. Still `isAdmin`,
          and still the same fields inside it — what changed is that `isExec` is
          now read off the stored row rather than off a select on this form, so
          the bio fields appear for somebody who is ALREADY on the exec team.
          Making them one is a separate act on /permissions, which means putting
          a new officer up is now two steps on two screens. That is the shape the
          club owner asked for, not a gap. */}
      {isAdmin && (
      <div className="border border-[var(--border)] p-3 space-y-1">
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
            {/* "along with this member's bio" was true until 00130, when the
                exec page stopped reading players.bio. The blurb beside this
                photo is players.exec_bio now, and the officer writes it
                themselves on /exec — no console screen edits it, so saying so
                is what stops an admin looking for a field that is not here. */}
            <p className="text-xs text-[var(--text-muted)]">
              Shown on the public exec page. Falls back to their initials if left
              blank. Their profile avatar is never used here. The blurb beside it is
              written by the exec themselves, on the exec page.
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
