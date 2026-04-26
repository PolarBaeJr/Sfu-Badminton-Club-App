'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea } from '@badminton/ui';
import { forceExpireChallenge } from '@/lib/actions/challenge-actions';
import { useToast } from '@/components/toast-provider';

export function ChallengeActions({ challengeId }: { challengeId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleExpire() {
    if (!reason.trim()) { toast('Reason required', 'error'); return; }
    setLoading(true);
    try {
      await forceExpireChallenge(challengeId, reason);
      toast('Challenge expired', 'success');
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Expire</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Force Expire Challenge">
        <div className="space-y-4">
          <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="danger" onClick={handleExpire} loading={loading}>Confirm Expire</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
