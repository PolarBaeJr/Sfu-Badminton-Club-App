// Recognising a tab that outlived its build.
//
// Server action IDs are per-build: `next build` hashes each action into an id,
// and the running server will only accept ids in ITS OWN manifest. A tab loaded
// before a deploy therefore keeps sending ids the new container has never heard
// of. The request is rejected before our handler runs — nothing is half-written,
// which is the one mercy here — but the tab is a dead end: every action fails
// the same way until the member reloads, and Next's own message ("An unexpected
// response was received from the server.") names no cause and offers no action.
//
// What Next 15.5 actually does, verified against the compiled runtime in
// node_modules rather than assumed:
//
//   server  next/dist/server/app-render/action-handler.js, handleUnrecognizedFetchAction
//           → res.setHeader('x-nextjs-action-not-found', '1')
//             res.statusCode = 404
//             body: 'Server action not found.' as text/plain
//
//   client  next/dist/client/components/router-reducer/reducers/server-action-reducer.js
//           → reads that header off the response and throws
//             UnrecognizedActionError (name set in the constructor,
//             __NEXT_ERROR_CODE 'E715')
//
// So the honest signal is a HEADER on the wire, not a message. Everything below
// keys off that header; there is deliberately no string matching on any error
// message anywhere in this file. Message text is Next's to change in a patch
// release, and a false positive here tells a member to reload when the real
// problem was something else — worse than the bug we are fixing.

/**
 * The request header the App Router puts a server action's id in.
 * `ACTION_HEADER` in next/dist/client/components/app-router-headers.js.
 * Compared case-insensitively; Next sends it as 'Next-Action'.
 */
export const NEXT_ACTION_HEADER = 'next-action';

/**
 * The response header the server sets when it does not recognise an action id.
 * `NEXT_ACTION_NOT_FOUND_HEADER` in the same module. Next chose a header rather
 * than an encoded body precisely so this case can be recognised cheaply, which
 * is what we are doing.
 */
export const NEXT_ACTION_NOT_FOUND_HEADER = 'x-nextjs-action-not-found';

/**
 * Every shape `fetch` accepts for headers. Typed structurally so this module
 * stays free of DOM lib types and can be unit-tested under vitest's node
 * environment — and so it keeps working if the caller hands us a `Headers`,
 * a plain object literal, or an array of pairs.
 *
 * The object-literal case is the one that matters: the App Router builds its
 * action request as `fetch(url, { headers: { 'Next-Action': id, ... } })`, a
 * plain object, NOT a Headers instance. Testing only against Headers would let
 * this ship silently dead.
 */
export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Record<string, unknown>
  | ReadonlyArray<readonly [string, string]>
  | null
  | undefined;

/**
 * Case-insensitive header lookup across all three shapes. Returns null when the
 * header is absent, the container is null, or reading it throws.
 */
export function headerValue(headers: HeadersLike, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();

  try {
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === 'function') {
      // Headers.get is already case-insensitive.
      const value = (headers as { get(n: string): string | null | undefined }).get(name);
      return value == null ? null : String(value);
    }

    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && String(pair[0]).toLowerCase() === wanted) {
          return pair[1] == null ? null : String(pair[1]);
        }
      }
      return null;
    }

    for (const key of Object.keys(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === wanted) {
        const value = (headers as Record<string, unknown>)[key];
        return value == null ? null : String(value);
      }
    }
  } catch {
    // A hostile or exotic headers object must never break the fetch it rode in
    // on. Not knowing is the safe answer.
    return null;
  }

  return null;
}

/** Whether a request carries a server action id, i.e. whether it is an action call at all. */
export function carriesServerAction(headers: HeadersLike): boolean {
  const value = headerValue(headers, NEXT_ACTION_HEADER);
  return typeof value === 'string' && value.length > 0;
}

export interface StaleBuildResponseInput {
  /** Did the REQUEST carry a Next-Action header? */
  carriesServerAction: boolean;
  /** The response status. */
  status: number;
  /** The response's x-nextjs-action-not-found value, or null. */
  actionNotFoundHeader: string | null;
}

/**
 * Whether this response says "the build moved under you".
 *
 * Two accepting rules, both narrow:
 *
 *   1. The header is set. This is Next's own protocol and is definitive.
 *
 *   2. An action POST came back 404 WITHOUT the header. The server pairs the
 *      header with a 404, so a bare 404 is what we would see if something
 *      between us and the app dropped or replaced the response — a reverse
 *      proxy that renders its own error pages, for instance, which this app
 *      sits behind. A 404 answering an action id is not a case that arises
 *      when the build has not moved: the id either resolves or it does not.
 *
 * Everything else is refused on purpose:
 *
 *   - Not an action request → false. A 404 from an ordinary fetch is an
 *     ordinary 404.
 *   3. A GATEWAY-CLASS 5xx — 502, 503, 504 — answering an action call. These
 *      come from something IN FRONT of the app rather than from the app, and
 *      during a deploy that is exactly what a member meets: the old container
 *      is gone, the new one is not yet serving, and the proxy answers with its
 *      own HTML error page. That page is neither RSC nor a redirect, which is
 *      what produced the "An unexpected response was received from the server"
 *      seen on 2026-08-13 — a dead end with no cause named and no way forward.
 *      Reloading DOES fix it, seconds later, which is the whole test for
 *      whether offering a reload is honest.
 *
 * Everything else is refused on purpose:
 *
 *   - Not an action request → false. A 404 from an ordinary fetch is an
 *     ordinary 404.
 *   - 500 and 501 → false. Those are the APP erroring, not something in front
 *     of it, and a reload returns the same error. Telling a member to reload
 *     would send them away from a real failure with false reassurance. The
 *     distinction from rule 3 is deliberate and is the reason this is not
 *     simply `status >= 500`.
 *   - A network error (no response at all) never reaches this function.
 */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export function isStaleBuildResponse(input: StaleBuildResponseInput): boolean {
  if (!input.carriesServerAction) return false;
  if (input.actionNotFoundHeader === '1') return true;
  if (input.status === 404) return true;
  return GATEWAY_STATUSES.has(input.status);
}

/**
 * The whole decision, from the two things a fetch wrapper has in hand. Kept
 * here, composed and tested, rather than assembled inline at the call site:
 * the wrapper's job is then only to pass these two objects along, which is the
 * part that cannot go subtly wrong.
 */
export function shouldFlagStaleBuild(
  requestHeaders: HeadersLike,
  response: { status: number; headers: HeadersLike },
): boolean {
  if (!carriesServerAction(requestHeaders)) return false;
  return isStaleBuildResponse({
    carriesServerAction: true,
    status: response.status,
    actionNotFoundHeader: headerValue(response.headers, NEXT_ACTION_NOT_FOUND_HEADER),
  });
}

/**
 * Whether a caught error is Next's UnrecognizedActionError.
 *
 * A backstop for the header check, not a replacement: it reads `name`, which
 * the constructor assigns as a string literal (so minification cannot rename
 * it), and the stable `__NEXT_ERROR_CODE`. Next exports
 * `unstable_isUnrecognizedActionError` for this, but it is `unstable_`-prefixed
 * and does an `instanceof` against a class we would have to import from a deep
 * internal path; duck-typing two fields is both looser and less coupled.
 */
export function isUnrecognizedActionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; __NEXT_ERROR_CODE?: unknown };
  return candidate.name === 'UnrecognizedActionError' || candidate.__NEXT_ERROR_CODE === 'E715';
}
