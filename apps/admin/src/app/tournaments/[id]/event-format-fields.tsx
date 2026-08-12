'use client';

import { Input, Select } from '@badminton/ui';
import {
  TOURNAMENT_MATCH_FORMAT_LABELS,
  TOURNAMENT_FORMAT_RULES,
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
  /** Blank or "1" is an ordinary flat round robin — see 00106. */
  groupCount: string;
  qualifiersPerGroup: string;
}

export interface SiblingEvent {
  id: string;
  event_type: string;
  format: string;
  /** Present since 00106; absent on a page that has not been updated. */
  group_count?: number | null;
  // Carried so a new event can start from how the last one was set up — see
  // inheritableFrom below. All optional: a caller that only needs the pool
  // picker (which is what SiblingEvent was originally for) still type-checks.
  match_format?: string | null;
  games_per_match?: number | null;
  points_per_game?: number | null;
  elo_multiplier?: number | string | null;
}

/**
 * The form state a new event should open with, given the events already in
 * this tournament.
 *
 * WHAT IS INHERITED IS THE HOUSE STYLE, not the event. A club setting up five
 * events on one day plays them all to the same shape, so the match format and
 * the Elo weight are worth carrying; typing them five times is the actual
 * complaint. What is deliberately NOT carried:
 *
 *   * the POOL LINK. It names one specific other event. Copying it would point
 *     the new event at a pool that may be the wrong discipline entirely — the
 *     exact mis-link the picker filter now prevents, reintroduced by the back
 *     door — and a pool can only sensibly feed one bracket anyway.
 *   * the CAPACITY. Draw size is the thing that most often differs between a
 *     men's and a mixed event, and a silently inherited cap is the kind of
 *     limit nobody notices until entries start being refused.
 *   * the GROUP SHAPE, which depends on how many people turn up for THIS event.
 *
 * Returns null when there is nothing to inherit from, so the caller keeps the
 * shipped defaults rather than having to special-case an empty tournament.
 */
export function inheritableFrom(siblings: readonly SiblingEvent[]): Partial<EventFormatValues> | null {
  // The most recently created one: the page orders by created_at, so it is the
  // last. "What I just set up" is a better guess at intent than "what I set up
  // first", and it means correcting the format once fixes every event after it.
  const last = siblings.length > 0 ? siblings[siblings.length - 1] : undefined;
  if (!last?.match_format) return null;
  return {
    matchFormat: last.match_format as TournamentMatchFormat,
    gamesPerMatch: last.games_per_match == null ? '' : String(last.games_per_match),
    pointsPerGame: last.points_per_game == null ? '' : String(last.points_per_game),
  };
}

export const EMPTY_FORMAT_VALUES: EventFormatValues = {
  matchFormat: 'best_of_3_to_21',
  gamesPerMatch: '',
  pointsPerGame: '',
  seededFrom: '',
  seedBy: 'wins',
  groupCount: '',
  qualifiersPerGroup: '2',
};

/** Server-action payload. Blank inputs become NULL, which means "use the enum". */
export function toFormatPayload(v: EventFormatValues) {
  const groups = v.groupCount === '' ? null : Number(v.groupCount);
  return {
    match_format: v.matchFormat,
    games_per_match: v.gamesPerMatch === '' ? null : Number(v.gamesPerMatch),
    points_per_game: v.pointsPerGame === '' ? null : Number(v.pointsPerGame),
    seeded_from_event_id: v.seededFrom === '' ? null : v.seededFrom,
    seed_by: v.seededFrom === '' ? null : v.seedBy,
    group_count: groups,
    // Same rule seed_by follows: only sent when there is something for it to
    // qualify out of, so a leftover number cannot be read later as a choice.
    qualifiers_per_group: groups !== null && groups > 1
      ? (v.qualifiersPerGroup === '' ? null : Number(v.qualifiersPerGroup))
      : null,
  };
}

