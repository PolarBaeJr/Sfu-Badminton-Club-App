import { describe, expect, it } from 'vitest';
import { endsInKnockout } from '../../tournament-phases';
import { eventStatusLabel } from '../../constants';
import {
  anyStageRated,
  buildStageRows,
  checkFormatConfig,
  describeStageScoring,
  describeStagedFormat,
  formatResultsFrom,
  matchSides,
  poolsThenPlacement,
  poolsThenSemisFinal,
  stagedConfigEditRefusal,
  stagedMatchHeading,
  stagedMatchName,
  stagesView,
  withEveryStageUnrated,
  type StagedMatchRow,
} from '..';

const TEAMS = ['Kestrel', 'Heron', 'Wren', 'Plover', 'Egret', 'Swift', 'Finch', 'Lark', 'Osprey', 'Tern', 'Rook', 'Merlin',
  'Curlew', 'Dunlin', 'Gannet', 'Shrike'];

/** Two pools of two groups of four, played out with the better seed winning 15 to 9. */
function playedEvent() {
  const cfg = poolsThenPlacement({ pools: 2, groupsPerPool: 2, groupSize: 4 });
  const entries = TEAMS.map((t, i) => ({ id: `team-${t.toLowerCase()}`, seed: i + 1, status: 'checked_in' }));
  const seed = new Map(entries.map((e) => [e.id, e.seed]));
  let n = 0;
  const rows = buildStageRows(cfg, 'groups', entries.map((e) => ({ id: e.id })), '', { rng: () => 0.5, newId: () => `m${++n}` });
  const played: StagedMatchRow[] = rows.map((r) => {
    const winner = seed.get(r.a!)! < seed.get(r.b!)! ? r.a : r.b;
    return {
      stage: 1, status: 'completed', pool_number: r.pool_number, group_number: r.group_number, round_number: r.round_number,
      match_label: null, is_third_place: false, a: r.a, b: r.b, winner,
      scores: [winner === r.a ? { a: 15, b: 9 } : { a: 9, b: 15 }],
    };
  });
  return { cfg, entries, rows, played };
}

describe('formatResultsFrom', () => {
  it('reads groups off the matches, the field in seed order, and who is out', () => {
    const { cfg, entries, played } = playedEvent();
    const shuffled = [...entries].reverse().map((e, i) => (i === 0 ? { ...e, status: 'withdrawn' } : e));
    const res = formatResultsFrom(cfg, shuffled, [...played, { ...played[0]!, stage: null }]);
    expect(res.field.map((f) => f.seed)).toEqual(entries.map((e) => e.seed));
    expect(res.groups).toHaveLength(4);
    expect(res.groups.every((g) => g.members.length === 4)).toBe(true);
    expect(res.matches).toHaveLength(played.length);
    expect(res.out).toEqual([shuffled[0]!.id]);
  });

  it('takes the sides from the pair columns in doubles and the participant ones in singles', () => {
    const row = { pair_a_id: 'p1', pair_b_id: 'p2', winner_pair_id: 'p2', participant_a_id: 's1', participant_b_id: 's2', winner_participant_id: 's1' };
    expect(matchSides(row, true)).toEqual({ a: 'p1', b: 'p2', winner: 'p2' });
    expect(matchSides(row, false)).toEqual({ a: 's1', b: 's2', winner: 's1' });
  });
});

describe('stagesView', () => {
  it('shows nothing drawn and the finals waiting on the groups before play', () => {
    const { cfg, entries } = playedEvent();
    const [groups, finals] = stagesView(cfg, formatResultsFrom(cfg, entries, []));
    expect(groups!.drawn).toBe(false);
    expect(groups!.ready).toBe(true);
    expect(finals!.ready).toBe(false);
    expect(finals!.waitingOn).toEqual(['Group stage']);
    expect(finals!.fixtures[0]!.a).toEqual({ slot: 'Seed 1', entry: null });
  });

  it('ranks each group, marks the places that go through, and fills the final', () => {
    const { cfg, entries, played } = playedEvent();
    const [groups, finals] = stagesView(cfg, formatResultsFrom(cfg, entries, played));
    const final = () => finals!.fixtures[0]!;
    expect(groups!.complete).toBe(true);
    expect(groups!.pools.map((p) => p.label)).toEqual(['G1', 'G2']);
    const groupA = groups!.pools[0]!.groups[0]!;
    expect(groupA.label).toBe('G1 Group A');
    expect(groupA.rows[0]!.wins).toBe(3);
    expect(groupA.rows[0]!.advancingPlace).toBe(true);
    expect(groupA.rows[1]!.advancingPlace).toBe(false);
    const through = groups!.pools.flatMap((p) => p.groups.flatMap((g) => g.rows.filter((r) => r.qualified).map((r) => r.id)));
    expect(through.sort()).toEqual([final().a.entry, final().b.entry].sort());
    expect(finals!.ready).toBe(true);
    expect(final().a.entry).toBe('team-kestrel');
    expect(final().winnerPlace).toBe(1);
  });
});

