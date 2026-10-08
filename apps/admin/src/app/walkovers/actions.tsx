'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea } from '@badminton/ui';
import { confirmWalkover, rejectWalkover } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function WalkoverActions({ walkoverId }: { walkoverId: string }) {
  const [action, setAction] = useState<'confirm' | 'reject' | null>(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleSubmit() {
    if (!notes.trim()) { toast('Notes required', 'error'); return; }
    setLoading(true);
    try {
      // The quieter 'info' toast is not a failure — it says 00118 has not been
      // applied to this database yet, so the verdict reached audit_logs.reason
      // but not the private note table. Same treatment (and same wording shape)
      // as the void/convert toasts on /matches under 00117: a red toast would
      // claim the walkover did not go through, which it did.
      if (action === 'confirm') {
        const res = await confirmWalkover(walkoverId, notes);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        if (res.data.noteRecorded) toast('Walkover confirmed', 'success');
        else toast('Walkover confirmed — the notes were audited but not saved to the walkover', 'info');
      } else {
        const res = await rejectWalkover(walkoverId, notes);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        if (res.data.noteRecorded) toast('Walkover rejected', 'success');
        else toast('Walkover rejected — the notes were audited but not saved to the walkover', 'info');
      }
      setAction(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" variant="success" onClick={() => setAction('confirm')}>Confirm</Button>
      <Button size="sm" variant="danger" onClick={() => setAction('reject')}>Reject</Button>
      <Dialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={action === 'confirm' ? 'Confirm Walkover' : 'Reject Walkover'}
      >
        <div className="space-y-4">
          <Textarea label="Admin Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex gap-2">
            <Button
              variant={action === 'confirm' ? 'success' : 'danger'}
              onClick={handleSubmit}
              loading={loading}
            >
              {action === 'confirm' ? 'Confirm' : 'Reject'}
            </Button>
            <Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
