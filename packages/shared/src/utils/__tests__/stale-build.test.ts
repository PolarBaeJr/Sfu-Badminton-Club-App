import { describe, it, expect } from 'vitest';
import {
  NEXT_ACTION_HEADER,
  NEXT_ACTION_NOT_FOUND_HEADER,
  headerValue,
  carriesServerAction,
  isStaleBuildResponse,
  isUnrecognizedActionError,
} from '../stale-build';

// The exact literal the App Router builds. Copied from
// next/dist/client/components/router-reducer/reducers/server-action-reducer.js:
// a PLAIN OBJECT, with 'Next-Action' in mixed case. If the predicate only
// handled Headers instances it would pass every hand-written test and still
// never fire in the browser, so this shape is asserted first.
const REAL_ACTION_REQUEST_HEADERS = {
  Accept: 'text/x-component',
  'Next-Action': '7f9a2c1e4b',
  'Next-Router-State-Tree': '%5B%22%22%2C%7B%7D%5D',
};

describe('headerValue', () => {
  it('reads a plain object case-insensitively', () => {
    expect(headerValue(REAL_ACTION_REQUEST_HEADERS, NEXT_ACTION_HEADER)).toBe('7f9a2c1e4b');
    expect(headerValue({ 'NEXT-ACTION': 'abc' }, NEXT_ACTION_HEADER)).toBe('abc');
  });

  it('reads a Headers instance', () => {
    const headers = new Headers({ 'Next-Action': 'abc' });
    expect(headerValue(headers, NEXT_ACTION_HEADER)).toBe('abc');
  });

  it('reads an array of pairs', () => {
    expect(headerValue([['Next-Action', 'abc']], NEXT_ACTION_HEADER)).toBe('abc');
  });

  it('returns null for absent headers and empty containers', () => {
    expect(headerValue(undefined, NEXT_ACTION_HEADER)).toBeNull();
    expect(headerValue(null, NEXT_ACTION_HEADER)).toBeNull();
    expect(headerValue({}, NEXT_ACTION_HEADER)).toBeNull();
    expect(headerValue({ 'content-type': 'text/plain' }, NEXT_ACTION_HEADER)).toBeNull();
  });

  it('never throws on a hostile container', () => {
    const hostile = {
      get() {
        throw new Error('boom');
      },
    };
    expect(headerValue(hostile, NEXT_ACTION_HEADER)).toBeNull();
  });
});

describe('carriesServerAction', () => {
  it('recognises the real App Router request shape', () => {
    expect(carriesServerAction(REAL_ACTION_REQUEST_HEADERS)).toBe(true);
  });

  it('is false for ordinary app traffic', () => {
    // Supabase, PostHog, Sentry and the passkey routes all fetch without it.
    expect(carriesServerAction({ 'content-type': 'application/json' })).toBe(false);
    expect(carriesServerAction(undefined)).toBe(false);
    // An RSC navigation is not an action call.
    expect(carriesServerAction({ RSC: '1' })).toBe(false);
  });

  it('is false when the header is present but empty', () => {
    expect(carriesServerAction({ 'Next-Action': '' })).toBe(false);
  });
});

describe('isStaleBuildResponse — accepts', () => {
  it("accepts Next's own header", () => {
    expect(
      isStaleBuildResponse({ carriesServerAction: true, status: 404, actionNotFoundHeader: '1' }),
    ).toBe(true);
  });

  it('accepts a bare 404 to an action call (header lost to a proxy)', () => {
    expect(
      isStaleBuildResponse({ carriesServerAction: true, status: 404, actionNotFoundHeader: null }),
    ).toBe(true);
  });
});

