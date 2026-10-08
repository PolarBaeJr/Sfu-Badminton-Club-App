'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  subscribeWithRecovery,
  type RecoverableChannel,
} from '@badminton/shared/src/utils/realtime-recovery';

// Deep import rather than the '@badminton/shared' barrel, for the reason
// spelled out in StaleBuildBanner.tsx: the barrel re-exports ./email/sender,
// which pulls `resend` in, and this module is 'use client' so everything it
// touches is a candidate for both browser bundles.

/**
 * ONE HOOK, EIGHT LIVE SURFACES.
 *
 * The failure this exists for is described at length in
 * packages/shared/src/utils/realtime-recovery.ts: a Realtime channel reports
 * its own death ONLY through the `.subscribe()` status callback, and Postgres
 * CDC never replays what a dead channel missed. All eight live-* surfaces in
 * the two apps need identical handling of that, and they are already eight
 * copies of the same effect shape — a rule written down at each of them would
 * hold exactly until the ninth was added.
 *
 * WHY packages/ui AND NOT EACH APP'S lib/. The two apps do not share a lib;
 * they share `@badminton/shared` (React-free by construction — no react
 * dependency, and adding one for a hook would put React in the path of the
 * email sender and the push job) and `@badminton/ui`, which already declares
 * react as a peer dependency, is already in both apps' `transpilePackages`, and
 * already carries logic modules that are not components (player-search.ts,
 * player-selection.ts). So the policy lives in shared where it can be tested
 * under node, and the twelve lines of React that bind it live here.
 *
 * HOW THE REBUILD REACHES THE CALLER, which is the only subtle thing here. A
 * channel killed by a binding mismatch cannot be revived: supabase-js's
 * `subscribe()` no-ops unless `channelAdapter.isClosed()`, and phoenix's own
 * close handler has already reset the rejoin timer and removed the channel from
 * the socket. It has to be built again — bindings and all — and the effect in
 * the calling component is the only code that knows how. So recovery works by
 * making that effect RE-RUN: `subscribe`'s identity changes when a rebuild is
 * due, the caller has `subscribe` in its dependency array (which
 * react-hooks/exhaustive-deps demands anyway, since the effect calls it), React
 * runs the cleanup — removing the dead channel — and the effect body builds a
 * fresh one.
 *
 * That indirection is deliberate over the obvious alternative of returning a
 * `generation` counter for callers to thread into their deps: a counter is a
 * dependency nothing forces anyone to add, and one call site omitting it would
 * be a screen that silently never recovers, which is precisely the bug being
 * fixed. `subscribe` cannot be omitted, because the effect cannot subscribe
 * without it.
 *
 * AND THE REBUILT CHANNEL IS GENUINELY NEW, which is not obvious and was
 * checked rather than assumed. `RealtimeClient.channel(topic)` DEDUPES: it
 * returns the existing instance if one with that topic is still in
 * `client.channels`, and the browser client is a singleton (@supabase/ssr
 * memoises it), so `client.channels` outlives any one effect. The cleanup's
 * `removeChannel` is async, so on the face of it the effect could re-run and be
 * handed back the very corpse it just tried to remove — bindings re-registered
 * on a leaving channel, subscribe() a no-op, the screen dead for good.
 *
 * It cannot happen on this path, for a reason worth writing down because it is
 * three libraries deep. `removeChannel` calls `channel.unsubscribe()`, whose
 * Promise executor runs phoenix's `leave()` SYNCHRONOUSLY, and leave ends with
 * `if (!this.canPush()) { leavePush.trigger('ok', {}) }` — canPush() is
 * `isConnected() && state === joined`. A rebuild is only ever scheduled from a
 * failure status and is cancelled the moment SUBSCRIBED arrives, so the channel
 * being replaced is never `joined`: the leave acks synchronously, close fires,
 * and RealtimeChannel's own `_onClose` hook runs `socket._remove(this)` before
 * removeChannel has awaited anything. The topic is free by the time the effect
 * body runs.
 *
 * A HEALTHY channel re-created on the same topic in one commit WOULD hit the
 * dedupe, because then canPush() is true and the leave waits for a server ack.
 * That is reachable today in live-attendance, whose effect depends on the
 * session-id key while its topic ('sessions-door-feed') is fixed — so a session
 * list that changes underneath a working channel re-enters `channel()` while
 * the leave is in flight. It predates this hook, it is not what this hook
 * changes, and it is left alone deliberately rather than fixed in passing; it
 * is noted here because this is where somebody will next read about the dedupe.
 *
 * NO VISIBLE "RECONNECTING" AFFORDANCE, decided rather than skipped. Recovery
 * here IS a router.refresh() — byte for byte what a normal live update does —
 * so the state a badge would announce is one the member cannot act on and will
 * not outlast the time it takes to read it: there is no button that reconnects
 * faster, and reloading by hand does exactly what the hook already does within
 * a minute. Weigh that against the cost: a new indicator on eight surfaces
 * including a tab bar and a door-list feed, drawn most often during a deploy,
 * i.e. the moment the club is least served by an alarming red dot on every
 * phone at once. (StaleBuildBanner is the adjacent mechanism and deliberately
 * NOT a substitute — it fires when a SERVER ACTION is rejected, so a member who
 * only reads never sees it, which is exactly the population a dead channel
 * hurts.) If a surface ever renders something a stale channel makes actively
 * dangerous — a live scoreline being umpired from, say — that surface should
 * take a status callback of its own; nothing here forecloses it.
 */
export function useLiveChannel(onRecover: () => void): (channel: RecoverableChannel) => () => void {
  // The rebuild counter. Never read — its only job is to be a new value, so
  // that the `subscribe` callback below is a new function and the caller's
  // effect re-runs. See the note above on why this is not returned.
  const [generation, setGeneration] = useState(0);

  // Held in a ref so a caller may pass an inline arrow (`() => router.refresh()`
  // is what seven of the eight do) without its per-render identity churning
  // `subscribe` and tearing the channel down on every render.
  const recover = useRef(onRecover);
  useEffect(() => {
    recover.current = onRecover;
  }, [onRecover]);

  // BOTH SURVIVE THE REBUILD, which is the whole reason they are refs and not
  // arguments. The new channel is a different object with a different policy
  // instance; without carrying these across, every rebuild would look like a
  // fresh page load (so: never re-fetch, the second half of the bug intact) and
  // the backoff would restart at ten seconds forever.
  const missed = useRef(false);
  const attempt = useRef(0);

  return useCallback(
    (channel: RecoverableChannel) =>
      subscribeWithRecovery(channel, {
        missedSomething: missed.current,
        attempt: attempt.current,
        onRecover: () => {
          missed.current = false;
          attempt.current = 0;
          recover.current();
        },
        onRebuild: (next) => {
          missed.current = true;
          attempt.current = next;
          setGeneration((g) => g + 1);
        },
      }),
    // `generation` is a cache-buster, not a value this callback reads: bumping
    // it is how a rebuild reaches the caller's effect. Nothing else belongs
    // here — every other input is a ref precisely so that it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [generation],
  );
}

export type { RecoverableChannel };
