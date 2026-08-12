import { describe, it, expect } from 'vitest';
import {
  parseTournamentBonusSettings,
  placementBonusFor,
  settingNumber,
  FALLBACK_TOURNAMENT_BONUS_SETTINGS,
} from '../tournament-bonuses';
import { PLACEMENT_BONUSES } from '../constants';

// The whole point of this parser is that a bad settings row degrades to the
// hardcoded constants rather than to 0. A zeroed bonus is invisible in the UI
// (the column just reads 0) but silently changes everyone's rating, so the
// fallback cases below are the load-bearing ones.

// Verbatim copy of the prod platform_settings 'tournament_bonuses' row
// (read 2026-08-05).
const PROD_ROW = {
  enabled: false,
  doubles_champion: 28,
  doubles_finalist: 18,
  singles_champion: 32,
  singles_finalist: 20,
  doubles_semifinalist: 10,
  singles_semifinalist: 12,
  doubles_quarterfinalist: 4,
  singles_quarterfinalist: 6,
};

describe('settingNumber', () => {
  it('accepts real numbers, including an explicit 0', () => {
    expect(settingNumber(32, 99)).toBe(32);
    expect(settingNumber(0, 99)).toBe(0);
    expect(settingNumber(1.5, 99)).toBe(1.5);
  });

  it('accepts non-blank numeric strings', () => {
    expect(settingNumber('32', 99)).toBe(32);
    expect(settingNumber(' 32 ', 99)).toBe(32);
  });

  it('falls back for the values that Number() would coerce to 0', () => {
    // Number(null) === 0, Number('') === 0, Number([]) === 0 — every one of
    // these would silently zero a bonus if we used a bare Number().
    expect(settingNumber(null, 99)).toBe(99);
    expect(settingNumber(undefined, 99)).toBe(99);
    expect(settingNumber('', 99)).toBe(99);
    expect(settingNumber('   ', 99)).toBe(99);
    expect(settingNumber([], 99)).toBe(99);
    expect(settingNumber({}, 99)).toBe(99);
    expect(settingNumber(false, 99)).toBe(99);
  });

  it('falls back for garbage, negatives and non-finite numbers', () => {
    expect(settingNumber('abc', 99)).toBe(99);
    expect(settingNumber(-5, 99)).toBe(99);
    expect(settingNumber(NaN, 99)).toBe(99);
    expect(settingNumber(Infinity, 99)).toBe(99);
  });
});

describe('parseTournamentBonusSettings', () => {
  it('reads the real prod row: bonuses globally OFF, amounts as stored', () => {
    // thirdPlace is NOT in the stored row — it predates the tier — so it comes
    // from PLACEMENT_BONUSES, which is the documented fallback for any key the
    // row does not supply. Adding the key to the row overrides it.
    expect(parseTournamentBonusSettings(PROD_ROW)).toEqual({
      enabled: false,
      singles: { champion: 32, finalist: 20, thirdPlace: 16, semifinalist: 12, quarterfinalist: 6 },
      doubles: { champion: 28, finalist: 18, thirdPlace: 14, semifinalist: 10, quarterfinalist: 4 },
    });
  });

  it('honours edited amounts', () => {
    const s = parseTournamentBonusSettings({ ...PROD_ROW, enabled: true, singles_champion: 50 });
    expect(s.enabled).toBe(true);
    expect(s.singles.champion).toBe(50);
    // untouched siblings keep their stored values
    expect(s.singles.finalist).toBe(20);
  });

  it('honours a deliberate 0 — "no bonus for this placement" is a valid setting', () => {
    const s = parseTournamentBonusSettings({ ...PROD_ROW, singles_quarterfinalist: 0 });
    expect(s.singles.quarterfinalist).toBe(0);
  });

  it('falls back to PLACEMENT_BONUSES — never 0 — for a missing key', () => {
    const { singles_champion: _omitted, ...withoutChampion } = PROD_ROW;
    const s = parseTournamentBonusSettings(withoutChampion);
    expect(s.singles.champion).toBe(PLACEMENT_BONUSES.singles.champion);
  });

  it('falls back for null and unparseable values', () => {
    const s = parseTournamentBonusSettings({
      ...PROD_ROW,
      singles_champion: null,
      doubles_champion: 'thirty',
      singles_finalist: '',
      doubles_finalist: -1,
    });
    expect(s.singles.champion).toBe(PLACEMENT_BONUSES.singles.champion);
    expect(s.doubles.champion).toBe(PLACEMENT_BONUSES.doubles.champion);
    expect(s.singles.finalist).toBe(PLACEMENT_BONUSES.singles.finalist);
    expect(s.doubles.finalist).toBe(PLACEMENT_BONUSES.doubles.finalist);
  });

  it('an entirely absent section yields the constants, with bonuses enabled', () => {
    // Absent section => "what the code did before this change": the per-event
    // column governed alone, so the global switch must not default to off.
    for (const missing of [null, undefined, {}]) {
      expect(parseTournamentBonusSettings(missing)).toEqual(FALLBACK_TOURNAMENT_BONUS_SETTINGS);
    }
  });

  it('only an explicit false disables; a garbage enabled value stays on', () => {
    expect(parseTournamentBonusSettings({ enabled: false }).enabled).toBe(false);
    expect(parseTournamentBonusSettings({ enabled: 'false' }).enabled).toBe(false);
    expect(parseTournamentBonusSettings({ enabled: true }).enabled).toBe(true);
    expect(parseTournamentBonusSettings({ enabled: null }).enabled).toBe(true);
    expect(parseTournamentBonusSettings({ enabled: 'yes' }).enabled).toBe(true);
    expect(parseTournamentBonusSettings({ enabled: 1 }).enabled).toBe(true);
  });
});

describe('placementBonusFor', () => {
  const amounts = { champion: 32, finalist: 20, thirdPlace: 16, semifinalist: 12, quarterfinalist: 6 };

  it('maps the placement bands', () => {
    expect(placementBonusFor(1, amounts)).toBe(32);
    expect(placementBonusFor(2, amounts)).toBe(20);
    // Third is its own tier now: the club plays a best-of-3 play-off for it,
    // and it used to pay exactly what losing that play-off paid.
    expect(placementBonusFor(3, amounts)).toBe(16);
    expect(placementBonusFor(4, amounts)).toBe(12);
    expect(placementBonusFor(5, amounts)).toBe(6);
    expect(placementBonusFor(8, amounts)).toBe(6);
  });

  it('awards nothing outside the bands or with no position', () => {
    expect(placementBonusFor(9, amounts)).toBe(0);
    expect(placementBonusFor(null, amounts)).toBe(0);
    expect(placementBonusFor(undefined, amounts)).toBe(0);
    expect(placementBonusFor(0, amounts)).toBe(0);
  });
});
