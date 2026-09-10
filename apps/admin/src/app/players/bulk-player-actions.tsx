'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Select, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { SelectionBar, SelectionSummary, useSelection } from '@/components/selection';
import { describeBulkOutcome, useBulkRun } from '@/components/use-bulk-run';
import { bulkApprovePlayers, bulkUpdatePlayers } from '@/lib/actions';
import { REASON_MIN } from '@/lib/audit-reason';
import type { AdminPlayerUpdateInput } from '@badminton/shared';

/**
 * What the roster can do to several members at once.
 *
 * THE CLUB OWNER'S ASK, TWICE OVER: "add a way to mass edit users", and before
 * that "a temporary way to allow people to create a account and doesnt require
 * our approval since it will take ages to approve a ton of people". Frosh week
 * puts a hundred signups on the Needs Attention tab and the console had one
 * dialog per person.
 *
 * TWO CONTROLS, NOT SIX. Approve is its own button because approval is its own
 * capability, its own precondition (only a pending signup) and its own email.
 * Everything else an exec may change about several people at once — which group
 * of the club they are in, which division they play, whether they are on the
 * active roster — is one payload through updatePlayer, which is the same
 * function the Edit dialog on each row calls and carries the same field guards.
 *
 * BAN, REMOVE AND MERGE ARE DELIBERATELY ABSENT. Each is a decision about one
 * person: a ban carries a reason that is about them, a removal destroys their
 * standing, and a merge needs a preview of what is being folded into what. A
 * multi-select is the wrong instrument for all three, and offering them here
 * would make the most destructive things in the console the easiest to do to
 * forty people.
 */

const DIVISION_OPTIONS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

const NO_CHANGE = '';

const MEMBERSHIP_OPTIONS = [
  { value: NO_CHANGE, label: 'Leave as they are' },
  { value: 'internal', label: 'Internal (SFU student)' },
  { value: 'alumni', label: 'Alumni' },
  { value: 'external', label: 'External' },
];

