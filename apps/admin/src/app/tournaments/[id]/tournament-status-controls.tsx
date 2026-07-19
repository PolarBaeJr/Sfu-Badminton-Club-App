'use client';

import { useState } from 'react';
import { Button, Dialog, Textarea } from '@badminton/ui';
import { updateTournamentStatus, suspendTournament, resumeTournament } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Play, CheckCircle, Pause } from 'lucide-react';

interface Props {
  tournamentId: string;
  status: string;
  suspendedAt: string | null;
  suspensionReason: string | null;
}

export function TournamentStatusControls({ tournamentId, status, suspendedAt }: Props) {
  const [loading, setLoading] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  async function handleStatusChange(newStatus: string, label: string) {
    setLoading(true);
    try {
      await updateTournamentStatus(tournamentId, newStatus);
      toast(`Tournament ${label}`, 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleSuspend(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await suspendTournament(tournamentId, reason);
      toast('Tournament suspended', 'success');
      setSuspendOpen(false);
      setReason('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleResume() {
    setLoading(true);
    try {
      await resumeTournament(tournamentId);
      toast('Tournament resumed', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  if (suspendedAt) {
    return (
      <Button onClick={handleResume} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
        <Play className="w-4 h-4 mr-1.5" />
        Resume Tournament
      </Button>
    );
  }

  if (status === 'draft') {
    return (
      <Button onClick={() => handleStatusChange('active', 'activated')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
        <Play className="w-4 h-4 mr-1.5" />
        Activate Tournament
      </Button>
    );
  }

  if (status === 'active') {
    return (
      <>
        <Button variant="ghost" onClick={() => handleStatusChange('completed', 'completed')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <CheckCircle className="w-4 h-4 mr-1.5" />
          Mark Completed
        </Button>
        <Button variant="ghost" onClick={() => setSuspendOpen(true)} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <Pause className="w-4 h-4 mr-1.5" />
          Suspend
        </Button>
        <Dialog open={suspendOpen} onClose={() => setSuspendOpen(false)} title="Suspend Tournament">
          <form onSubmit={handleSuspend} className="space-y-4">
            <Textarea
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this tournament being paused?"
              required
              minLength={2}
              maxLength={500}
            />
            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setSuspendOpen(false)} type="button">Cancel</Button>
              <Button type="submit" loading={loading}>Suspend Tournament</Button>
            </div>
          </form>
        </Dialog>
      </>
    );
  }

  return null;
}