export function EventFormatFields({
  value,
  onChange,
  siblings,
  format,
}: {
  value: EventFormatValues;
  onChange: (next: EventFormatValues) => void;
  siblings: SiblingEvent[];
  /**
   * The event's format, so the group fields can be offered only where they
   * mean something. Optional so a caller that has not been updated renders
   * exactly what it rendered before rather than a field it cannot honour.
   */
  format?: string;
}) {
  const set = (patch: Partial<EventFormatValues>) => onChange({ ...value, ...patch });
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;

  // A UI-only sentinel. It is never stored and never sent — match_format keeps
  // its four values, so this cannot collide with one.
  const CUSTOM = '__custom__';
  // Custom is not a stored flag but a FACT ABOUT THE ROW: an override exists.
  // Derived rather than held in state so an event loaded for editing opens on
  // whichever control matches what is actually saved, with no way for a
  // remembered toggle to disagree with the data.
  const isCustom = value.gamesPerMatch !== '' || value.pointsPerGame !== '';

  const isRoundRobin = format === 'round_robin';
  const groups = value.groupCount === '' ? 0 : Number(value.groupCount);

  // Preview the shape that will actually be played, so an exec can see at a
  // glance whether their typed values took effect over the preset.
  const effective = describeMatchShape({
    match_format: value.matchFormat,
    games_per_match: value.gamesPerMatch === '' ? null : Number(value.gamesPerMatch),
    points_per_game: value.pointsPerGame === '' ? null : Number(value.pointsPerGame),
  });

  return (
    <>
      {/* ONE QUESTION, ONE CONTROL. This used to be a preset dropdown AND two
          always-visible override boxes, which is the data model (00046: the
          enum, plus nullable columns that win when set) shown literally rather
          than the question an exec is actually answering. Nothing on screen
          said the boxes beat the dropdown — you had to infer it from the hint
          underneath. Now the shape is picked once; the numbers appear only if
          the answer is "something else".

          matchFormat is still written on the custom path, because the column is
          NOT NULL and 00046 keeps the enum as the fallback the whole codebase
          coalesces through. It is simply no longer what the exec is choosing. */}
      <Select
        label="Match Format"
        value={isCustom ? CUSTOM : value.matchFormat}
        onChange={(e) => {
          const picked = e.target.value;
          if (picked === CUSTOM) {
            // Seeded from the preset that was showing, not left blank: an exec
            // picking Custom wants to ADJUST the shape they were looking at,
            // and two empty boxes make them retype what they already had. The
            // preset's own numbers are always in bounds and always odd.
            const rules = TOURNAMENT_FORMAT_RULES[value.matchFormat];
            set({ gamesPerMatch: String(rules.bestOf), pointsPerGame: String(rules.target) });
          } else {
            // Back to a preset means the overrides must GO, not merely be
            // hidden — a stale value left in state would still be written and
            // would silently beat the preset just chosen.
            set({ matchFormat: picked as TournamentMatchFormat, gamesPerMatch: '', pointsPerGame: '' });
          }
        }}
        options={[
          ...Object.entries(TOURNAMENT_MATCH_FORMAT_LABELS).map(([v, label]) => ({ value: v, label })),
          { value: CUSTOM, label: 'Custom…' },
        ]}
      />

      {isCustom && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Games"
              type="number"
              min={minGames}
              max={maxGames}
              step={2}
              value={value.gamesPerMatch}
              onChange={(e) => set({ gamesPerMatch: e.target.value })}
            />
            <Input
              label="Points"
              type="number"
              min={minPoints}
              max={maxPoints}
              value={value.pointsPerGame}
              onChange={(e) => set({ pointsPerGame: e.target.value })}
            />
          </div>
          <p className="text-xs text-[var(--text-muted)] -mt-2">
            Played as <span className="font-medium text-[var(--text-primary)]">{effective}</span>. Games must be odd — an
            even best-of cannot be decided.
          </p>
        </>
      )}

      {/* GROUPS. Round robin only, because a bracket cannot be partitioned —
          the server refuses it and 00106 has a CHECK constraint for it, so
          offering the field on a knockout would be a dead invitation. */}
      {isRoundRobin && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Groups (optional)"
              type="number"
              min={1}
              max={32}
              value={value.groupCount}
              onChange={(e) => set({ groupCount: e.target.value })}
              placeholder="One pool"
            />
            <Input
              label="Advance Per Group"
              type="number"
              min={1}
              max={16}
              value={value.qualifiersPerGroup}
              onChange={(e) => set({ qualifiersPerGroup: e.target.value })}
              disabled={groups < 2}
            />
          </div>
          <p className="text-xs text-[var(--text-muted)] -mt-2">
            {groups >= 2 ? (
              <>
                {groups} groups, each a round robin of its own. The field is dealt out serpentine by seed so the strong
                entrants are spread across them, and the top{' '}
                <span className="font-medium text-[var(--text-primary)]">{value.qualifiersPerGroup || '2'}</span> of each
                group go into whichever bracket seeds from this event — group winners first, then runners-up.
              </>
            ) : (
              <>Leave blank for one pool where everybody plays everybody. Two or more makes this a group stage: far fewer
              matches, and a bracket can seed from it.</>
            )}
          </p>
        </>
      )}

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
                  s.format !== 'round_robin'
                    ? 'Single Elimination'
                    : (s.group_count ?? 1) >= 2
                      ? `Group Stage (${s.group_count})`
                      : 'Round Robin'
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
                The top finishers of that pool become this draw, in finishing order, up to Max Participants. From a group
                stage it is the top few of EACH group — winners seeded above runners-up, and two entrants from the same
                group kept apart in round one. The bracket cannot be generated until every pool match has been played.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
