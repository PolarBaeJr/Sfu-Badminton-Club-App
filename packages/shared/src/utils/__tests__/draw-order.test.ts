import { describe, it, expect } from 'vitest';
import { shuffleWithRng } from '../draw-order';

// mulberry32, the same generator the admin draw uses, so the test exercises a
// realistic rng without importing the admin app.
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const field = Array.from({ length: 16 }, (_, i) => `team-${i + 1}`);

describe('shuffleWithRng', () => {
  it('gives the same order for the same seed', () => {
    expect(shuffleWithRng(field, rngFrom(42))).toEqual(shuffleWithRng(field, rngFrom(42)));
  });

  it('gives a different order for a different seed', () => {
    expect(shuffleWithRng(field, rngFrom(42))).not.toEqual(shuffleWithRng(field, rngFrom(43)));
  });

  it('is a permutation of its input', () => {
    for (let seed = 0; seed < 50; seed++) {
      const out = shuffleWithRng(field, rngFrom(seed));
      expect(out).toHaveLength(field.length);
      expect([...out].sort()).toEqual([...field].sort());
    }
  });

  it('does not mutate its input', () => {
    const input = [...field];
    shuffleWithRng(input, rngFrom(7));
    expect(input).toEqual(field);
  });

  it('can put any entry first, so the top seed is not fixed', () => {
    const firsts = new Set<string>();
    for (let seed = 0; seed < 400; seed++) firsts.add(shuffleWithRng(field, rngFrom(seed))[0]!);
    expect(firsts.size).toBe(field.length);
  });

  it('handles an empty or single-entry field', () => {
    expect(shuffleWithRng([], rngFrom(1))).toEqual([]);
    expect(shuffleWithRng(['only'], rngFrom(1))).toEqual(['only']);
  });
});
