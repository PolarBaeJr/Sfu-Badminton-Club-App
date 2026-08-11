import { describe, it, expect } from 'vitest';
import { RATINGS_SECTIONS, isPlaced, leftoversFor } from '../ratings-sections';
import { FIELD_META } from '../platform-setting-fields';
import { sectionForSettingKey, settingsForSection } from '../platform-setting-sections';

// /ratings draws a HAND-WRITTEN layout over JSONB rows, which trades the
// generic form's one real safety property — an unrecognised row still renders —
// for a screen that reads like English. These tests are the price of that
// trade. 00041 is the case in point: six rating controls sat in the console
// doing nothing for months because nothing checked that a field on screen was
// a field the engine reads.

/**
 * The blobs as the migrations actually leave them: 00006 seeds, 00029 adds
 * sweep_margin_multiplier, 00041 adds max_elo/min_elo, 00055 adds tier_size.
 * Written out by hand rather than derived from the layout, so that a field
 * dropped from the layout fails here instead of agreeing with itself.
 */
const LIVE_ROWS = [
  {
    key: 'rating_defaults',
    value: {
      default_elo: 400,
      provisional_threshold: 8,
      singles_k_provisional: 80,
      singles_k_established: 48,
      doubles_k_provisional: 64,
      doubles_k_established: 36,
      sweep_margin_multiplier: 1.15,
      max_elo: 1500,
      min_elo: 100,
    },
  },
  {
    key: 'tournament_bonuses',
    value: {
      enabled: true,
      singles_champion: 32,
      singles_finalist: 20,
      singles_semifinalist: 12,
      singles_quarterfinalist: 6,
      doubles_champion: 28,
      doubles_finalist: 18,
      doubles_semifinalist: 10,
      doubles_quarterfinalist: 4,
    },
  },
  {
    key: 'season_settings',
    value: {
      soft_compression_enabled: false,
      compression_factor: 0.1,
      tier_size: 200,
    },
  },
];

describe('the /ratings layout', () => {
  it('places only fields the console has metadata for', () => {
    for (const section of RATINGS_SECTIONS) {
      for (const { key, field } of section.fields) {
        expect(FIELD_META[key]?.[field], `${key}.${field}`).toBeDefined();
      }
    }
  });

  it('places only keys the Ratings section actually fetches', () => {
    // A key moved to Accounts in platform-setting-sections.ts would leave this
    // page rendering controls bound to a row it never receives — and the row
    // would then be editable from two screens, last write wins.
    for (const section of RATINGS_SECTIONS) {
      for (const { key } of section.fields) {
        expect(sectionForSettingKey(key), key).toBe('ratings');
      }
    }
  });

  it('never places the same field twice', () => {
    const seen = new Set<string>();
    for (const section of RATINGS_SECTIONS) {
      for (const { key, field } of section.fields) {
        expect(seen.has(`${key}.${field}`), `${key}.${field}`).toBe(false);
        seen.add(`${key}.${field}`);
      }
    }
  });

  it('has a rail entry for every section and no empty editable section', () => {
    for (const section of RATINGS_SECTIONS) {
      expect(section.id).toMatch(/^[a-z-]+$/);
      expect(section.label.length).toBeGreaterThan(0);
      if (!section.reference) expect(section.fields.length).toBeGreaterThan(0);
    }
  });

  it('leaves nothing unplaced on the settings as the migrations seed them', () => {
    const rows = settingsForSection(LIVE_ROWS, 'ratings');
    expect(rows).toHaveLength(3);
    expect(leftoversFor(rows)).toEqual({ fields: [], rawKeys: [] });
  });

  it('reports a field a later migration adds rather than swallowing it', () => {
    // The failure this guards: someone adds a knob to rating_defaults, the
    // layout never learns about it, and it disappears from the console with no
    // error anywhere — 00041's exact history.
    const rows = [
      {
        key: 'rating_defaults',
        value: { ...LIVE_ROWS[0]!.value, doubles_scale: 900 },
      },
    ];
    const leftovers = leftoversFor(rows);
    // No FIELD_META for it either, so the whole row falls to the raw editor —
    // ugly, but visible, which is the point.
    expect(leftovers.rawKeys).toEqual(['rating_defaults']);
  });

  it('reports a known-but-unplaced field on a key it can lay out', () => {
    expect(isPlaced('rating_defaults', 'default_elo')).toBe(true);
    // provisional_threshold IS placed; pick a field with metadata that this
    // page deliberately does not draw. inactivity_rules belongs to /accounts,
    // so exercise the mechanism with a key whose metadata exists.
    const rows = [
      { key: 'inactivity_rules', value: { inactive_threshold_days: 45, purge_after_days: 365 } },
    ];
    const leftovers = leftoversFor(rows);
    expect(leftovers.rawKeys).toEqual([]);
    expect(leftovers.fields).toEqual([
      { key: 'inactivity_rules', field: 'inactive_threshold_days' },
      { key: 'inactivity_rules', field: 'purge_after_days' },
    ]);
  });

  it('sends a whole unknown row to the raw editor', () => {
    const leftovers = leftoversFor([{ key: 'some_future_key', value: { a: 1 } }]);
    expect(leftovers.rawKeys).toEqual(['some_future_key']);
    expect(leftovers.fields).toEqual([]);
  });

  it('sends a row with a non-scalar value to the raw editor', () => {
    const leftovers = leftoversFor([
      { key: 'rating_defaults', value: { ...LIVE_ROWS[0]!.value, default_elo: { nested: 1 } } },
    ]);
    expect(leftovers.rawKeys).toEqual(['rating_defaults']);
  });
});
