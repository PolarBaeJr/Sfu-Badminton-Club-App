// The browser half of stale-build detection: a one-way flag, and the fetch
// wrapper that sets it. Framework-free on purpose — it lives here, next to the
// predicates it uses and inside the one workspace with a test runner, rather
// than beside the React banner in @badminton/ui. See ./stale-build.ts for what
// is actually being detected and why it is a header rather than a message.

import { carriesServerAction, shouldFlagStaleBuild } from './stale-build';
import type { HeadersLike } from './stale-build';

// ---------------------------------------------------------------------------
// The flag
//
// Module-global and one-way. Once the running build has moved there is no path
// back to a working tab except a reload, so there is nothing to un-set. Global
// rather than React context because the fetch wrapper below is not React and
// has no provider to reach for.
// ---------------------------------------------------------------------------

let staleBuildDetected = false;
const listeners = new Set<() => void>();

/** Synchronous read. Safe from anywhere, including outside React and on the server. */
export function isStaleBuild(): boolean {
  return staleBuildDetected;
}

/** Raise the flag. Idempotent; notifies subscribers only on the transition. */
export function markStaleBuild(): void {
  if (staleBuildDetected) return;
  staleBuildDetected = true;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the others hearing about this.
    }
  });
}

export function subscribeToStaleBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The server always renders the healthy state: a server that is answering at
 * all is, by definition, the current build. Exported for useSyncExternalStore's
 * third argument, which App Router requires.
 */
export function getStaleBuildServerSnapshot(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

const INSTALLED_FLAG = '__badmintonStaleBuildDetectorInstalled';

type FetchLike = (input: any, init?: any) => Promise<{ status: number; headers: HeadersLike }>;
type FetchHost = { fetch?: FetchLike; [INSTALLED_FLAG]?: boolean };

/** Pull the request's headers out of either fetch() call shape. */
function requestHeaders(input: unknown, init: unknown): HeadersLike {
  const explicit = (init as { headers?: HeadersLike } | undefined)?.headers;
  if (explicit) return explicit;
  // fetch(new Request(...)) — the headers ride on the Request instead.
  const onInput = (input as { headers?: HeadersLike } | undefined)?.headers;
  return onInput ?? null;
}

/**
 * Wrap the host's fetch once so every server action call is observed.
 *
 * Central interception, rather than editing the ~140 try/catch blocks that
 * currently surround server action calls across the two apps. This is the layer
 * to do it at, for three reasons:
 *
 *   1. The signal only exists on the wire. By the time a catch block runs, the
 *      App Router has already turned the response into an Error and all that
 *      survives is a message string — and matching on message text is exactly
 *      what we are refusing to do, because Next may reword it in a patch and a
 *      false positive tells a member to reload over an unrelated failure.
 *   2. Every server action in both apps goes through this one fetch, in
 *      next/dist/client/components/router-reducer/reducers/server-action-reducer.js.
 *      No call site can opt out, forget, or be added later without coverage.
 *   3. It works where the call site has no catch at all, swallows the error, or
 *      rewords it — and several do.
 *
 * The wrapper is deliberately inert: it reads two headers, never the body, adds
 * nothing to non-action fetches (same promise handed straight back), and cannot
 * change what the caller receives. Sentry and PostHog wrap fetch too; wrappers
 * compose, and this one passes everything through untouched.
 *
 * `host` defaults to globalThis so this is callable from a browser bundle with
 * no argument, and from a test with a fake.
 */
export function installStaleBuildDetector(host?: FetchHost): void {
  const target: FetchHost | undefined =
    host ?? (typeof globalThis === 'undefined' ? undefined : (globalThis as FetchHost));
  if (!target) return;
  if (target[INSTALLED_FLAG]) return;

  const original = target.fetch;
  if (typeof original !== 'function') return;
  target[INSTALLED_FLAG] = true;

  target.fetch = function staleBuildAwareFetch(this: unknown, input: any, init?: any) {
    // Cheap pre-filter: one header lookup, so ordinary traffic never pays for
    // an extra promise link. Correctness still comes from the full predicate
    // below, once the response is in hand.
    let watching = false;
    try {
      watching = carriesServerAction(requestHeaders(input, init));
    } catch {
      watching = false;
    }

    const pending = original.call(this, input, init);

    // Ordinary traffic — Supabase, PostHog, the passkey routes, RSC
    // navigations — is handed back exactly as it came, same promise and all.
    if (!watching) return pending;

    return pending.then((response) => {
      try {
        if (shouldFlagStaleBuild(requestHeaders(input, init), response)) {
          markStaleBuild();
        }
      } catch {
        // Detection is a nicety; the response is not.
      }
      return response;
    });
    // No .catch(): a rejected fetch is a network failure, not a moved build,
    // and attaching a handler here would only risk changing the rejection.
  } as FetchLike;
}
