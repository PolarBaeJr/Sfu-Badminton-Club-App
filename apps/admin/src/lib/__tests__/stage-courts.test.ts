import { describe, it, expect } from 'vitest';
import type { StageRow, TournamentCourt } from '@badminton/shared';
import { resolveStageCourts, rowForInsert, unknownStageCourtsMessage } from '../tournament-actions/stage-rows';

// A STAGE'S COURT LABELS AGAINST THE TOURNAMENT'S COURTS (00273). The draw
// refuses a label the tournament does not have before it tears anything down,
// and never names court_id to a database that does not have the column.

function row(court: string | null, over: Partial<StageRow> = {}): StageRow {
  return {
    id: `m-${court ?? 'none'}`,
    draw_generation_id: 'gen-1',
    stage: 1,
    pool_number: 1,
    group_number: 1,
    slot: 1,
    match_label: null,
    court,
    round_number: 1,
    round_name: 'Round 1',
    bracket_position: 1,
    match_number: 1,
    games_per_match: 1,
    points_per_game: 15,
    handicap_a: 0,
    handicap_b: 0,
    is_bye: false,
    is_third_place: false,
    status: 'ready',
    winner_to_match_id: null,
    winner_to_position: null,
    loser_to_match_id: null,
    loser_to_position: null,
    a: 'team-kestrel',
    b: 'team-heron',
    winner: null,
    ...over,
  };
}

const COURTS: TournamentCourt[] = [
  { id: 'c1', label: 'Court 1', sort_order: 1, active: true },
  { id: 'c2', label: '2', sort_order: 2, active: true },
  { id: 'c9', label: '9', sort_order: 9, active: false },
];

describe('resolveStageCourts', () => {
  it('has no ids at all before 00273', () => {
    expect(resolveStageCourts(null, [row('1')])).toEqual({ courtIds: null, unknown: [] });
  });

  it('keeps the labels as text when the tournament lists no courts', () => {
    const { courtIds, unknown } = resolveStageCourts([], [row('1'), row('7')]);
    expect(courtIds?.size).toBe(0);
    expect(unknown).toEqual([]);
  });

  it('resolves labels by key and returns the unknown and switched-off ones', () => {
    const { courtIds, unknown } = resolveStageCourts(COURTS, [row('1'), row('2'), row('9'), row('10'), row(null)]);
    expect(courtIds?.get('1')).toBe('c1');
    expect(courtIds?.get('2')).toBe('c2');
    expect(unknown).toEqual(['9', '10']);
  });
});

describe('unknownStageCourtsMessage', () => {
  it('names one court or several', () => {
    expect(unknownStageCourtsMessage(['9'])).toBe(
      "Court 9 in this stage is missing from the tournament's courts or switched off. Fix it in Courts on the tournament page, or change the stage.",
    );
    expect(unknownStageCourtsMessage(['9', '10'])).toBe(
      "Courts 9, 10 in this stage are missing from the tournament's courts or switched off. Fix them in Courts on the tournament page, or change the stage.",
    );
  });
});

describe('rowForInsert', () => {
  it('leaves court_id out entirely before 00273', () => {
    const out = rowForInsert('event-1', row('1'), true, null);
    expect('court_id' in out).toBe(false);
    expect(out.court).toBe('1');
    expect(out.pair_a_id).toBe('team-kestrel');
  });

  it('writes the resolved court id, and null for a row with no court or a text-only label', () => {
    const ids = new Map([['1', 'c1']]);
    expect(rowForInsert('event-1', row('1'), false, ids).court_id).toBe('c1');
    expect(rowForInsert('event-1', row(null), false, ids).court_id).toBeNull();
    expect(rowForInsert('event-1', row('7'), false, new Map()).court_id).toBeNull();
    expect(rowForInsert('event-1', row('1'), false, ids).participant_a_id).toBe('team-kestrel');
  });
});
