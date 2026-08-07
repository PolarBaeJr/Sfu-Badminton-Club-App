import { describe, it, expect } from 'vitest';
import { runBulk, summarizeBulk } from '../bulk-add';

/**
 * The multi-select dialogs loop a one-id-at-a-time server action. That is only
 * honest if a batch that half worked SAYS it half worked, so these tests are
 * mostly about the wording of one toast.
 */

describe('runBulk', () => {
  it('runs every id even after one throws', () => {
    // The failure that matters: stopping at the first error would leave the
    // exec with three of twelve added and no idea which three.
    return runBulk(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('Player already registered for this event');
    }).then((out) => {
      expect(out.succeeded).toEqual(['a', 'c']);
      expect(out.failures).toEqual([{ id: 'b', message: 'Player already registered for this event' }]);
    });
  });

  it('runs SEQUENTIALLY, not all at once', async () => {
    // addParticipantToEvent reads the current headcount before inserting. In
    // parallel every call would read the same pre-insert count and all of them
    // would walk past a full event.
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await runBulk(['a', 'b', 'c'], async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      order.push(id);
      inFlight--;
    });
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps a non-Error rejection from crashing the batch', async () => {
    // A server action can reject with anything; the loop must still finish and
    // still report the other ids.
    const out = await runBulk(['a', 'b'], async (id) => {
      if (id === 'a') throw 'nope';
    });
    expect(out.succeeded).toEqual(['b']);
    expect(out.failures[0]?.message).toBe('Failed');
  });

  it('does nothing at all for an empty selection', async () => {
    let calls = 0;
    const out = await runBulk([], async () => { calls++; });
    expect(calls).toBe(0);
    expect(out).toEqual({ succeeded: [], failures: [] });
  });
});

describe('summarizeBulk', () => {
  const labels = { done: 'Added', failed: 'Could not add', noun: 'participant' };
  const ok = (n: number) => Array.from({ length: n }, (_, i) => `ok${i}`);
  const bad = (n: number, message = 'Event is full') =>
    Array.from({ length: n }, (_, i) => ({ id: `bad${i}`, message }));

  it('states the shortfall when a batch only half worked', () => {
    // The requirement, verbatim: "added 9 of 12" beats a success toast that
    // hides three failures.
    const { message, tone } = summarizeBulk({ succeeded: ok(9), failures: bad(3) }, labels);
    expect(message).toContain('Added 9 of 12 participants');
    expect(tone).toBe('error');
  });

  it('never reports a partial batch as a success', () => {
    // A green toast is what makes three silent failures possible.
    expect(summarizeBulk({ succeeded: ok(11), failures: bad(1) }, labels).tone).not.toBe('success');
  });

  it('carries the reason, so the exec knows WHY the rest did not go in', () => {
    const { message } = summarizeBulk({ succeeded: ok(2), failures: bad(1, 'Draw is locked') }, labels);
    expect(message).toContain('Draw is locked');
  });

  it('collapses identical reasons instead of repeating them', () => {
    // Eight people into a full event is eight "Event is full" strings; the
    // sentence is only worth saying once.
    const { message } = summarizeBulk({ succeeded: [], failures: bad(8) }, labels);
    expect(message).toBe('Could not add 8 participants — Event is full');
  });

  it('counts the OTHER distinct reasons when they differ', () => {
    const failures = [
      { id: 'a', message: 'Event is full' },
      { id: 'b', message: 'Draw is locked' },
      { id: 'c', message: 'Player already registered for this event' },
    ];
    const { message } = summarizeBulk({ succeeded: ok(1), failures }, labels);
    expect(message).toBe('Added 1 of 4 participants — Event is full (+2 other errors)');
  });

  it('says "other error" in the singular for exactly two reasons', () => {
    const failures = [
      { id: 'a', message: 'Event is full' },
      { id: 'b', message: 'Draw is locked' },
    ];
    const { message } = summarizeBulk({ succeeded: [], failures }, labels);
    expect(message).toBe('Could not add 2 participants — Event is full (+1 other error)');
  });

  it('is a plain success when everything went in', () => {
    expect(summarizeBulk({ succeeded: ok(12), failures: [] }, labels)).toEqual({
      message: 'Added 12 participants',
      tone: 'success',
    });
  });

  it('uses the singular for a batch of one', () => {
    // The one-at-a-time case still goes through the same path, so it must not
    // read "Added 1 participants".
    expect(summarizeBulk({ succeeded: ok(1), failures: [] }, labels).message).toBe('Added 1 participant');
    expect(summarizeBulk({ succeeded: [], failures: bad(1) }, labels).message)
      .toBe('Could not add 1 participant — Event is full');
  });

  it('honours an irregular plural', () => {
    // "players present" is not "player presents".
    const { message } = summarizeBulk(
      { succeeded: ok(3), failures: [] },
      { done: 'Marked', failed: 'Could not mark', noun: 'player present', nounPlural: 'players present' },
    );
    expect(message).toBe('Marked 3 players present');
  });

  it('does not claim anything happened for an empty batch', () => {
    expect(summarizeBulk({ succeeded: [], failures: [] }, labels).tone).toBe('info');
  });
});
