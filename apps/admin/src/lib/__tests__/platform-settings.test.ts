import { describe, it, expect } from 'vitest';
import { getTournamentBonusSettings } from '../platform-settings';
import { PLACEMENT_BONUSES } from '@badminton/shared';

// The dangerous failure here is not "wrong amount", it is "silently disabled":
// a read error must not be mistaken for enabled: false, or a transient Supabase
// hiccup would quietly stop awarding bonuses for a whole tournament.
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

  it('a query error falls back to the constants rather than guessing disabled', async () => {
    const s = await getTournamentBonusSettings(client({ error: { message: 'permission denied' } }));
    expect(s.enabled).toBe(true);
    expect(s.singles.champion).toBe(PLACEMENT_BONUSES.singles.champion);
  });

  it('a thrown client error falls back too', async () => {
    const s = await getTournamentBonusSettings(client(new Error('network down')));
    expect(s.enabled).toBe(true);
    expect(s.doubles.champion).toBe(PLACEMENT_BONUSES.doubles.champion);
  });
});
