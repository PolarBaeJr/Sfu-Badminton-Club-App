'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { SelectionBar, SelectionSummary, useSelection } from '@/components/selection';
import { describeBulkOutcome, useBulkRun } from '@/components/use-bulk-run';
import { bulkArchiveSessions, bulkDeleteSessions, bulkUpdateSessions } from '@/lib/actions';
import { REASON_MIN } from '@/lib/audit-reason';
import {
  NO_CHANGE,
  buildSessionPatch,
  emptySessionEditForm,
  patchTouchesSomething,
  sessionEditProblem,
  type TimeMode,
} from '@/lib/session-patch';
import { LocationField } from './location-field';

// The same three values sessionGroupSchema holds, with the "leave as they are"
// sentinel in front. Deliberately a local list rather than an import from
// actions.tsx: that file's TRACK_OPTIONS is the per-row Edit dialog's, where
// every option is a real choice and there is nothing to leave alone.
const TRACK_OPTIONS = [
  { value: NO_CHANGE, label: 'Leave as they are' },
  { value: 'all', label: 'All players' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

// The three states of a nullable time column, said out loud. A bare time input
// cannot express them: an empty box would have to mean either "leave it" or
// "clear it" and there is no way for the officer to tell which was heard.
const TIME_MODE_OPTIONS = [
  { value: 'leave', label: 'Leave as they are' },
  { value: 'set', label: 'Set to…' },
  { value: 'clear', label: 'Clear the time' },
];

/**
 * Closing — or destroying — several nights at once.
 *
 * THE CASE THIS EXISTS FOR is the end of a term. A season is three months of
 * Tuesday and Thursday evenings; tidying them away meant opening a menu, a
 * dialog and a typed reason forty times, and the reason was the same sentence
 * every time. It still IS the same sentence, and it still lands on every one of
 * the forty audit rows — this only stops it being typed forty times.
 *
 * CLOSE AND DELETE STAY APART, exactly as they do in the per-row menu. Closing a
 * night is a statement about the night and is reversible by editing it; deleting
 * one takes its session_attendance rows with it, which is the club's record of
 * who actually turned up. deleteSession is admin-only for that reason, and the
 * dialog says out loud what goes with it.
 *
 * NO BULK REMINDER SEND, deliberately. sendSessionReminders emails everybody who
 * RSVPd; across a selection that is hundreds of messages to real addresses,
 * fired by one click, with no way to call them back. It stays one night at a
 * time. Edit does not weaken that, and it is worth saying why: a patch writes
 * rows and sends nothing — notifyPlayers is not called anywhere in the session
 * actions — so the worst a wrong bulk edit does is need editing again.
 *
 * EDIT ANSWERS "no way to mass edit sessions?", asked over six Friday rows all
 * reading TIME NOT SET. That is the same forty-dialogs problem Close already
 * solves, arriving through the fields instead of the status.
 *
 * THREE STATES PER TIME, NOT TWO, and this is the part that needed the care.
 * start_time and end_time are nullable — TIME NOT SET *is* NULL — so each of
 * them offers "leave as they are" (nothing is written), "set to…" and "clear the
 * time". An empty box is never load-bearing: the mode says what is meant. The
 * encoding lives in lib/session-patch so it can be tested; the console's tests
 * run with no DOM, so a rule left in here would be a rule nothing checks.
 *
 * NAME, LOCATION AND TRACK are the other three, all non-nullable, all on the
 * "leave as they are" sentinel /players uses. DATE IS DELIBERATELY ABSENT —
 * setting twelve nights to one date collapses a term into one evening and leaves
 * the RSVPs and attendance already recorded against them belonging to a night
 * nobody played. So are `notes` (per-night text, twelve sentences overwritten by
 * one), `status` (that is the Close button) and the scan-to-check-in policy
 * (per-night, and written by a pre-migration workaround that must stay in one
 * place). Those stay in the per-row menu.
 */
export function BulkSessionActions({
  canEdit,
  canArchive,
  canDelete,
}: {
  canEdit: boolean;
  canArchive: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { selectedItems, clear } = useSelection();
  const { running, progress, run } = useBulkRun();

  const [mode, setMode] = useState<'archive' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  // Edit gets its own open flag rather than a third `mode`, which leaves the
  // destructive pair's ternaries below exactly as they were. Its reason is
  // separate state too: a half-typed closing reason must never end up filed
  // against an edit.
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState(emptySessionEditForm);
  const [editReason, setEditReason] = useState('');

  if (!canEdit && !canArchive && !canDelete) return null;

  const ids = selectedItems.map((i) => i.id);
  const nameOf = (id: string) => selectedItems.find((i) => i.id === id)?.label ?? id;
  const reasonReady = reason.trim().length >= REASON_MIN;
  const editReasonReady = editReason.trim().length >= REASON_MIN;
  const busy = running ? `${progress?.done ?? 0} of ${progress?.total ?? ids.length}…` : null;
  // Both the button's disabled test and the payload come from the same built
  // patch, never re-derived from the form a second time — the two drifting is
  // how a dialog offers to save something it then does not send.
  const patch = buildSessionPatch(form);
  // A field that is filled in but cannot be saved, named before the round trip
  // rather than as N per-record refusals afterwards. See sessionEditProblem.
  const editProblem = sessionEditProblem(form);

  async function handleRun() {
    const deleting = mode === 'delete';
    const result = await run(ids, (chunk) =>
      deleting ? bulkDeleteSessions(chunk, reason.trim()) : bulkArchiveSessions(chunk, reason.trim()),
    );
    setMode(null);
    setReason('');
    router.refresh();
    if (!result.ok) {
      toast(result.error ?? 'Something went wrong', 'error');
    } else {
      const { message, type } = describeBulkOutcome(result.outcome, deleting ? 'deleted' : 'closed', nameOf);
      toast(message, type);
    }
    clear();
  }

  async function handleEdit() {
    const result = await run(ids, (chunk) => bulkUpdateSessions(chunk, patch, editReason.trim()));
    setEditOpen(false);
    setForm(emptySessionEditForm());
    setEditReason('');
    router.refresh();
    if (!result.ok) {
      toast(result.error ?? 'Something went wrong', 'error');
    } else {
      const { message, type } = describeBulkOutcome(result.outcome, 'updated', nameOf);
      toast(message, type);
    }
    clear();
  }

  return (
    <>
      <SelectionBar noun="session">
        {canEdit && (
          <Button variant="secondary" size="sm" disabled={running} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
        )}
        {canArchive && (
          <Button variant="secondary" size="sm" disabled={running} onClick={() => setMode('archive')}>
            Close
          </Button>
        )}
        {canDelete && (
          <Button variant="danger" size="sm" disabled={running} onClick={() => setMode('delete')}>
            Delete
          </Button>
        )}
        {busy && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
            {busy}
          </span>
        )}
      </SelectionBar>

      {/* Outside the bar — it is `sticky z-20` and therefore a stacking context,
          so a `fixed z-50` overlay nested inside it would sit under the console's
          own chrome. */}
      <Dialog
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'delete' ? 'Delete sessions' : 'Close sessions'}
      >
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            {mode === 'delete'
              ? 'This removes the sessions and every attendance record against them. It cannot be undone — closing a session instead keeps the night and its turnout on the books.'
              : 'Closing marks each night finished. Its RSVPs and attendance stay exactly as they are.'}
          </p>
          <SelectionSummary noun="session" />
          <Textarea
            label="Reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={mode === 'delete' ? 'e.g. Duplicated by the import' : 'e.g. End of the fall term'}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode(null)} disabled={running}>
              Cancel
            </Button>
            <Button
              variant={mode === 'delete' ? 'danger' : 'primary'}
              onClick={handleRun}
              disabled={running || !reasonReady}
            >
              {busy ?? `${mode === 'delete' ? 'Delete' : 'Close'} ${selectedItems.length}`}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit sessions">
        <div className="space-y-4">
          <p className="text-[var(--text-secondary)]">
            Anything left on “leave as they are” is not written at all — so this
            changes only what you fill in, for every night on the list. Clearing a
            time is its own choice, and it has to be picked on purpose.
          </p>
          <SelectionSummary noun="session" />
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Leave blank to keep each name"
          />
          {/* The shared field, unmodified. Its “Select a location…” option is the
              leave-alone state here — nothing is written until a gym is picked. */}
          <LocationField
            value={form.location}
            onChange={(next) => setForm({ ...form, location: next })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Start time"
              options={TIME_MODE_OPTIONS}
              value={form.startMode}
              onChange={(e) => setForm({ ...form, startMode: e.target.value as TimeMode })}
            />
            {form.startMode === 'set' && (
              <Input
                label="Starts at"
                type="time"
                value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="End time"
              options={TIME_MODE_OPTIONS}
              value={form.endMode}
              onChange={(e) => setForm({ ...form, endMode: e.target.value as TimeMode })}
            />
            {form.endMode === 'set' && (
              <Input
                label="Ends at"
                type="time"
                value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              />
            )}
          </div>
          {/* Clearing an end time is not "no end" — the night then closes at its
              start plus the club's default duration, and check-in follows that.
              Said here rather than discovered a week later at the door. */}
          {form.endMode === 'clear' && (
            <p className="text-[13px] text-[var(--color-warning)]">
              With no end time, each night closes its default number of minutes
              after it starts — that is what check-in will follow.
            </p>
          )}
          <Select
            label="Track"
            options={TRACK_OPTIONS}
            value={form.track}
            onChange={(e) => setForm({ ...form, track: e.target.value })}
          />
          <Textarea
            label="Reason"
            required
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
            placeholder="e.g. Gym double-booked, moved to Central"
          />

          {editProblem && (
            <p className="text-xs text-[var(--red)]">{editProblem}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={
                running || !editReasonReady || !patchTouchesSomething(patch) || editProblem !== null
              }
            >
              {busy ?? `Update ${selectedItems.length}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
