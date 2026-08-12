'use client';

import { useState } from 'react';
import { Button, Dialog, Input } from '@badminton/ui';
import { updateTournamentEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { SeedBy, TournamentMatchFormat } from '@badminton/shared';
import {
  EventFormatFields,
  toFormatPayload,
  type EventFormatValues,
  type SiblingEvent,
} from '../../../event-format-fields';
import type { TournamentEventRow } from '@/lib/tournament-types';

// Editing the format after the event is created. The server refuses once a
// draw exists; this dialog is simply not offered then, so the exec never sees
// a form that cannot be saved.
export function EventSettingsDialog({
  event,
  siblings,
  onClose,
}: {
  event: TournamentEventRow;
  siblings: SiblingEvent[];
  onClose: () => void;
}) {
  const [values, setValues] = useState<EventFormatValues>({
    matchFormat: event.match_format as TournamentMatchFormat,
    gamesPerMatch: event.games_per_match?.toString() ?? '',
    pointsPerGame: event.points_per_game?.toString() ?? '',
    seededFrom: event.seeded_from_event_id ?? '',
    seedBy: (event.seed_by as SeedBy | null) ?? 'wins',
    // Structural reads, following max_events_per_player's precedent: 00106's
    // columns are not in the generated Database type until the migration has
    // been run and the types regenerated from the database it changed.
    groupCount: (event as { group_count?: number | null }).group_count?.toString() ?? '',
    qualifiersPerGroup: (event as { qualifiers_per_group?: number | null }).qualifiers_per_group?.toString() ?? '2',
  });
  const [maxParticipants, setMaxParticipants] = useState(event.max_participants?.toString() ?? '');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  // A round robin produces standings rather than consuming them.
  const seedableSiblings = event.format === 'round_robin' ? [] : siblings;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await updateTournamentEvent(event.id, {
        ...toFormatPayload(event.format === 'round_robin' ? { ...values, seededFrom: '' } : values),
        max_participants: maxParticipants === '' ? null : Number(maxParticipants),
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Event updated', 'success');
      onClose();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to update event', 'error');
    }
    setLoading(false);
  }

  return (
    <Dialog open onClose={onClose} title="Event Settings">
      <form onSubmit={handleSave} className="space-y-4">
        <EventFormatFields value={values} onChange={setValues} siblings={seedableSiblings} format={event.format} />
        <Input
          label={values.seededFrom === '' ? 'Max Participants (optional)' : 'Bracket Size (how many qualify)'}
          type="number"
          min={2}
          value={maxParticipants}
          onChange={(e) => setMaxParticipants(e.target.value)}
          placeholder={values.seededFrom === '' ? 'Leave empty for unlimited' : 'Leave empty to take the whole pool'}
        />
        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save Changes</Button>
        </div>
      </form>
    </Dialog>
  );
}
