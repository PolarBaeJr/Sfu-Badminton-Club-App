import { describe, it, expect, vi } from 'vitest';
import {
  ALL_FEATURES_ENABLED,
  FEATURES,
  type FeatureDefinition,
  defaultFeaturesValue,
  featureField,
  featureGate,
  featureOffMessage,
  parseFeatureFlags,
  playerFeatureFor,
  playerPathVisible,
  readFeatureFlags,
} from '../features';

// EVERY DOUBT RESOLVES TO "ON". Hiding a feature is not a safety property, so
// only an explicit `false` in the stored row switches one off.

describe('parseFeatureFlags', () => {
  it('reads an absent row as every feature on', () => {
    expect(parseFeatureFlags(null)).toEqual(ALL_FEATURES_ENABLED);
    expect(parseFeatureFlags(undefined)).toEqual(ALL_FEATURES_ENABLED);
    expect(parseFeatureFlags({})).toEqual(ALL_FEATURES_ENABLED);
  });

  it('switches off only the feature stored as an explicit false', () => {
    const flags = parseFeatureFlags({ tournaments_enabled: false });
    expect(flags.tournaments).toBe(false);
    for (const f of FEATURES.filter((f) => f.id !== 'tournaments')) expect(flags[f.id], f.id).toBe(true);
  });

  it('reads anything malformed as on', () => {
    for (const value of ['false', 0, null, 'no', [], {}]) {
      expect(parseFeatureFlags({ tournaments_enabled: value }).tournaments, JSON.stringify(value)).toBe(true);
    }
    expect(parseFeatureFlags('tournaments_enabled=false')).toEqual(ALL_FEATURES_ENABLED);
    expect(parseFeatureFlags([false])).toEqual(ALL_FEATURES_ENABLED);
  });

  it('round-trips the default row', () => {
    expect(parseFeatureFlags(defaultFeaturesValue())).toEqual(ALL_FEATURES_ENABLED);
    expect(Object.keys(defaultFeaturesValue())).toEqual(FEATURES.map((f) => featureField(f.id)));
  });
});

describe('readFeatureFlags', () => {
  const client = (result: unknown) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }),
  });

  it('reads the stored row', async () => {
    const flags = await readFeatureFlags(client({ data: { value: { sessions_enabled: false } }, error: null }));
    expect(flags.sessions).toBe(false);
    expect(flags.tournaments).toBe(true);
  });

  it('treats no row as every feature on', async () => {
    expect(await readFeatureFlags(client({ data: null, error: null }))).toEqual(ALL_FEATURES_ENABLED);
  });

  it('treats a failed read as every feature on, and says so', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readFeatureFlags(client({ data: null, error: { message: 'permission denied' } }))).toEqual(
      ALL_FEATURES_ENABLED,
    );
    expect(await readFeatureFlags({ from: () => { throw new Error('socket hang up'); } })).toEqual(
      ALL_FEATURES_ENABLED,
    );
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

describe('featureGate', () => {
  it('lets everyone in while on', () => {
    expect(featureGate(true, false)).toBe('allow');
    expect(featureGate(true, true)).toBe('allow');
  });

  it('redirects a viewer without the key and lets a holder in under a banner while off', () => {
    expect(featureGate(false, false)).toBe('redirect');
    expect(featureGate(false, true)).toBe('banner');
  });
});

describe('player paths', () => {
  it('maps a route and everything under it to its feature, by whole segment', () => {
    expect(playerFeatureFor('/tournaments')).toBe('tournaments');
    expect(playerFeatureFor('/tournaments/abc/events/def')).toBe('tournaments');
    expect(playerFeatureFor('/checkin/token')).toBe('sessions');
    expect(playerFeatureFor('/tournamentsx')).toBeNull();
    expect(playerFeatureFor('/feed')).toBeNull();
  });

  // PER FEATURE, not per person: the key to one switched-off feature opens that
  // feature and no other, which is the reason there is a key per feature.
  it('hides an off feature from everybody but a holder of its own key', () => {
    const flags = { ...ALL_FEATURES_ENABLED, challenges: false, tournaments: false };
    expect(playerPathVisible('/challenges', flags, [])).toBe(false);
    expect(playerPathVisible('/challenges', flags, ['challenges'])).toBe(true);
    expect(playerPathVisible('/challenges', flags, ['tournaments'])).toBe(false);
    expect(playerPathVisible('/tournaments', flags, ['tournaments'])).toBe(true);
    expect(playerPathVisible('/feed', flags, [])).toBe(true);
  });
});

describe('featureOffMessage', () => {
  it('names the feature in plain words', () => {
    expect(featureOffMessage('tournaments')).toBe('The club has switched tournaments off for now.');
    expect(featureOffMessage('my_stats')).toBe('The club has switched my stats off for now.');
  });
});

describe('feature text', () => {
  const features = FEATURES as readonly FeatureDefinition[];

  it('gives every feature a one-line summary with no em dash', () => {
    for (const f of features) {
      expect(f.summary.trim(), f.id).not.toBe('');
      expect(f.summary, f.id).not.toContain('\u2014');
    }
  });

  it('keeps the sessions warning apart from its description', () => {
    expect(features.find((f) => f.id === 'sessions')?.warning).toMatch(/^WARNING:/);
    for (const f of features) expect(f.description, f.id).not.toContain('WARNING');
  });
});