describe('match names on a screen', () => {
  const cfg = poolsThenSemisFinal();
  it('names a group match by its group and round, and a named match by its name', () => {
    expect(stagedMatchHeading(cfg, { stage: 1, pool_number: 3, group_number: 2, round_name: 'Round 2' })).toBe('G3 Group B · Round 2');
    expect(stagedMatchHeading(cfg, { stage: 3, match_label: 'bronze', round_name: 'Finals' })).toBe('Third place');
    expect(stagedMatchName(cfg, { stage: 2, match_label: 'semi1', round_name: 'x' })).toBe('Semi-final 1');
    expect(stagedMatchHeading(null, { stage: null, round_name: 'Final' })).toBe(null);
  });

  it('says a stage\'s scoring in words', () => {
    expect(describeStageScoring(cfg.stages[0]!.scoring)).toBe('1 game to 15, no win by two, head starts');
    expect(describeStageScoring(cfg.stages[2]!.scoring)).toBe('1 game to 21, win by two, cap 30, head starts');
    expect(describeStageScoring({ bestOf: 3, target: 21, winByTwo: true, cap: null, handicap: false, forfeit: null }))
      .toBe('Best of 3 to 21, win by two');
  });
});

describe('checkFormatConfig', () => {
  it('passes a preset and words a broken config by stage and match', () => {
    expect(checkFormatConfig(poolsThenPlacement()).ok).toBe(true);
    const cfg = poolsThenPlacement();
    const broken = {
      ...cfg,
      stages: [cfg.stages[0], { ...cfg.stages[1], matches: [{ ...(cfg.stages[1] as { matches: unknown[] }).matches[0] as object, a: { type: 'seed', n: 9 } }] }],
    };
    const res = checkFormatConfig(broken);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('Stage 2 (Finals), match 1 (Final), side A: Seed 9 does not exist: this stage has 4 entrants.');
  });

  it('says "Enter a number" for a cleared box rather than "received nan"', () => {
    const cfg = poolsThenPlacement();
    const res = checkFormatConfig({ ...cfg, stages: [{ ...cfg.stages[0], pools: Number.NaN }, cfg.stages[1]] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('Stage 1 (Group stage), pools: Enter a number.');
  });
});

describe('editing a drawn config', () => {
  const cfg = poolsThenPlacement();
  it('allows anything before a draw and a later stage after one', () => {
    const later = { ...cfg, stages: [cfg.stages[0]!, { ...cfg.stages[1]!, name: 'Placement' }] };
    expect(stagedConfigEditRefusal(cfg, later, new Set())).toBeNull();
    expect(stagedConfigEditRefusal(cfg, later, new Set([1]))).toBeNull();
  });

  it('refuses a drawn stage, removing one, and the categories once drawn', () => {
    const changed = { ...cfg, stages: [{ ...cfg.stages[0]!, name: 'Pools' }, cfg.stages[1]!] };
    expect(stagedConfigEditRefusal(cfg, changed, new Set([1]))).not.toBeNull();
    expect(stagedConfigEditRefusal(cfg, { ...cfg, stages: [cfg.stages[1]!] }, new Set([1]))).not.toBeNull();
    expect(stagedConfigEditRefusal(cfg, { ...cfg, categories: cfg.categories.slice(0, 2) }, new Set([1]))).not.toBeNull();
  });

  it('turns every stage unrated for an external event', () => {
    const rated = { ...cfg, stages: cfg.stages.map((s) => ({ ...s, rated: true, scoring: { ...s.scoring, handicap: false } })) };
    expect(anyStageRated(rated)).toBe(true);
    expect(anyStageRated(withEveryStageUnrated(rated))).toBe(false);
  });
});

describe('a staged event on the shared predicates', () => {
  it('ends in a knockout only when its last stage is not groups', () => {
    expect(endsInKnockout('staged', poolsThenPlacement())).toBe(true);
    const groupsOnly = { ...poolsThenPlacement(), stages: [poolsThenPlacement().stages[0]] };
    expect(endsInKnockout('staged', groupsOnly)).toBe(false);
    expect(endsInKnockout('staged', null)).toBe(false);
  });

  it('labels its first draw as a stage', () => {
    expect(eventStatusLabel('staged', 'bracket_generated')).toBe('Stage 1 Drawn');
    expect(eventStatusLabel('single_elimination', 'bracket_generated')).toBe('Bracket Generated');
    expect(eventStatusLabel('staged', 'live')).toBe('Live');
  });
});

describe('describeStagedFormat', () => {
  it('names the stage count and the scoring when every stage agrees', () => {
    const cfg = poolsThenSemisFinal({ finalsTarget: 15 });
    expect(describeStagedFormat(cfg)).toBe('3 stages, games to 15');
  });

  it('reads two runs of scoring in order', () => {
    expect(describeStagedFormat(poolsThenSemisFinal())).toBe('3 stages, games to 15, then games to 21');
    const cfg = poolsThenSemisFinal();
    cfg.stages = cfg.stages.map((st, i) => (i === 0 ? st : { ...st, scoring: { ...st.scoring, bestOf: 3 } }));
    expect(describeStagedFormat(cfg)).toBe('3 stages, games to 15, then best of 3 to 21');
  });

  it('is the count alone for a mix of more than two runs, and "Staged" with no config', () => {
    const cfg = poolsThenSemisFinal();
    cfg.stages[2] = { ...cfg.stages[2]!, scoring: { ...cfg.stages[2]!.scoring, target: 11 } };
    expect(describeStagedFormat(cfg)).toBe('3 stages');
    expect(describeStagedFormat(null)).toBe('Staged');
  });

  it('says one stage in the singular', () => {
    const cfg = poolsThenSemisFinal();
    expect(describeStagedFormat({ ...cfg, stages: [cfg.stages[0]!] })).toBe('1 stage, games to 15');
  });
});
