// What a screen shows for each stage: its groups with their tables, and the
// named matches with the slots they are waiting on. Both apps read this.

import type { FormatConfig, FormatStage, GroupsStage, SlotRef, StageMatchDef } from './schema';
import {
  groupTable,
  resolveSlots,
  resolveStageMatches,
  sourceStages,
  stageComplete,
  stageMatches,
  stageReady,
} from './advance';
import type { FormatResults, StageStandingRow } from './standings';
import { poolLabel, slotRefLabel, stageGroupLabel } from './labels';

export interface StageViewRow extends StageStandingRow {
  place: number;
  /** This place is one a later stage takes from (a group place, a best-of-place, a pool winner candidate). */
  advancingPlace: boolean;
  /** This entry has been resolved into a later stage. */
  qualified: boolean;
}

export interface StageViewGroup {
  pool: number;
  group: number;
  label: string;
  rows: StageViewRow[];
  complete: boolean;
}

export interface StageViewPool {
  pool: number;
  label: string;
  groups: StageViewGroup[];
}

export interface StageViewSide {
  /** The slot in words: "G2 winner", "Seed 3". */
  slot: string;
  /** The entry, once known. */
  entry: string | null;
}

export interface StageViewFixture {
  label: string;
  name: string;
  a: StageViewSide;
  b: StageViewSide;
  winnerPlace: number | null;
  loserPlace: number | null;
}

export interface StageView {
  /** 1-based, as tournament_matches.stage stores it. */
  number: number;
  stage: FormatStage;
  drawn: boolean;
  complete: boolean;
  /** Every stage this one reads from is played out (owner decision 9). */
  ready: boolean;
  /** Names of the earlier stages still being played, when not ready. */
  waitingOn: string[];
  /** A groups stage, drawn: its pools and their groups. Empty otherwise. */
  pools: StageViewPool[];
  /** A 'matches' stage: every fixture with its slots, resolved as far as the results go. */
  fixtures: StageViewFixture[];
}

function placesTakenFrom(cfg: FormatConfig, stageKey: string): (pool: number, group: number) => Set<number> {
  const refs: SlotRef[] = [];
  for (const s of cfg.stages) {
    if (s.entrants.from === 'slots') refs.push(...s.entrants.slots);
    if (s.kind === 'matches') for (const m of s.matches) refs.push(m.a, m.b);
  }
  return (pool, group) => {
    const places = new Set<number>();
    for (const r of refs) {
      if (r.type === 'seed' || r.stage !== stageKey) continue;
      if (r.type === 'group_place' && r.pool === pool && r.group === group) places.add(r.place);
      if (r.type === 'group_rank') places.add(r.place);
      if (r.type === 'pool_place' && r.pool === pool) places.add(1);
    }
    return places;
  };
}

function resolvedEntrants(cfg: FormatConfig, results: FormatResults, from: number): Set<string> {
  const ids = new Set<string>();
  for (const s of cfg.stages.slice(from)) {
    for (const slot of resolveSlots(cfg, s.key, results)) if (slot.entry) ids.add(slot.entry);
    for (const m of resolveStageMatches(cfg, s.key, results)) {
      if (m.a.entry) ids.add(m.a.entry);
      if (m.b.entry) ids.add(m.b.entry);
    }
  }
  return ids;
}

function groupsView(cfg: FormatConfig, stage: GroupsStage, index: number, results: FormatResults): StageViewPool[] {
  const takes = placesTakenFrom(cfg, stage.key);
  const onward = resolvedEntrants(cfg, results, index + 1);
  const pools = new Map<number, StageViewGroup[]>();
  const groups = results.groups
    .filter((g) => g.stage === stage.key)
    .sort((x, y) => x.pool - y.pool || x.group - y.group);
  for (const g of groups) {
    const t = groupTable(cfg, stage, results, g.pool, g.group);
    const places = takes(g.pool, g.group);
    const view: StageViewGroup = {
      pool: g.pool,
      group: g.group,
      label: stageGroupLabel(stage, g.pool, g.group),
      complete: t.complete,
      rows: t.rows.map((r, i) => ({
        ...r,
        place: i + 1,
        advancingPlace: places.has(i + 1),
        qualified: onward.has(r.id),
      })),
    };
    const list = pools.get(g.pool) ?? [];
    list.push(view);
    pools.set(g.pool, list);
  }
  return [...pools.entries()].map(([pool, gs]) => ({
    pool,
    label: stage.pools === 1 || stage.groupsPerPool === 1 ? '' : poolLabel(pool),
    groups: gs,
  }));
}

function fixturesView(cfg: FormatConfig, stage: FormatStage, results: FormatResults): StageViewFixture[] {
  if (stage.kind !== 'matches') return [];
  const resolved = resolveStageMatches(cfg, stage.key, results);
  return stage.matches.map((def: StageMatchDef, i) => ({
    label: def.label,
    name: def.name,
    a: { slot: slotRefLabel(def.a, cfg), entry: resolved[i]?.a.entry ?? null },
    b: { slot: slotRefLabel(def.b, cfg), entry: resolved[i]?.b.entry ?? null },
    winnerPlace: def.winnerPlace ?? null,
    loserPlace: def.loserPlace ?? null,
  }));
}

/** Every stage of the event, in order, as a screen shows it. */
export function stagesView(cfg: FormatConfig, results: FormatResults): StageView[] {
  return cfg.stages.map((stage, i) => {
    const drawn = stageMatches(results, stage.key).length > 0;
    const ready = stageReady(cfg, stage.key, results);
    return {
      number: i + 1,
      stage,
      drawn,
      complete: stageComplete(results, stage.key),
      ready,
      waitingOn: ready
        ? []
        : sourceStages(cfg, stage.key)
          .filter((k) => !stageComplete(results, k))
          .map((k) => cfg.stages.find((s) => s.key === k)?.name ?? k),
      pools: stage.kind === 'groups' && drawn ? groupsView(cfg, stage, i, results) : [],
      fixtures: fixturesView(cfg, stage, results),
    };
  });
}

/**
 * What a staged match is called: a named match's own name, otherwise the
 * round name the draw stored. null when the row is not a staged match.
 */
export function stagedMatchName(
  cfg: FormatConfig | null,
  m: { stage?: number | null; match_label?: string | null; round_name?: string | null; round_number?: number | null },
): string | null {
  if (!cfg || m.stage == null) return null;
  const stage = cfg.stages[m.stage - 1];
  if (stage?.kind === 'matches' && m.match_label) {
    const def = stage.matches.find((d) => d.label === m.match_label);
    if (def) return def.name;
  }
  return m.round_name || (m.round_number != null ? `Round ${m.round_number}` : null);
}

/**
 * A staged match's heading on a list: "G2 Group B · Round 3" in a groups stage,
 * otherwise its name ("Final", "Semi-final"). null for a legacy row.
 */
export function stagedMatchHeading(
  cfg: FormatConfig | null,
  m: {
    stage?: number | null;
    pool_number?: number | null;
    group_number?: number | null;
    match_label?: string | null;
    round_name?: string | null;
    round_number?: number | null;
  },
): string | null {
  const name = stagedMatchName(cfg, m);
  if (!cfg || m.stage == null) return name;
  const stage = cfg.stages[m.stage - 1];
  if (stage?.kind !== 'groups' || m.group_number == null) return name;
  const group = stageGroupLabel(stage, m.pool_number ?? 1, m.group_number);
  return name ? `${group} · ${name}` : group;
}
