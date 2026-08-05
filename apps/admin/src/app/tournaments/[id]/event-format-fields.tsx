'use client';

import { Input, Select } from '@badminton/ui';
import {
  TOURNAMENT_MATCH_FORMAT_LABELS,
  CUSTOM_FORMAT_BOUNDS,
  TOURNAMENT_EVENT_TYPE_LABELS,
  describeMatchShape,
} from '@badminton/shared';
import type { TournamentMatchFormat, SeedBy, TournamentEventType } from '@badminton/shared';

// The format + stage half of the event form. Both the create dialog and the
// edit dialog need exactly these five fields and the same rules about how they
// interact, so they share one component rather than two copies that drift.

export interface EventFormatValues {
  matchFormat: TournamentMatchFormat;
  /** Blank means "no override" — the enum above still decides. */
  gamesPerMatch: string;
  pointsPerGame: string;
  /** Blank means this event is not seeded from a pool. */
  seededFrom: string;
  seedBy: SeedBy;
}

export interface SiblingEvent {
  id: string;
  event_type: string;
  format: string;
}

export const EMPTY_FORMAT_VALUES: EventFormatValues = {
  matchFormat: 'best_of_3_to_21',
  gamesPerMatch: '',
  pointsPerGame: '',
  seededFrom: '',
  seedBy: 'wins',
};

/** Server-action payload. Blank inputs become NULL, which means "use the enum". */
export function toFormatPayload(v: EventFormatValues) {
  return {
    match_format: v.matchFormat,
    games_per_match: v.gamesPerMatch === '' ? null : Number(v.gamesPerMatch),
    points_per_game: v.pointsPerGame === '' ? null : Number(v.pointsPerGame),
    seeded_from_event_id: v.seededFrom === '' ? null : v.seededFrom,
    seed_by: v.seededFrom === '' ? null : v.seedBy,
  };
}

export function EventFormatFields({
  value,
  onChange,
  siblings,
}: {
  value: EventFormatValues;
  onChange: (next: EventFormatValues) => void;
  siblings: SiblingEvent[];
}) {
  const set = (patch: Partial<EventFormatValues>) => onChange({ ...value, ...patch });
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;

  // Preview the shape that will actually be played, so an exec can see at a
  // glance whether their typed values took effect over the preset.
  const effective = describeMatchShape({
    match_format: value.matchFormat,
    games_per_match: value.gamesPerMatch === '' ? null : Number(value.gamesPerMatch),
    points_per_game: value.pointsPerGame === '' ? null : Number(value.pointsPerGame),
  });

  return (
    <>
      <Select
        label="Match Format"
        value={value.matchFormat}
        onChange={(e) => set({ matchFormat: e.target.value as TournamentMatchFormat })}
        options={Object.entries(TOURNAMENT_MATCH_FORMAT_LABELS).map(([v, label]) => ({ value: v, label }))}
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Games (optional)"
          type="number"
          min={minGames}
          max={maxGames}
          step={2}
          value={value.gamesPerMatch}
          onChange={(e) => set({ gamesPerMatch: e.target.value })}
          placeholder="Preset"
        />
        <Input
          label="Points (optional)"
          type="number"
          min={minPoints}
          max={maxPoints}
          value={value.pointsPerGame}
          onChange={(e) => set({ pointsPerGame: e.target.value })}
          placeholder="Preset"
        />
      </div>
      <p className="text-xs text-[var(--text-muted)] -mt-2">
        Played as <span className="font-medium text-[var(--text-primary)]">{effective}</span>. Leave both blank to use the
        preset; games must be odd.
      </p>

      {siblings.length > 0 && (
        <>
          <Select
            label="Seed From (optional)"
            value={value.seededFrom}
            onChange={(e) => set({ seededFrom: e.target.value })}
            options={[
              { value: '', label: 'No pool — seed by Elo / manual seeds' },
              ...siblings.map((s) => ({
                value: s.id,
                label: `${TOURNAMENT_EVENT_TYPE_LABELS[s.event_type as TournamentEventType] ?? s.event_type} · ${
                  s.format === 'round_robin' ? 'Round Robin' : 'Single Elimination'
                }`,
              })),
            ]}
          />
          {value.seededFrom !== '' && (
            <>
              <Select
                label="Rank The Pool By"
                value={value.seedBy}
                onChange={(e) => set({ seedBy: e.target.value as SeedBy })}
                options={[
                  { value: 'wins', label: 'Most wins' },
                  { value: 'points', label: 'Most points scored' },
                ]}
              />
              <p className="text-xs text-[var(--text-muted)] -mt-2">
                The top finishers of that pool become this draw, in finishing order, up to Max Participants. The bracket
                cannot be generated until every pool match has been played.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
