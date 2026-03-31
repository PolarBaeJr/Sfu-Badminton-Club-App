'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea, Dropdown } from '@badminton/ui';
import { voidMatch, convertMatchToCasual } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function MatchActions({ matchId }: { matchId: string }) {
  const [action, setAction] = useState<'void' | 'casual' | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleConfirm() {
    if (!reason.trim()) { toast('Reason required', 'error'); return; }
    setLoading(true);
    try {
      if (action === 'void') {
        await voidMatch(matchId, reason);
        toast('Match voided', 'success');
      } else if (action === 'casual') {
        await convertMatchToCasual(matchId, reason);
        toast('Match converted to casual', 'success');
      }
      setAction(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Dropdown
        trigger={<Button size="sm" variant="ghost">Actions</Button>}
        items={[
          { label: 'Void Match', onClick: () => setAction('void'), danger: true },
          { label: 'Convert to Casual', onClick: () => setAction('casual') },
        ]}
      />
      <Dialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={action === 'void' ? 'Void Match' : 'Convert to Casual'}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            {action === 'void'
              ? 'This will reverse all Elo changes and mark the match as voided.'
              : 'This will reverse Elo changes and convert the match to casual.'}
          </p>
          <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="danger" onClick={handleConfirm} loading={loading}>Confirm</Button>
            <Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
