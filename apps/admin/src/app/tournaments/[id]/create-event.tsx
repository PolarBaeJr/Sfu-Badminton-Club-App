'use client';

import { useState } from 'react';
import { Button, Dialog, Select, Input } from '@badminton/ui';
import { TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import { createTournamentEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { TournamentEventType, TournamentEventFormat, TournamentSeedingMethod } from '@badminton/shared';
import {
  EventFormatFields,
  EMPTY_FORMAT_VALUES,
  toFormatPayload,
  type EventFormatValues,
  type SiblingEvent,
} from './event-format-fields';

export function CreateEventButton({ tournamentId, siblings = [] }: { tournamentId: string; siblings?: SiblingEvent[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [eventType, setEventType] = useState<TournamentEventType>('mens_singles');
  const [format, setFormat] = useState<TournamentEventFormat>('single_elimination');
  const [formatValues, setFormatValues] = useState<EventFormatValues>(EMPTY_FORMAT_VALUES);
  const [maxParticipants, setMaxParticipants] = useState('');
  const [seedingMethod, setSeedingMethod] = useState<TournamentSeedingMethod>('elo');
  const [eloMultiplier, setEloMultiplier] = useState('1.25');
  const { toast } = useToast();
  const router = useRouter();

  // A round robin has no draw to seed, so the pool picker is meaningless there.
  const seedableSiblings = format === 'round_robin' ? [] : siblings;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await createTournamentEvent(tournamentId, {
        event_type: eventType,
        format,
        ...toFormatPayload(format === 'round_robin' ? { ...formatValues, seededFrom: '' } : formatValues),
        max_participants: maxParticipants ? Number(maxParticipants) : undefined,
        seeding_method: seedingMethod,
        elo_multiplier: Number(eloMultiplier) || 1.25,
      });
      // Format and pool-link validation come back as a refusal message, not an
      // exception — show the exec which field they need to fix.
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Event created', 'success');
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create event', 'error');
    }
    setLoading(false);
  }

  const eventTypeOptions = Object.entries(TOURNAMENT_EVENT_TYPE_LABELS).map(([value, label]) => ({ value, label }));

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
          <EventFormatFields value={formatValues} onChange={setFormatValues} siblings={seedableSiblings} />
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
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading}>Create Event</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
