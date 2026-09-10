'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { SelectionBar, SelectionSummary, useSelection } from '@/components/selection';
import { describeBulkOutcome, useBulkRun } from '@/components/use-bulk-run';
import { bulkArchiveSessions, bulkDeleteSessions } from '@/lib/actions';
import { REASON_MIN } from '@/lib/audit-reason';

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
 * time.
 */
export function BulkSessionActions({
  canArchive,
  canDelete,
}: {
  canArchive: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { selectedItems, clear } = useSelection();
  const { running, progress, run } = useBulkRun();

  const [mode, setMode] = useState<'archive' | 'delete' | null>(null);
  const [reason, setReason] = useState('');

  if (!canArchive && !canDelete) return null;

  const ids = selectedItems.map((i) => i.id);
  const nameOf = (id: string) => selectedItems.find((i) => i.id === id)?.label ?? id;
  const reasonReady = reason.trim().length >= REASON_MIN;
  const busy = running ? `${progress?.done ?? 0} of ${progress?.total ?? ids.length}…` : null;

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

  return (
    <>
      <SelectionBar noun="session">
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
    </>
  );
}
