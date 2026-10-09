// How pools, stages and slots read on a screen.

import { groupLabel } from '../tournament-phases';
import type { FormatConfig, FormatStage, SlotRef, StageScoring } from './schema';

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Pool 1 is "G1", as on the organiser's sheet. */
export function poolLabel(n: number): string {
  return `G${n}`;
}

export function stageLabel(stage: Pick<FormatStage, 'name'>): string {
  return stage.name;
}

/**
 * A group's name within its stage. One pool reads as plain groups ("Group A");
 * one group per pool (every legacy event) letters the pools, so a legacy group
 * still reads "Group A"; otherwise "G2 Group B".
 */
export function stageGroupLabel(
  stage: { pools: number; groupsPerPool: number } | undefined,
  pool: number,
  group: number,
): string {
  if (!stage || stage.pools === 1) return `Group ${groupLabel(group)}`;
  if (stage.groupsPerPool === 1) return `Group ${groupLabel(pool)}`;
  return `${poolLabel(pool)} Group ${groupLabel(group)}`;
}

/**
 * A slot in words: "G2 winner", "Group B 1st", "Winner of semi1", "Seed 3".
 * Pass the config to name groups by their stage's shape; `index` picks one
 * entrant out of a group_rank ref.
 */
export function slotRefLabel(ref: SlotRef, cfg?: FormatConfig, index = 0): string {
  const source = ref.type === 'seed' ? undefined : cfg?.stages.find((s) => s.key === ref.stage);
  const groups = source?.kind === 'groups' ? source : undefined;
  switch (ref.type) {
    case 'group_place':
      return `${stageGroupLabel(groups, ref.pool, ref.group)} ${ordinal(ref.place)}`;
    case 'pool_place':
      return ref.place === 1 ? `${poolLabel(ref.pool)} winner` : `${poolLabel(ref.pool)} ${ordinal(ref.place)} group winner`;
    case 'group_rank':
      return `${ordinal(index + 1)} best ${ordinal(ref.place)} place`;
    case 'match':
      return `${ref.result === 'winner' ? 'Winner' : 'Loser'} of ${ref.match}`;
    case 'seed':
      return `Seed ${ref.n}`;
  }
}

/** A stage's scoring in words: "1 game to 15, no win by two, head starts". */
export function describeStageScoring(s: StageScoring): string {
  let out = s.bestOf === 1 ? `1 game to ${s.target}` : `Best of ${s.bestOf} to ${s.target}`;
  out += s.winByTwo ? (s.cap != null ? `, win by two, cap ${s.cap}` : ', win by two') : ', no win by two';
  if (s.handicap) out += ', head starts';
  return out;
}

function shortScoring(s: Pick<StageScoring, 'bestOf' | 'target'>): string {
  return s.bestOf === 1 ? `games to ${s.target}` : `best of ${s.bestOf} to ${s.target}`;
}

/**
 * A staged event's format on one line, for an event card: "3 stages, games to
 * 15". Two runs of scoring read in order ("games to 15, then games to 21");
 * any more mixed than that is just the stage count. null (a config that does
 * not read) is "Staged".
 */
export function describeStagedFormat(cfg: FormatConfig | null): string {
  if (!cfg || cfg.stages.length === 0) return 'Staged';
  const n = cfg.stages.length;
  const count = `${n} stage${n === 1 ? '' : 's'}`;
  const runs: string[] = [];
  for (const st of cfg.stages) {
    const shape = shortScoring(st.scoring);
    if (runs[runs.length - 1] !== shape) runs.push(shape);
  }
  return runs.length <= 2 ? `${count}, ${runs.join(', then ')}` : count;
}
