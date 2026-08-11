'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { removeTournamentParticipant, updateTournamentStatus } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function RemoveParticipantButton({ participantId, tournamentId }: { participantId: string; tournamentId: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleRemove() {
    setLoading(true);
    try {
      await removeTournamentParticipant(participantId, tournamentId);
      toast('Participant removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Button size="sm" variant="ghost" onClick={handleRemove} loading={loading}>
      Remove
    </Button>
  );
}

export function TournamentStatusActions({ tournamentId, currentStatus }: { tournamentId: string; currentStatus: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleStatusChange(newStatus: string) {
    setLoading(true);
    try {
      await updateTournamentStatus(tournamentId, newStatus);
      toast(`Tournament ${newStatus}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div className="flex gap-2">
      {currentStatus === 'draft' && (
        <Button size="sm" onClick={() => handleStatusChange('active')} loading={loading}>
          Activate Tournament
        </Button>
      )}
      {currentStatus === 'active' && (
        <Button size="sm" variant="ghost" onClick={() => handleStatusChange('completed')} loading={loading}>
          Mark Completed
        </Button>
      )}
    </div>
  );
}
