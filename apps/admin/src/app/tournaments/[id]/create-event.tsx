'use client';

import { useState } from 'react';
import { Button, Dialog, Select, Input } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  TOURNAMENT_EVENT_FORMAT_HINTS,
  isDoublesEvent,
  isPoolToBracket,
  playsRoundRobin,
} from '@badminton/shared';
import { createTournamentEvent } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { TournamentEventType, TournamentEventFormat, TournamentSeedingMethod } from '@badminton/shared';
import {
  EventFormatFields,
  EMPTY_FORMAT_VALUES,
  inheritableFrom,
  toFormatPayload,
  type EventFormatValues,
  type SiblingEvent,
} from './event-format-fields';

export function CreateEventButton({
  tournamentId,
  siblings = [],
  // The TOURNAMENT's multiplier, used as this event's starting value. Before
  // 00109 that number was shown to players as "1.15x MULTIPLIER" while every
  // event was created at 1.25 and the rating maths only ever read the EVENT —
  // so the figure on the page was not the one applied to anyone's rating.
  // Seeding from it here is what makes the display honest; the event's own
  // value still decides, so an exec can still differ one event deliberately.
  defaultEloMultiplier,
}: {
  tournamentId: string;
  siblings?: SiblingEvent[];
  defaultEloMultiplier?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [eventType, setEventType] = useState<TournamentEventType>('mens_singles');
  const [format, setFormat] = useState<TournamentEventFormat>('single_elimination');
  const [formatValues, setFormatValues] = useState<EventFormatValues>(EMPTY_FORMAT_VALUES);
  const [maxParticipants, setMaxParticipants] = useState('');
  const [seedingMethod, setSeedingMethod] = useState<TournamentSeedingMethod>('elo');
  const [eloMultiplier, setEloMultiplier] = useState(String(defaultEloMultiplier ?? 1.25));
  const { toast } = useToast();
  const router = useRouter();

  // Seeded when the dialog OPENS, not once on mount: creating an event
  // refreshes the page and changes what there is to inherit from, and a
  // mount-time initialiser would keep offering the FIRST event's shape all
  // session. Opening is also the only moment the exec can be surprised by it.
  function openDialog() {
    const inherited = inheritableFrom(siblings);
    setFormatValues(inherited ? { ...EMPTY_FORMAT_VALUES, ...inherited } : EMPTY_FORMAT_VALUES);
    setOpen(true);
  }

  // A round robin has no draw to seed, so the pool picker is meaningless there.
  //
  // AND ONLY POOLS THAT COULD ACTUALLY SEED THIS EVENT. The picker used to
  // offer every sibling, so a men's SINGLES knockout could be pointed at a
  // men's DOUBLES pool — buildFieldFromPool refuses that ("A doubles event
  // cannot be seeded from a singles pool, or the other way round"), but not
  // until the draw is generated. The exec sets the event up, sees "Seeded from
  // pool by points" on the header, waits for the pool to finish, presses
  // Generate on the day, and only then finds out it was never going to work.
  // Two filters, both matching what the server will insist on:
  //   * round_robin only — standings come from pool play; a bracket has none.
  //   * same doubles-ness — singles standings are participant rows and doubles
  //     standings are pair rows, and there is no sensible way to carry one into
  //     the other.
  //
  // AND NONE AT ALL FOR pool_to_bracket (00107). That format plays its own pool
  // inside this one event, so an external link would be a second, contradictory
  // field for the same bracket — the server refuses it outright, and offering
  // the picker would be an invitation to be refused.
  const seedableSiblings =
    playsRoundRobin(format)
      ? []
      : siblings.filter(
          (s) =>
            s.format === 'round_robin' &&
            isDoublesEvent(s.event_type as TournamentEventType) === isDoublesEvent(eventType),
        );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await createTournamentEvent(tournamentId, {
        event_type: eventType,
        format,
        ...toFormatPayload(
          playsRoundRobin(format) ? { ...formatValues, seededFrom: '' } : formatValues,
          format,
        ),
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
      <Button size="sm" onClick={openDialog}>
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
            onChange={(e) => {
              const next = e.target.value as TournamentEventFormat;
              setFormat(next);
              // The qualifier count means different things on the two pool
              // shapes, so the default follows the format rather than being
              // left at whatever the last one wanted: 2 out of each of several
              // groups is the usual group stage, 2 out of one flat pool is a
              // final and nothing else. Matches normalizeGroupShape server-side.
              if (isPoolToBracket(next) && formatValues.groupCount === '') {
                setFormatValues({ ...formatValues, qualifiersPerGroup: '4' });
              }
            }}
            options={Object.entries(TOURNAMENT_EVENT_FORMAT_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <p className="text-xs text-[var(--text-muted)] -mt-2">
            {TOURNAMENT_EVENT_FORMAT_HINTS[format]}
          </p>
          {/* eloMultiplier is the dialog's own live state, not the tournament
              default, so the ladder's weights move as the exec types in the Elo
              Multiplier box further down — which is the only way to see what
              changing it does before the event exists. */}
          <EventFormatFields
            value={formatValues}
            onChange={setFormatValues}
            siblings={seedableSiblings}
            format={format}
            eloMultiplier={eloMultiplier}
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
            // "Manual" is the one option that changes how the DRAW is made and
            // not just how the seeds are worked out: every other method has the
            // bracket drawn at random within its seeding tiers, so a redraw
            // gives a different draw, while manual places the field exactly
            // where its seed numbers say and redraws identically. The label has
            // to say so — it is the only opt-out, and it is invisible otherwise.
            options={[
              { value: 'elo', label: 'Auto-seed by Elo' },
              { value: 'manual', label: 'Manual — draw follows the seeds exactly' },
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
