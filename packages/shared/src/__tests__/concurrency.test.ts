import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../utils/concurrency';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
  it('never exceeds the limit, and still runs everything', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 5, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBe(5);
    expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
  });

  it('returns results in INPUT order, not completion order', async () => {
    const out = await mapWithConcurrency([30, 0, 10], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 0, 10]);
  });

  it('lets in-flight tasks settle before the failure surfaces', async () => {
    // The pool stops starting work, but nothing already running is abandoned
    // mid-request — which for a push send means no half-issued HTTP request.
    let settled = 0;
    let started = 0;
    await expect(
      mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (n) => {
        started += 1;
        await tick();
        settled += 1;
        if (n === 1) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(settled).toBe(started);
    expect(started).toBeLessThan(20); // it really did stop early
  });

  it('does nothing for an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
