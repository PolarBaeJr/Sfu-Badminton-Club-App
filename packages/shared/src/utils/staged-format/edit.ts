// What may change in a staged event's config once play has started: stages
// not yet drawn, and nothing else that a drawn row was built from.

import type { FormatConfig } from './schema';

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/**
 * Why `next` may not replace `prev`, or null when it may. `drawn` holds the
 * 1-based numbers of the stages that have matches.
 *
 *  - A drawn stage keeps its place in the list and every one of its settings:
 *    its rows were built from them and its results judged by them.
 *  - Categories and head starts are frozen once anything is drawn, because a
 *    knockout row snapshots its head starts when its sides arrive, so a change
 *    would judge later rows of the same stage by different numbers.
 *  - Stages after the last drawn one stay editable, and may be added or removed.
 */
export function stagedConfigEditRefusal(
  prev: FormatConfig | null,
  next: FormatConfig,
  drawn: ReadonlySet<number>,
): string | null {
  if (drawn.size === 0) return null;
  if (!prev) return 'This event has matches but no readable stage settings, so they cannot be changed here.';
  if (!same(prev.categories, next.categories) || !same(prev.headStarts, next.headStarts)) {
    return 'Categories and head starts are fixed once the first stage is drawn.';
  }
  for (const n of [...drawn].sort((a, b) => a - b)) {
    const before = prev.stages[n - 1];
    const after = next.stages[n - 1];
    if (!after) return `Stage ${n} (${before?.name ?? 'drawn'}) has been drawn, so it cannot be removed.`;
    if (!same(before, after)) {
      return `Stage ${n} (${before?.name ?? after.name}) has been drawn, so its settings are fixed. Only stages not yet drawn can change.`;
    }
  }
  return null;
}

/** The config with every stage unrated, for an event that never moves ratings. */
export function withEveryStageUnrated(cfg: FormatConfig): FormatConfig {
  return { ...cfg, stages: cfg.stages.map((s) => ({ ...s, rated: false })) };
}

/** Does any stage move ratings. */
export function anyStageRated(cfg: Pick<FormatConfig, 'stages'>): boolean {
  return cfg.stages.some((s) => s.rated !== false);
}
