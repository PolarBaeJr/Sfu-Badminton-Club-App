'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { updateTournamentStatus } from '@/lib/actions/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Play, CheckCircle } from 'lucide-react';

interface Props {
  tournamentId: string;
  status: string;
}

export function TournamentStatusControls({ tournamentId, status }: Props) {
  const [loading, setLoading] = useState(false);
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

  if (status === 'draft') {
    return (
      <Button onClick={() => handleStatusChange('active', 'activated')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:outline-none">
        <Play className="w-4 h-4 mr-1.5" />
        Activate Tournament
      </Button>
    );
  }

  if (status === 'active') {
    return (
      <Button variant="ghost" onClick={() => handleStatusChange('completed', 'completed')} loading={loading} className="focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:outline-none">
        <CheckCircle className="w-4 h-4 mr-1.5" />
        Mark Completed
      </Button>
    );
  }

  return null;
}
