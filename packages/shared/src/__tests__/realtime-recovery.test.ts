// WHAT A DEAD CHANNEL LOOKS LIKE FROM THE OUTSIDE: nothing.
//
// That is the whole reason these assertions exist rather than a manual check.
// The failure has no symptom — no error, no rejected promise, no console line —
// only a screen that keeps rendering its first paint. There is nothing to
// eyeball, so every claim in realtime-recovery.ts is pinned here.
//
// The fake channel below is four lines because RecoverableChannel is typed
// structurally for exactly this: the policy needs a `.subscribe()` that hands
// back a status, and inventing statuses by hand is the only way to reach the
// binding-mismatch path at all — reproducing it against a real server means
// exceeding Realtime's binding cap on purpose.

import { describe, it, expect, vi } from 'vitest';
import {
  REALTIME_JITTER_MS,
  REALTIME_REBUILD_BASE_MS,
  REALTIME_REBUILD_MAX_MS,
  realtimeRebuildDelayMs,
  subscribeWithRecovery,
  type RealtimeSubscribeStatus,
  type RecoverableChannel,
} from '../utils/realtime-recovery';

/** A channel that says whatever the test tells it to, when the test says so. */
function fakeChannel(): RecoverableChannel & { emit: (status: RealtimeSubscribeStatus) => void } {
  let listener: ((status: RealtimeSubscribeStatus, err?: Error) => void) | undefined;
  return {
    subscribe(callback) {
      listener = callback;
      return this;
    },
    emit(status) {
      listener?.(status);
    },
  };
}

/**
 * A timer queue the test drives by hand.
 *
 * Real timers would make every assertion below a race, and vitest's fake timers
 * would work but hide WHICH timer ran — half of what is being asserted here is
 * that exactly one thing was scheduled, at a delay computed from the backoff.
 */
function fakeClock() {
  const queued: { fn: () => void; ms: number; handle: number }[] = [];
  let next = 1;
  return {
    setTimer(fn: () => void, ms: number) {
      const handle = next++;
      queued.push({ fn, ms, handle });
      return handle;
    },
    clearTimer(handle: unknown) {
      const at = queued.findIndex((q) => q.handle === handle);
      if (at >= 0) queued.splice(at, 1);
    },
    /** Delays of everything still pending, in the order it was scheduled. */
    pending: () => queued.map((q) => q.ms),
    /** Run everything pending, oldest first. */
    run() {
      const due = queued.splice(0, queued.length);
      for (const q of due) q.fn();
    },
  };
}

function watch(
  channel: RecoverableChannel,
  clock: ReturnType<typeof fakeClock>,
  extra: Partial<Parameters<typeof subscribeWithRecovery>[1]> = {},
) {
  const onRecover = vi.fn();
  const onRebuild = vi.fn();
  const stop = subscribeWithRecovery(channel, {
    onRecover,
    onRebuild,
    // Zero jitter unless a test is specifically about jitter, so the delays
    // asserted below are the backoff and nothing else.
    random: () => 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  });
  return { onRecover, onRebuild, stop };
}

