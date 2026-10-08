// Head starts by team category. The matrix is read row against column: the
// points the ROW category starts each game on when it plays the COLUMN one.

import type { MatchRules } from '../game-rules';
import { formatConfigSchema } from './schema';
import type { FormatCategory, FormatConfig, FormatStage, HeadStarts } from './schema';

export function defaultCategories(): FormatCategory[] {
  return [
    { key: 'mens', label: "Men's" },
    { key: 'womens', label: "Women's" },
    { key: 'mixed', label: 'Mixed' },
  ];
}

export function defaultHeadStarts(): HeadStarts {
  return { womens: { mens: 5 }, mixed: { mens: 3 } };
}

/** Each side's start for one meeting. A side with no category starts on 0. */
export function headStartFor(
  cfg: Pick<FormatConfig, 'headStarts'>,
  catA: string | null | undefined,
  catB: string | null | undefined,
): { a: number; b: number } {
  const start = (row: string | null | undefined, col: string | null | undefined) =>
    row && col ? cfg.headStarts[row]?.[col] ?? 0 : 0;
  return { a: start(catA, catB), b: start(catB, catA) };
}

/**
 * The category a team most likely plays in, from its members' competition
 * categories. Unknown for anybody means no suggestion: the organiser decides.
 */
export function suggestCategory(
  players: ReadonlyArray<{ competition_category: 'mens' | 'womens' | null }>,
): 'mens' | 'womens' | 'mixed' | null {
  if (players.length === 0) return null;
  const cats = players.map((p) => p.competition_category);
  if (cats.some((c) => c == null)) return null;
  if (cats.every((c) => c === 'mens')) return 'mens';
  if (cats.every((c) => c === 'womens')) return 'womens';
  return 'mixed';
}

/** The category a gendered doubles event implies for every team in it. */
export function categoryForEventType(eventType: string | null | undefined): 'mens' | 'womens' | 'mixed' | null {
  switch (eventType) {
    case 'mens_doubles': return 'mens';
    case 'womens_doubles': return 'womens';
    case 'mixed_doubles': return 'mixed';
    default: return null;
  }
}

/** The suggestion, when the event lists it as a category; otherwise null. */
export function pickCategory(
  cfg: Pick<FormatConfig, 'categories'> | null | undefined,
  suggestion: string | null | undefined,
): string | null {
  if (!cfg || !suggestion) return null;
  return cfg.categories.some((c) => c.key === suggestion) ? suggestion : null;
}

/** The rules one match of a stage is judged by, head starts included when the stage uses them. */
export function stageMatchRules(
  cfg: Pick<FormatConfig, 'headStarts'>,
  stage: Pick<FormatStage, 'scoring'>,
  catA: string | null | undefined,
  catB: string | null | undefined,
): MatchRules {
  const s = stage.scoring;
  const starts = s.handicap ? headStartFor(cfg, catA, catB) : { a: 0, b: 0 };
  return {
    bestOf: s.bestOf,
    target: s.target,
    winByTwo: s.winByTwo,
    cap: s.cap,
    startA: starts.a,
    startB: starts.b,
  };
}

/** An event's stored format_config, or null when it is absent or not a valid version 1 config. */
export function parseFormatConfig(raw: unknown): FormatConfig | null {
  if (raw == null) return null;
  const parsed = formatConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The rules a drawn staged match is judged by: its stage's scoring, with the
 * head starts snapshotted on the row when it was drawn. null when the row is
 * not a staged match or its stage is not in the config.
 */
export function stagedMatchRules(
  cfg: FormatConfig | null,
  match: { stage?: number | null; handicap_a?: number | null; handicap_b?: number | null },
): MatchRules | null {
  if (!cfg || match.stage == null) return null;
  const stage = cfg.stages[match.stage - 1];
  if (!stage) return null;
  const s = stage.scoring;
  return {
    bestOf: s.bestOf,
    target: s.target,
    winByTwo: s.winByTwo,
    cap: s.cap,
    startA: match.handicap_a ?? 0,
    startB: match.handicap_b ?? 0,
  };
}

/**
 * Does a match move ratings: the event is rated and so is its stage. Reads the
 * stored config raw, as the SQL backstop does (00272), so a config that no
 * longer parses still cannot rate an unrated stage. An absent rated key is rated.
 */
export function stagedMatchRated(
  event: { rated?: boolean | null; format_config?: unknown },
  stage: number | null | undefined,
): boolean {
  if (event.rated === false) return false;
  if (stage == null) return true;
  const stages = (event.format_config as { stages?: unknown } | null | undefined)?.stages;
  const entry = Array.isArray(stages) ? (stages[stage - 1] as { rated?: unknown } | undefined) : undefined;
  return entry?.rated !== false;
}
