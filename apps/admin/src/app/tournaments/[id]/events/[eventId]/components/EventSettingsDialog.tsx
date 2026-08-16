'use client';

import { useState } from 'react';
import { Button, Dialog, Input } from '@badminton/ui';
import { updateTournamentEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { playsRoundRobin, isPoolToBracket } from '@badminton/shared';
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
  totalEntries,
  onClose,
}: {
  event: TournamentEventRow;
  siblings: SiblingEvent[];
  /**
   * The field as it stands, so the seed-skip control can say how many byes it
   * would actually produce (00124). Optional so an un-updated caller still
   * type-checks and simply gets no live line.
   */
  totalEntries?: number;
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
    // A flat pool_to_bracket pool defaults to 4 qualifiers rather than 2, since
    // "top 2 of one pool" is a final and nothing else. Same default the server
    // applies (normalizeGroupShape).
    // Parenthesised deliberately: `x ?? 0 > 1` parses as `x ?? (0 > 1)`, which
    // reads a group count of exactly 1 — a flat pool spelt out rather than left
    // blank — as a group STAGE and defaults it to 2. Only reachable when the
    // column is NULL, which the server never leaves it on this format, but a
    // fallback that is wrong in one case is worse than no fallback.
    qualifiersPerGroup: (event as { qualifiers_per_group?: number | null }).qualifiers_per_group?.toString()
      ?? (isPoolToBracket(event.format)
        && (((event as { group_count?: number | null }).group_count ?? 1) <= 1) ? '4' : '2'),
    // Same structural read as the two above (00124 is not in the generated
    // Database type until the migration has been run and the types regenerated).
    // 0 opens the control blank rather than showing a literal "0": blank and 0
    // mean the same thing here, and a placeholder that says so reads better than
    // a number the exec has to clear before typing.
    seedSkip: (() => {
      const stored = (event as { seed_skip_count?: number | null }).seed_skip_count ?? 0;
      return stored > 0 ? String(stored) : '';
    })(),
  });
  const [maxParticipants, setMaxParticipants] = useState(event.max_participants?.toString() ?? '');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  // A round robin produces standings rather than consuming them, and a
  // pool_to_bracket event produces its own and consumes them itself.
  const seedableSiblings = playsRoundRobin(event.format) ? [] : siblings;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await updateTournamentEvent(event.id, {
        ...toFormatPayload(
          playsRoundRobin(event.format) ? { ...values, seededFrom: '' } : values,
          event.format,
        ),
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
        <EventFormatFields
          value={values}
          onChange={setValues}
          siblings={seedableSiblings}
          format={event.format}
          fieldSize={totalEntries}
          eloMultiplier={event.elo_multiplier}
        />
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