const STATUS_OPTIONS = [
  { value: NO_CHANGE, label: 'Leave as they are' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

// active_flag, which is not a status — see adminPlayerUpdateSchema. Suspending
// is not on this list on purpose: removePlayer is what writes status
// 'suspended', it is admin-only, and it is not something to do from a dropdown
// to a selection.
const ROSTER_OPTIONS = [
  { value: NO_CHANGE, label: 'Leave as they are' },
  { value: 'active', label: 'On the active roster' },
  { value: 'inactive', label: 'Inactive' },
];

export function BulkPlayerActions({
  canApprove,
  canManage,
}: {
  canApprove: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { selectedItems, clear } = useSelection();
  const { running, progress, run } = useBulkRun();

  const [approveOpen, setApproveOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [division, setDivision] = useState('competitive');
  const [membership, setMembership] = useState(NO_CHANGE);
  const [status, setStatus] = useState(NO_CHANGE);
  const [roster, setRoster] = useState(NO_CHANGE);
  const [reason, setReason] = useState('');

  if (!canApprove && !canManage) return null;

  const ids = selectedItems.map((i) => i.id);
  // The server only ever had ids, so the names for a failure line come from
  // here — the same list the confirmation showed.
  const nameOf = (id: string) => selectedItems.find((i) => i.id === id)?.label ?? id;
  const reasonReady = reason.trim().length >= REASON_MIN;
  const editsSomething = membership !== NO_CHANGE || status !== NO_CHANGE || roster !== NO_CHANGE;

  function finish(result: Awaited<ReturnType<typeof run>>, verb: string) {
    // The chunks that ran before a whole-operation failure really did run, so
    // the page is refreshed and the selection cleared either way — leaving forty
    // ticked boxes over a roster that has already half changed is how the same
    // edit gets applied twice.
    router.refresh();
    if (!result.ok) {
      toast(result.error ?? 'Something went wrong', 'error');
    } else {
      const { message, type } = describeBulkOutcome(result.outcome, verb, nameOf);
      toast(message, type);
    }
    clear();
  }

  async function handleApprove() {
    const result = await run(ids, (chunk) =>
      bulkApprovePlayers(chunk, division as 'competitive' | 'recreational', reason.trim()),
    );
    setApproveOpen(false);
    setReason('');
    finish(result, 'approved');
  }

  async function handleEdit() {
    // Built as a partial payload rather than a full one: updatePlayer only
    // writes the keys it is given, so "leave as they are" has to be an ABSENT
    // key and not a re-sent current value. Sending the current value would be
    // wrong anyway — there is no single current value across a selection.
    const data: AdminPlayerUpdateInput = { reason: reason.trim() };
    if (membership !== NO_CHANGE) {
      data.membership_type = membership as 'internal' | 'alumni' | 'external';
    }
    if (status !== NO_CHANGE) data.status = status as 'competitive' | 'recreational';
    if (roster !== NO_CHANGE) data.active_flag = roster === 'active';

    const result = await run(ids, (chunk) => bulkUpdatePlayers(chunk, data));
    setEditOpen(false);
    setReason('');
    setMembership(NO_CHANGE);
    setStatus(NO_CHANGE);
    setRoster(NO_CHANGE);
    finish(result, 'updated');
  }

  const busy = running
    ? `${progress?.done ?? 0} of ${progress?.total ?? ids.length}…`
    : null;

  // THE DIALOGS SIT OUTSIDE THE BAR, not inside it. SelectionBar is
  // `sticky z-20`, which makes it a stacking context, and a `fixed inset-0
  // z-50` overlay nested in one is only z-50 WITHIN it — the console's own
  // chrome would sit on top of a confirmation. Rendering them as siblings also
  // means clearing the selection mid-run cannot yank a dialog out from under
  // somebody.
  return (
    <>
    <SelectionBar noun="member">
      {canApprove && (
        <Button variant="secondary" size="sm" disabled={running} onClick={() => setApproveOpen(true)}>
          Approve
        </Button>
      )}
      {canManage && (
        <Button variant="secondary" size="sm" disabled={running} onClick={() => setEditOpen(true)}>
          Edit
        </Button>
      )}
      {busy && (
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          {busy}
        </span>
      )}
    </SelectionBar>

      <Dialog open={approveOpen} onClose={() => setApproveOpen(false)} title="Approve members">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            Each of these is let in individually: anybody on the list who is not still
            a pending signup is skipped and named, and everyone who does go through
            is emailed and gets their own entry in the audit log.
          </p>
          <SelectionSummary noun="member" />
          <Select
            label="Division"
            options={DIVISION_OPTIONS}
            value={division}
            onChange={(e) => setDivision(e.target.value)}
          />
          <Textarea
            label="Reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Signed up at the club fair"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setApproveOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button onClick={handleApprove} disabled={running || !reasonReady}>
              {busy ?? `Approve ${selectedItems.length}`}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit members">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            Anything left on “leave as they are” is not written at all — so this
            changes only what you pick, for everyone on the list.
          </p>
          <SelectionSummary noun="member" />
          <Select
            label="Membership"
            options={MEMBERSHIP_OPTIONS}
            value={membership}
            onChange={(e) => setMembership(e.target.value)}
          />
          <Select
            label="Division"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          />
          <Select
            label="Roster"
            options={ROSTER_OPTIONS}
            value={roster}
            onChange={(e) => setRoster(e.target.value)}
          />
          {/* The one refusal the server makes that an officer can see coming.
              Said here rather than discovered as a row of red failures. */}
          {roster === 'inactive' && (
            <p className="text-[13px] text-[var(--color-warning)]">
              A suspended, banned or pending member cannot be marked inactive. Anyone on
              the list who is will be skipped and named.
            </p>
          )}
          <Textarea
            label="Reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Corrected after the membership audit"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={running || !reasonReady || !editsSomething}>
              {busy ?? `Update ${selectedItems.length}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
