import { describe, it, expect } from 'vitest';
import {
  SETTING_SECTION,
  DEFAULT_SECTION,
  sectionForSettingKey,
  settingsForSection,
} from '../platform-setting-sections';

// The nine rows that exist in platform_settings on production (verified
// 2026-08-06). Pinned here so splitting them across two pages can never lose
// one: a key that is neither in SETTING_SECTION nor caught by the default would
// simply stop rendering, with no error anywhere.
const PRODUCTION_KEYS = [
  'challenge_rules',
  'inactivity_rules',
  'rating_defaults',
  'repeat_opponent_caps',
  'season_settings',
  'session_attendance',
  'session_caps',
  'tournament_bonuses',
  'walkover_rules',
];

describe('platform settings section map', () => {
  it('assigns every production key to exactly one section', () => {
    for (const key of PRODUCTION_KEYS) {
      expect(SETTING_SECTION[key], `${key} is unmapped`).toBeDefined();
    }
    expect(Object.keys(SETTING_SECTION).sort()).toEqual([...PRODUCTION_KEYS].sort());
  });

  it('puts the rating-affecting knobs on Ratings', () => {
    for (const key of ['rating_defaults', 'tournament_bonuses', 'season_settings']) {
      expect(sectionForSettingKey(key)).toBe('ratings');
    }
  });

  it('puts the account-governing knobs on Accounts', () => {
    for (const key of [
      'challenge_rules',
      'repeat_opponent_caps',
      'session_caps',
      'walkover_rules',
      'inactivity_rules',
      'session_attendance',
    ]) {
      expect(sectionForSettingKey(key)).toBe('accounts');
    }
  });

  // The failure this guards against is invisible, so it gets its own test: a
  // tenth settings row added by a future migration must surface SOMEWHERE.
  it('surfaces an unmapped key rather than dropping it', () => {
    expect(sectionForSettingKey('some_future_key')).toBe(DEFAULT_SECTION);
    const rows = [{ key: 'some_future_key' }, { key: 'rating_defaults' }];
    expect(settingsForSection(rows, 'accounts')).toEqual([{ key: 'some_future_key' }]);
  });

  it('partitions rows — every row lands on one page and no page shows another’s', () => {
    const rows = PRODUCTION_KEYS.map((key) => ({ key }));
    const ratings = settingsForSection(rows, 'ratings');
    const accounts = settingsForSection(rows, 'accounts');
    expect(ratings.length + accounts.length).toBe(rows.length);
    expect(ratings.some((r) => accounts.includes(r))).toBe(false);
  });

  it('renders in map order, not the database’s alphabetical order', () => {
    // Handed to the page alphabetically by .order('key'); Starting Elo should
    // still come before Tournament Bonuses.
    const rows = [{ key: 'season_settings' }, { key: 'rating_defaults' }, { key: 'tournament_bonuses' }];
    expect(settingsForSection(rows, 'ratings').map((r) => r.key)).toEqual([
      'rating_defaults',
      'tournament_bonuses',
      'season_settings',
    ]);
  });
});
