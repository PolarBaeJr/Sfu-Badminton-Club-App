// A CHANNEL THAT DIED CANNOT SAY SO, AND NOTHING REPLAYS WHAT IT MISSED.
//
// Every live-* component in both apps opened a channel with a bare
// `.subscribe()` — no callback. That is not a stylistic omission. The status
// callback is the ONLY channel supabase-js has for reporting that the
// subscription failed; there is no promise rejection, no thrown error and no
// event. Read the compiled client (@supabase/realtime-js 2.112.0,
// dist/main/RealtimeChannel.js) and there are four ways it speaks:
//
//   _onError(...)                  -> callback(CHANNEL_ERROR, reason)
//   _onClose(...)                  -> callback(CLOSED)
//   joinPush.receive('error')      -> callback(CHANNEL_ERROR, new Error(...))
//   joinPush.receive('timeout')    -> callback(TIMED_OUT)
//
// and one that is worse than the rest — `_updatePostgresBindings`, where the
// server's binding list does not line up with the client's:
//
//   this.unsubscribe();
//   this.state = errored;
//   callback?.(CHANNEL_ERROR, new Error('mismatch between server and client
//                                        bindings for postgres changes'));
//
// It calls `unsubscribe()` ITSELF. Every binding on that channel is gone — on
// /feed that is the whole club river plus the viewer's challenges, on the
// tournament screens it is four tables at once — and the only announcement is
// the callback nobody passed. The screen keeps rendering its first paint
// forever and looks exactly like a quiet evening.
//
// THE SECOND HALF IS THAT RECOVERY IS NOT ENOUGH ON ITS OWN. Postgres CDC has
// no replay: a subscriber is sent what happens after it joins and nothing
// before. So a channel that drops and comes back is not "fine again" — every
// write in the gap was delivered to nobody and will never be re-sent. The
// deploy window is the case that made this a bug rather than a theory: the
// Realtime container restarts on every push, every open tab in the club loses
// its channel at the same instant, and the ones that rejoin carry on from a
// render that is now minutes stale. So a resubscribe MUST be followed by a
// re-fetch, which on every one of these surfaces means router.refresh().
//
// WHAT THIS MODULE IS AND IS NOT. It is the policy — classify a status, decide
// whether the screen missed something, decide when to give up on the built-in
// rejoin and rebuild the channel from scratch. It deliberately knows nothing
// about React or about Supabase: the channel is typed structurally (see
// RecoverableChannel) so this file has no imports at all and can be unit-tested
// under vitest's node environment, which is where every assertion about the
// backoff and the missed-something flag lives. The React binding that turns
// `onRebuild` into an effect re-run is packages/ui/src/use-live-channel.ts, and
// it is eight lines because everything hard is here.

/**
 * The statuses supabase-js hands a `.subscribe()` callback.
 *
 * WIDENED WITH `string` ON PURPOSE, and it is not laziness. supabase-js types
 * that parameter as `REALTIME_SUBSCRIBE_STATES`, a string ENUM, and TypeScript
 * treats an enum member and the identical string literal as unrelated types in
 * both directions — `REALTIME_SUBSCRIBE_STATES.SUBSCRIBED` is not assignable to
 * `'SUBSCRIBED'` and never will be. A tight union here would therefore make
 * every real `RealtimeChannel` fail to satisfy `RecoverableChannel`, and the
 * only fixes on offer are importing the enum (a runtime dependency, in a module
 * whose entire point is having none) or an `as` cast at all eight call sites.
 * The intersection keeps editor completion for the four names that matter while
 * accepting the enum member the client actually passes.
 */
export type RealtimeSubscribeStatus =
  | 'SUBSCRIBED'
  | 'CHANNEL_ERROR'
  | 'TIMED_OUT'
  | 'CLOSED'
  | (string & {});

/**
 * The only thing this module needs a channel to do.
 *
 * Structural rather than `RealtimeChannel` so the policy has no import and the
 * tests can hand it a four-line fake — the same reason stale-build.ts types its
 * headers structurally instead of pulling in DOM lib types.
 */
export type RecoverableChannel = {
  subscribe(callback: (status: RealtimeSubscribeStatus, err?: Error) => void): unknown;
};

/**
 * How long to let supabase-js try on its own before tearing the channel down
 * and building a new one.
 *
 * TUNED AGAINST THE CLIENT'S OWN LADDER, not guessed. @supabase/phoenix's
 * Channel schedules its rejoins on `rejoinAfterMs`, which defaults to
 * [1000, 2000, 5000] and then 10000 (assets/js/phoenix/socket.js), and
 * RealtimeClient reconnects the SOCKET on [1000, 2000, 5000, 10000]
 * (RECONNECT_INTERVALS). Cumulatively the built-in rejoin attempts land at
 * roughly 1s, 3s and 8s. Ten seconds therefore lets all three run before this
 * module intervenes, which matters because the built-in path is strictly
 * cheaper: it re-joins the SAME channel object with its bindings intact, where
 * a rebuild unmounts and re-runs the whole effect.
 *
 * The rebuild exists for the case the built-in path structurally cannot fix.
 * On a binding mismatch the client calls `unsubscribe()`, phoenix's own
 * `onClose` handler then runs `this.rejoinTimer.reset()` and
 * `this.socket.remove(this)` — the channel is off the socket's list and has no
 * timer left. Nothing will ever rejoin it. Only a new channel will do.
 */
export const REALTIME_REBUILD_BASE_MS = 10_000;

/** Doubling, capped here. A minute is long enough that a tab left open through
 *  a genuinely long outage is not hammering a Raspberry Pi, and short enough
 *  that it recovers on its own within a minute of the server returning rather
 *  than waiting for somebody to pull to refresh. */
