'use client';

import { useState } from 'react';
import { Button, Dialog, Select, Input } from '@badminton/ui';
import { TOURNAMENT_EVENT_TYPE_LABELS, TOURNAMENT_MATCH_FORMAT_LABELS } from '@badminton/shared';
import { createTournamentEvent } from '@/lib/tournament/event-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { TournamentEventType, TournamentEventFormat, TournamentMatchFormat, TournamentSeedingMethod } from '@badminton/shared';

export function CreateEventButton({ tournamentId }: { tournamentId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [eventType, setEventType] = useState<TournamentEventType>('mens_singles');
  const [format, setFormat] = useState<TournamentEventFormat>('single_elimination');
  const [matchFormat, setMatchFormat] = useState<TournamentMatchFormat>('best_of_3_to_21');
  const [maxParticipants, setMaxParticipants] = useState('');
  const [seedingMethod, setSeedingMethod] = useState<TournamentSeedingMethod>('elo');
  const [eloMultiplier, setEloMultiplier] = useState('1.25');
  const { toast } = useToast();
  const router = useRouter();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await createTournamentEvent(tournamentId, {
        event_type: eventType,
        format,
        match_format: matchFormat,
        max_participants: maxParticipants ? Number(maxParticipants) : undefined,
        seeding_method: seedingMethod,
        elo_multiplier: Number(eloMultiplier) || 1.25,
      });
      toast('Event created', 'success');
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create event', 'error');
    }
    setLoading(false);
  }

  const eventTypeOptions = Object.entries(TOURNAMENT_EVENT_TYPE_LABELS).map(([value, label]) => ({ value, label }));
  const matchFormatOptions = Object.entries(TOURNAMENT_MATCH_FORMAT_LABELS).map(([value, label]) => ({ value, label }));

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="w-4 h-4 mr-1" /> Add Event
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Tournament Event">
        <form onSubmit={handleCreate} className="space-y-4">
          <Select
            label="Event Type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as TournamentEventType)}
            options={eventTypeOptions}
          />
          <Select
            label="Format"
            value={format}
            onChange={(e) => setFormat(e.target.value as TournamentEventFormat)}
            options={[
              { value: 'single_elimination', label: 'Single Elimination' },
              { value: 'round_robin', label: 'Round Robin' },
            ]}
          />
          <Select
            label="Match Format"
            value={matchFormat}
            onChange={(e) => setMatchFormat(e.target.value as TournamentMatchFormat)}
            options={matchFormatOptions}
          />
          <Input
            label="Max Participants (optional)"
            type="number"
            value={maxParticipants}
            onChange={(e) => setMaxParticipants(e.target.value)}
            placeholder="Leave empty for unlimited"
          />
          <Select
            label="Seeding Method"
            value={seedingMethod}
            onChange={(e) => setSeedingMethod(e.target.value as TournamentSeedingMethod)}
            options={[
              { value: 'elo', label: 'Auto-seed by Elo' },
              { value: 'manual', label: 'Manual Seeding' },
              { value: 'random', label: 'Random' },
            ]}
          />
          <Input
            label="Elo Multiplier"
            type="number"
            value={eloMultiplier}
            onChange={(e) => setEloMultiplier(e.target.value)}
          />
          <div className="flex gap-2 pt-2">
            <Button type="submit" loading={loading} className="flex-1">Create Event</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