describe('subscribeWithRecovery', () => {
  it('does not re-fetch on a healthy first subscribe', () => {
    // THE ASSERTION THAT SEPARATES A FIX FROM A REGRESSION. "Re-fetch when the
    // channel subscribes" is the obvious implementation and it is wrong: every
    // one of these components mounts under a server render that is already
    // current, so it would fire a second full render of every live page in both
    // apps on every navigation, forever, to learn nothing.
    const channel = fakeChannel();
    const clock = fakeClock();
    const { onRecover } = watch(channel, clock);

    channel.emit('SUBSCRIBED');
    clock.run();

    expect(onRecover).not.toHaveBeenCalled();
    expect(clock.pending()).toEqual([]);
  });

  it('re-fetches on a subscribe that follows a failure', () => {
    // The recovery itself: the channel dropped, supabase-js's own rejoin got it
    // back before the rebuild was due, and the screen still has to catch up on
    // everything written in the gap because Postgres CDC replays nothing.
    const channel = fakeChannel();
    const clock = fakeClock();
    const { onRecover, onRebuild } = watch(channel, clock);

    channel.emit('SUBSCRIBED');
    channel.emit('CHANNEL_ERROR');
    channel.emit('SUBSCRIBED');
    clock.run();

    expect(onRecover).toHaveBeenCalledTimes(1);
    // And the pending rebuild was cancelled by the successful rejoin — the
    // built-in path is cheaper and it won.
    expect(onRebuild).not.toHaveBeenCalled();
  });

  it('treats all three failure statuses as the same event', () => {
    // They differ in cause and not in consequence: from the screen's side, a
    // socket drop, a join timeout and a server-side unsubscribe are all "writes
    // are landing in the database and not arriving here".
    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const) {
      const channel = fakeChannel();
      const clock = fakeClock();
      const { onRecover } = watch(channel, clock);

      channel.emit(status);
      channel.emit('SUBSCRIBED');
      clock.run();

      expect(onRecover, `${status} should count as missing events`).toHaveBeenCalledTimes(1);
    }
  });

  it('re-fetches on the first subscribe of a rebuilt channel', () => {
    // The binding-mismatch path, which is the one the built-in rejoin cannot
    // reach: supabase-js has called unsubscribe() itself and phoenix has taken
    // the channel off the socket, so the caller builds a NEW one — a different
    // object, a fresh policy instance — and that channel's very first
    // SUBSCRIBED is a recovery, not a page load.
    const channel = fakeChannel();
    const clock = fakeClock();
    const { onRecover } = watch(channel, clock, { missedSomething: true });

    channel.emit('SUBSCRIBED');
    clock.run();

    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('asks for a rebuild once, after the client has had its own go', () => {
    const channel = fakeChannel();
    const clock = fakeClock();
    const { onRebuild } = watch(channel, clock);

    // A socket outage delivers both in quick succession; re-arming on the
    // second would keep pushing the rebuild out indefinitely.
    channel.emit('CHANNEL_ERROR');
    channel.emit('CLOSED');

    // Ten seconds: @supabase/phoenix's rejoin ladder is [1000, 2000, 5000], so
    // its three attempts land at roughly 1s, 3s and 8s and all get to run first.
    expect(clock.pending()).toEqual([REALTIME_REBUILD_BASE_MS]);

    clock.run();
    expect(onRebuild).toHaveBeenCalledTimes(1);
    expect(onRebuild).toHaveBeenCalledWith(1);
  });

  it('does nothing at all once the caller has torn down', () => {
    // CLOSED IS THE NORMAL SOUND OF AN UNMOUNT. Every cleanup calls
    // removeChannel, which unsubscribes, which delivers CLOSED through this
    // callback — so a watcher that kept listening would read its own dismantling
    // as an outage and queue a rebuild against a tree React has thrown away.
    // Every navigation in either app does this.
    const channel = fakeChannel();
    const clock = fakeClock();
    const { onRecover, onRebuild, stop } = watch(channel, clock);

    stop();
    channel.emit('CLOSED');

    expect(clock.pending()).toEqual([]);
    clock.run();
    expect(onRebuild).not.toHaveBeenCalled();
    expect(onRecover).not.toHaveBeenCalled();
  });

  it('cancels a rebuild that was already queued when the caller tears down', () => {
    const channel = fakeChannel();
    const clock = fakeClock();
    const { onRebuild, stop } = watch(channel, clock);

    channel.emit('CHANNEL_ERROR');
    expect(clock.pending()).toEqual([REALTIME_REBUILD_BASE_MS]);

    stop();
    expect(clock.pending()).toEqual([]);
    clock.run();
    expect(onRebuild).not.toHaveBeenCalled();
  });

  it('backs off across rebuilds and forgets the backoff once healthy', () => {
    // `attempt` is carried across rebuilds by the caller (a ref in
    // useLiveChannel), which is the only way a NEW channel object can know how
    // long the old one had been failing.
    const clock = fakeClock();
    const second = fakeChannel();
    const { onRebuild } = watch(second, clock, { attempt: 1, missedSomething: true });

    second.emit('CHANNEL_ERROR');
    expect(clock.pending()).toEqual([REALTIME_REBUILD_BASE_MS * 2]);
    clock.run();
    expect(onRebuild).toHaveBeenCalledWith(2);

    // And a channel that comes back resets it, so an outage tonight does not
    // leave a tab opening next week's first rebuild a minute late.
    const third = fakeChannel();
    const clock2 = fakeClock();
    watch(third, clock2, { attempt: 4, missedSomething: true });
    third.emit('SUBSCRIBED');
    clock2.run();
    third.emit('CHANNEL_ERROR');
    expect(clock2.pending()).toEqual([REALTIME_REBUILD_BASE_MS]);
  });
});

describe('realtimeRebuildDelayMs', () => {
  it('doubles and then caps', () => {
    expect(realtimeRebuildDelayMs(0, () => 0)).toBe(REALTIME_REBUILD_BASE_MS);
    expect(realtimeRebuildDelayMs(1, () => 0)).toBe(REALTIME_REBUILD_BASE_MS * 2);
    // A tab left open through a genuinely long outage must not hammer the Pi.
    expect(realtimeRebuildDelayMs(9, () => 0)).toBe(REALTIME_REBUILD_MAX_MS);
  });

  it('spreads the herd a deploy assembles', () => {
    // THE MOTIVATING CASE IS SYNCHRONISED BY CONSTRUCTION: one deploy drops
    // every open tab in the club at the same instant. Without jitter they all
    // come back at the same instant too, and every phone in the gym refreshes
    // into a seconds-old container on one Raspberry Pi at once.
    expect(realtimeRebuildDelayMs(0, () => 0.999)).toBeGreaterThan(REALTIME_REBUILD_BASE_MS);
    expect(realtimeRebuildDelayMs(0, () => 0.999)).toBeLessThan(
      REALTIME_REBUILD_BASE_MS + REALTIME_JITTER_MS,
    );
    // Including at the cap, which is where a long outage parks every tab.
    expect(realtimeRebuildDelayMs(9, () => 0.5)).toBeGreaterThan(REALTIME_REBUILD_MAX_MS);
  });

  it('staggers the catch-up re-fetch itself, not only the rebuild', () => {
    // The rebuild is the rarer path. The common one is: server returns, every
    // tab's built-in rejoin succeeds within a second of every other tab's, and
    // each one wants a full server re-render. That is the stampede, and it
    // happens even when no rebuild is ever scheduled.
    const channel = fakeChannel();
    const clock = fakeClock();
    watch(channel, clock, { missedSomething: true, random: () => 0.9 });

    channel.emit('SUBSCRIBED');

    expect(clock.pending()).toEqual([Math.floor(0.9 * REALTIME_JITTER_MS)]);
  });
});
