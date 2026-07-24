'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea, Dropdown } from '@badminton/ui';
import { voidMatch, convertMatchToCasual } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { MoreVertical } from 'lucide-react';

export function MatchActions({ matchId, resultStatus }: { matchId: string; resultStatus: string }) {
  const [action, setAction] = useState<'void' | 'casual' | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleConfirm() {
    if (!reason.trim()) { toast('Reason required', 'error'); return; }
    setLoading(true);
    try {
      if (action === 'void') {
        const res = await voidMatch(matchId, reason);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Match voided', 'success');
      } else if (action === 'casual') {
        const res = await convertMatchToCasual(matchId, reason);
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Match converted to casual', 'success');
      }
      setAction(null);
      setReason('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const items: { label: string; onClick: () => void; danger?: boolean }[] = [];

  if (resultStatus === 'confirmed') {
    items.push({ label: 'Convert to Casual', onClick: () => setAction('casual') });
  }
  items.push({ label: 'Void Match', onClick: () => setAction('void'), danger: true });

  return (
    <>
      <Dropdown
        trigger={
          <button
            aria-label="Match actions menu"
            className="p-1.5 rounded-lg hover:bg-[var(--border-hover)] transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        }
        items={items}
      />
      <Dialog
        open={action !== null}
        onClose={() => { setAction(null); setReason(''); }}
        title={action === 'void' ? 'Void Match' : 'Convert to Casual'}
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {action === 'void'
              ? 'This will reverse all Elo changes and mark the match as voided.'
              : 'This will reverse Elo changes and convert the match to casual.'}
          </p>
          <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="danger" onClick={handleConfirm} loading={loading}>Confirm</Button>
            <Button variant="ghost" onClick={() => { setAction(null); setReason(''); }}>Cancel</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