export const REALTIME_REBUILD_MAX_MS = 60_000;

/**
 * Spread, in both the rebuild and the recovery refresh.
 *
 * THE MOTIVATING CASE IS SYNCHRONISED BY CONSTRUCTION. A deploy drops every
 * open tab in the club at the same instant and brings them back at the same
 * instant, so an unjittered implementation has every phone in the gym firing
 * `router.refresh()` into a container that is seconds old, on one Pi, at once —
 * a thundering herd assembled by the very event we are recovering from. Two
 * seconds of spread costs a member nothing they can perceive (the refresh is
 * silent) and turns a spike into a ramp.
 */
export const REALTIME_JITTER_MS = 2_000;

/**
 * Delay before rebuilding, given how many rebuilds this screen has already
 * tried since it was last healthy. Exponential, capped, jittered.
 *
 * `random` is injected so the backoff can be asserted exactly in tests rather
 * than within a tolerance band.
 */
export function realtimeRebuildDelayMs(attempt: number, random: () => number = Math.random): number {
  const backoff = Math.min(REALTIME_REBUILD_BASE_MS * 2 ** Math.max(0, attempt), REALTIME_REBUILD_MAX_MS);
  return backoff + Math.floor(random() * REALTIME_JITTER_MS);
}

/** Delay before the catch-up re-fetch. Pure jitter — see REALTIME_JITTER_MS. */
export function realtimeRecoveryDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * REALTIME_JITTER_MS);
}

export type RealtimeRecoveryOptions = {
  /**
   * Re-fetch. Called once per recovery, never on a healthy first subscribe —
   * see `missedSomething`. On every surface in this repository this ends in
   * router.refresh(), except the announcements badge in bottom-nav.tsx which
   * re-runs its own count query.
   */
  onRecover: () => void;
  /**
   * Throw this channel away and build a new one, with the attempt number to
   * carry into the next round. The caller is the only thing that knows how to
   * re-register the bindings, so the policy can only ask.
   */
  onRebuild: (attempt: number) => void;
  /**
   * Whether this screen has already missed events — true when this channel is
   * itself a rebuild of one that died. Decides whether the FIRST SUBSCRIBED is
   * a recovery (re-fetch) or a normal page load (do not).
   *
   * Getting this wrong in the generous direction is not a small mistake: a
   * `true` default would fire an extra full re-render of the server component
   * on every mount of every live surface in both apps, for nothing.
   */
  missedSomething?: boolean;
  /** Rebuilds already attempted since this screen was last healthy. */
  attempt?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/**
 * Subscribe, and keep the subscription honest.
 *
 * Returns a teardown to be called from the effect's cleanup BEFORE
 * `removeChannel`. That ordering is load-bearing: `removeChannel` unsubscribes,
 * which delivers CLOSED through this very callback, and a torn-down instance
 * that still listened would read its own dismantling as an outage and queue a
 * rebuild against an unmounted tree.
 */
export function subscribeWithRecovery(
  channel: RecoverableChannel,
  options: RealtimeRecoveryOptions,
): () => void {
  const {
    onRecover,
    onRebuild,
    random = Math.random,
    setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let attempt = options.attempt ?? 0;
  let missed = options.missedSomething ?? false;
  let stopped = false;
  // TWO HANDLES, NOT ONE. They can legitimately overlap: a channel can recover,
  // queue its catch-up re-fetch, and drop again inside the jitter window. The
  // queued re-fetch is kept rather than cancelled in that case — it pulls
  // whatever the server has NOW, which is strictly better than the render the
  // screen is otherwise stuck on, and the next recovery will fetch again.
  let rebuildTimer: unknown;
  let recoveryTimer: unknown;

  channel.subscribe((status) => {
    // Everything below is a no-op once the caller has torn down. See the note
    // on the return value: CLOSED arrives as a CONSEQUENCE of teardown.
    if (stopped) return;

    if (status === 'SUBSCRIBED') {
      // The built-in rejoin got there first, or the rebuild worked. Either way
      // there is nothing left to rebuild.
      if (rebuildTimer !== undefined) {
        clearTimer(rebuildTimer);
        rebuildTimer = undefined;
      }
      attempt = 0;
      // A HEALTHY FIRST SUBSCRIBE MUST NOT RE-FETCH. This is the branch that
      // separates a fix from a page that double-loads: the server component
      // has just rendered, the channel has just joined, and nothing has been
      // missed. Only a subscribe that FOLLOWS a failure is a recovery.
      if (!missed) return;
      missed = false;
      recoveryTimer = setTimer(() => {
        recoveryTimer = undefined;
        onRecover();
      }, realtimeRecoveryDelayMs(random));
      return;
    }

    if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;

    // ALL THREE ARE THE SAME EVENT AS FAR AS THE SCREEN IS CONCERNED: from
    // here on, writes are landing in the database and not arriving here. It
    // does not matter to the reader whether the socket dropped, the join timed
    // out or the server unsubscribed us over a binding mismatch.
    missed = true;
    // One rebuild in flight at a time. A socket outage delivers CHANNEL_ERROR
    // and then CLOSED in quick succession, and re-arming on the second would
    // reset the timer the first one set and could do so indefinitely.
    if (rebuildTimer !== undefined) return;
    const next = attempt + 1;
    rebuildTimer = setTimer(() => {
      rebuildTimer = undefined;
      onRebuild(next);
    }, realtimeRebuildDelayMs(attempt, random));
  });

  return () => {
    stopped = true;
    if (rebuildTimer !== undefined) clearTimer(rebuildTimer);
    if (recoveryTimer !== undefined) clearTimer(recoveryTimer);
    rebuildTimer = undefined;
    recoveryTimer = undefined;
  };
}
