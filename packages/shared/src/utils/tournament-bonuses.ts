// Parser for the platform_settings 'tournament_bonuses' row.
//
// The eight placement amounts used to live only in PLACEMENT_BONUSES, and the
// admin panel exposed eight editable fields that wrote to a JSONB row nothing
// ever read. The two happened to agree, which is worse than disagreeing: an
// admin could edit the panel, see the values persist, and nothing about
// finalising an event would change. Everything that awards or displays a
// placement bonus now goes through this parser, with PLACEMENT_BONUSES kept as
// the fallback for anything the row does not supply.
//
// The stored shape is FLAT (singles_champion, doubles_finalist, ...) because
// the settings form renders one input per JSONB key. The nested shape below is
// what call sites want. That mapping lives here so no caller has to know the
// flat key names.
import { PLACEMENT_BONUSES } from './constants';

export interface PlacementBonusAmounts {
  champion: number;
  finalist: number;
  /** Won the third-place play-off. Fourth still takes `semifinalist`. */
  thirdPlace: number;
  semifinalist: number;
  quarterfinalist: number;
}

export interface TournamentBonusSettings {
  /**
   * Global master switch. Bonuses are awarded only when this AND the per-event
   * tournament_events.placement_bonus_enabled column both allow it.
   */
  enabled: boolean;
  singles: PlacementBonusAmounts;
  doubles: PlacementBonusAmounts;
}

// What we fall back to when the row cannot be read at all (query error, no
// row). Mirrors the hardcoded constants, i.e. today's behaviour.
export const FALLBACK_TOURNAMENT_BONUS_SETTINGS: TournamentBonusSettings = {
  enabled: true,
  singles: { ...PLACEMENT_BONUSES.singles },
  doubles: { ...PLACEMENT_BONUSES.doubles },
};

/**
 * Coerce one JSONB scalar to a non-negative number, falling back when it is
 * absent, null, or unparseable.
 *
 * Deliberately stricter than a bare `Number(x)`: `Number(null)`, `Number('')`
 * and `Number([])` are all 0, and a bonus silently collapsing to 0 is the exact
 * failure mode this whole change exists to prevent. Only real numbers and
 * non-blank numeric strings are accepted.
 *
 * An explicit 0 IS honoured — the settings form allows min: 0, so "no bonus for
 * quarter-finalists" is a legitimate configuration and must not be overridden
 * by the fallback. (This is why we cannot reuse num() from elo/engine.ts, which
 * treats 0 as unset because a K-factor of 0 would freeze every rating.)
 */
export function settingNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  return fallback;
}

/**
 * Parse a platform_settings 'tournament_bonuses' JSONB value.
 *
 * Note the deliberate asymmetry between `enabled` and the amounts:
 *
 *   - Amounts fall back to PLACEMENT_BONUSES when missing or garbage, so a
 *     half-filled row never zeroes anyone's award.
 *   - `enabled` falls back to TRUE when missing or garbage, because before this
 *     change the global flag was not read at all and the per-event column
 *     (default true) governed alone. Defaulting to false would turn bonuses off
 *     for anyone whose row predates the key. Only an explicit false disables.
 *
 * In other words: an unreadable setting always degrades to "what the code did
 * yesterday", in both directions.
 */
export function parseTournamentBonusSettings(value: unknown): TournamentBonusSettings {
  const row = (value ?? {}) as Record<string, unknown>;

  const enabledRaw = row.enabled;
  const enabled =
    typeof enabledRaw === 'boolean'
      ? enabledRaw
      : typeof enabledRaw === 'string'
        ? enabledRaw.trim().toLowerCase() !== 'false'
        : true;

  return {
    enabled,
    singles: {
      champion: settingNumber(row.singles_champion, PLACEMENT_BONUSES.singles.champion),
      finalist: settingNumber(row.singles_finalist, PLACEMENT_BONUSES.singles.finalist),
      thirdPlace: settingNumber(row.singles_thirdplace, PLACEMENT_BONUSES.singles.thirdPlace),
      semifinalist: settingNumber(row.singles_semifinalist, PLACEMENT_BONUSES.singles.semifinalist),
      quarterfinalist: settingNumber(
        row.singles_quarterfinalist,
        PLACEMENT_BONUSES.singles.quarterfinalist
      ),
    },
    doubles: {
      champion: settingNumber(row.doubles_champion, PLACEMENT_BONUSES.doubles.champion),
      finalist: settingNumber(row.doubles_finalist, PLACEMENT_BONUSES.doubles.finalist),
      thirdPlace: settingNumber(row.doubles_thirdplace, PLACEMENT_BONUSES.doubles.thirdPlace),
      semifinalist: settingNumber(row.doubles_semifinalist, PLACEMENT_BONUSES.doubles.semifinalist),
      quarterfinalist: settingNumber(
        row.doubles_quarterfinalist,
        PLACEMENT_BONUSES.doubles.quarterfinalist
      ),
    },
  };
}

/**
 * Bonus for a final_position under a given amounts table. Positions beyond the
 * quarter-final band earn nothing. Shared by the awarding path (finalize.ts)
 * and the display path (ResultsTab) so the table can never advertise a number
 * the finaliser would not actually apply.
 */
export function placementBonusFor(
  position: number | null | undefined,
  amounts: PlacementBonusAmounts
): number {
  if (!position || position < 1) return 0;
  if (position === 1) return amounts.champion;
  if (position === 2) return amounts.finalist;
  // THIRD IS ITS OWN TIER. Fourth keeps the semi-finalist amount — they did
  // reach a semi-final — so the gap is what the play-off was worth.
  if (position === 3) return amounts.thirdPlace;
  if (position === 4) return amounts.semifinalist;
  if (position <= 8) return amounts.quarterfinalist;
  return 0;
}
