'use client';

import { useState } from 'react';
import { Button, Dialog, Select, Textarea } from '@badminton/ui';
import { resolveDispute } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function DisputeActions({ disputeId, matchId }: { disputeId: string; matchId: string }) {
  const [open, setOpen] = useState(false);
  const [resType, setResType] = useState('accepted');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleResolve() {
    if (!note.trim()) { toast('Resolution note required', 'error'); return; }
    setLoading(true);
    try {
      await resolveDispute({
        dispute_id: disputeId,
        resolution_type: resType as 'accepted' | 'edited' | 'voided' | 'converted_to_casual',
        resolution_note: note,
      });
      toast('Dispute resolved', 'success');
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Resolve</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Resolve Dispute">
        <div className="space-y-4">
          <Select
            label="Resolution"
            value={resType}
            onChange={(e) => setResType(e.target.value)}
            options={[
              { value: 'accepted', label: 'Accept Result As-Is' },
              { value: 'voided', label: 'Void Match' },
              { value: 'converted_to_casual', label: 'Convert to Casual' },
            ]}
          />
          <Textarea label="Resolution Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button onClick={handleResolve} loading={loading}>Resolve</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