describe('isStaleBuildResponse — refuses (false positives are worse than the bug)', () => {
  it('refuses a 404 that was not an action call', () => {
    // A missing avatar, a deleted attachment, a mistyped API path.
    expect(
      isStaleBuildResponse({ carriesServerAction: false, status: 404, actionNotFoundHeader: null }),
    ).toBe(false);
  });

  // The 5xx split, which is the whole reason this is not `status >= 500`.
  //
  // 502/503/504 come from something IN FRONT of the app — during a container
  // roll the old one is gone, the new one is not serving, and the proxy answers
  // with its own HTML error page. That page is neither RSC nor a redirect,
  // which is exactly the dead end hit on 2026-08-13. A reload fixes it seconds
  // later, so offering one is honest.
  //
  // 500 is the APP itself erroring. A reload returns the same error, and
  // telling a member to reload sends them away from a real failure with false
  // reassurance.
  it('refuses 500 — the app erred, and reloading returns the same error', () => {
    for (const status of [500, 501]) {
      expect(
        isStaleBuildResponse({ carriesServerAction: true, status, actionNotFoundHeader: null }),
      ).toBe(false);
    }
  });

  it('accepts gateway-class 5xx on an action call — that is a deploy in progress', () => {
    for (const status of [502, 503, 504]) {
      expect(
        isStaleBuildResponse({ carriesServerAction: true, status, actionNotFoundHeader: null }),
      ).toBe(true);
    }
  });

  it('still refuses a gateway 5xx that was not an action call', () => {
    // An image or a health check failing mid-roll must not raise the banner —
    // the member was not trying to write anything, so nothing was lost.
    for (const status of [502, 503, 504]) {
      expect(
        isStaleBuildResponse({ carriesServerAction: false, status, actionNotFoundHeader: null }),
      ).toBe(false);
    }
  });

  it('refuses an action that failed inside our own handler', () => {
    // runAction throwing "Description must be at least 10 characters" still
    // answers 200 with an RSC payload; a rate-limited one answers 429.
    expect(
      isStaleBuildResponse({ carriesServerAction: true, status: 200, actionNotFoundHeader: null }),
    ).toBe(false);
    expect(
      isStaleBuildResponse({ carriesServerAction: true, status: 429, actionNotFoundHeader: null }),
    ).toBe(false);
  });

  it('refuses auth failures — those redirect or 401/403, and a reload just re-lands on login', () => {
    for (const status of [401, 403, 307]) {
      expect(
        isStaleBuildResponse({ carriesServerAction: true, status, actionNotFoundHeader: null }),
      ).toBe(false);
    }
  });

  it('refuses a header value other than exactly "1"', () => {
    expect(
      isStaleBuildResponse({ carriesServerAction: true, status: 200, actionNotFoundHeader: '0' }),
    ).toBe(false);
  });
});

describe('isUnrecognizedActionError', () => {
  it("accepts Next's error by name", () => {
    // Reconstructed exactly as server-action-reducer.js builds it.
    const err = new Error(
      'Server Action "7f9a2c1e4b" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    err.name = 'UnrecognizedActionError';
    Object.defineProperty(err, '__NEXT_ERROR_CODE', { value: 'E715', enumerable: false });
    expect(isUnrecognizedActionError(err)).toBe(true);
  });

  it('accepts on the error code alone', () => {
    expect(isUnrecognizedActionError(Object.assign(new Error('x'), { __NEXT_ERROR_CODE: 'E715' }))).toBe(true);
  });

  it('refuses the generic response error Next throws for everything else', () => {
    // E394 — thrown when the response is neither RSC nor a redirect. This is
    // the message the failure was reported under, and it is NOT specific to a
    // moved build: a 502 from the proxy produces it too.
    const err = Object.assign(new Error('An unexpected response was received from the server.'), {
      __NEXT_ERROR_CODE: 'E394',
    });
    expect(isUnrecognizedActionError(err)).toBe(false);
  });

  it('refuses ordinary application errors', () => {
    expect(isUnrecognizedActionError(new Error('Game scores cannot be tied'))).toBe(false);
    expect(isUnrecognizedActionError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isUnrecognizedActionError(null)).toBe(false);
    expect(isUnrecognizedActionError(undefined)).toBe(false);
    expect(isUnrecognizedActionError('UnrecognizedActionError')).toBe(false);
    expect(isUnrecognizedActionError({})).toBe(false);
  });
});

describe('header name constants match Next\'s wire protocol', () => {
  it('are the lowercased names next/dist/client/components/app-router-headers.js exports', () => {
    expect(NEXT_ACTION_HEADER).toBe('next-action');
    expect(NEXT_ACTION_NOT_FOUND_HEADER).toBe('x-nextjs-action-not-found');
  });
});
