import { describe, it, expect } from 'vitest';
import {
  getTournamentBonusSettings,
  readTournamentBonusSettingsForDisplay,
} from '../platform-settings';
import { PLACEMENT_BONUSES } from '@badminton/shared';

// THE DANGEROUS FAILURE, RESTATED. It was first written down as "silently
// disabled": a read error must not be mistaken for `enabled: false`, or a
// transient Supabase hiccup would quietly stop awarding bonuses for a whole
// tournament. That is true, and the fallback it justified — return the
// constants, which are `enabled: true` — turned out to be the worse half of
// the same mistake, because it made the OTHER lie instead: an error read as
// "bonuses are on" and paid them. A bonus goes straight into a rating and
// there is no unpay, so an unknown is now an unknown and the read throws.
//
// The display path keeps a fallback, but it falls back to ABSENT rather than
// to a default object, so nothing downstream can mistake it for a
// configuration anybody chose.
function client(result: { data?: unknown; error?: unknown } | Error) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (result instanceof Error) throw result;
            return { data: result.data ?? null, error: result.error ?? null };
          },
        }),
      }),
    }),
  };
}

const PROD_VALUE = {
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

describe('getTournamentBonusSettings', () => {
  it('returns the stored row', async () => {
    const s = await getTournamentBonusSettings(client({ data: { value: PROD_VALUE } }));
    expect(s.enabled).toBe(false);
    expect(s.singles.champion).toBe(32);
    expect(s.doubles.quarterfinalist).toBe(4);
  });

  it('a missing row leaves bonuses enabled on the constants', async () => {
    const s = await getTournamentBonusSettings(client({ data: null }));
    expect(s).toEqual({
      enabled: true,
      singles: { ...PLACEMENT_BONUSES.singles },
      doubles: { ...PLACEMENT_BONUSES.doubles },
    });
  });

  it('a query error throws rather than guessing either way', async () => {
    await expect(
      getTournamentBonusSettings(client({ error: { message: 'permission denied' } }))
    ).rejects.toThrow(/could not be read/);
  });

  it('a thrown client error propagates', async () => {
    await expect(
      getTournamentBonusSettings(client(new Error('network down')))
    ).rejects.toThrow('network down');
  });

  // The specific regression: the old fallback object was `enabled: true`, so a
  // failed read authorised a payment. Nothing may come back from a failed read
  // that a caller could test `.enabled` on at all.
  it('never yields an enabled settings object from a failed read', async () => {
    const outcome = await getTournamentBonusSettings(
      client({ error: { message: 'schema cache miss' } })
    ).then(v => ({ resolved: v as unknown }), () => ({ resolved: null }));
    expect(outcome.resolved).toBeNull();
  });
});

describe('readTournamentBonusSettingsForDisplay', () => {
  it('returns the stored row like the enforcement read', async () => {
    const s = await readTournamentBonusSettingsForDisplay(client({ data: { value: PROD_VALUE } }));
    expect(s?.enabled).toBe(false);
    expect(s?.singles.champion).toBe(32);
  });

  it('a missing row still yields the constants, because that is a real state', async () => {
    const s = await readTournamentBonusSettingsForDisplay(client({ data: null }));
    expect(s?.enabled).toBe(true);
    expect(s?.doubles.champion).toBe(PLACEMENT_BONUSES.doubles.champion);
  });

  it('a failed read is ABSENT, not the default constants', async () => {
    const s = await readTournamentBonusSettingsForDisplay(
      client({ error: { message: 'permission denied' } })
    );
    expect(s).toBeNull();
  });

  it('a thrown client error is absent too rather than taking the page down', async () => {
    const s = await readTournamentBonusSettingsForDisplay(client(new Error('network down')));
    expect(s).toBeNull();
  });
});
