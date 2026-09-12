import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserReachableSignedUrl } from '../signed-url';

/**
 * WHY THIS FILE EXISTS AT ALL, because a reader's first instinct is that three
 * lines of string handling do not need a test.
 *
 * SUPABASE_INTERNAL_URL is UNSET on staging and on localhost. So on every
 * environment anybody can click through before a release,
 * getServerSupabaseUrl() returns the public origin, the `startsWith` guard is
 * trivially satisfied, and the rewrite is the identity function. A rewrite that
 * is completely broken passes staging, passes a browser walkthrough, and then
 * fails on PRODUCTION ONLY, silently, as a receipt that will not open. Driving
 * it in Chrome cannot reach the branch; setting the variable here is the only
 * thing that can.
 */

const PUBLIC = 'https://sfubadminton.com/supabase';
const INTERNAL = 'http://100.123.79.47:54321';

// What storage actually hands back: the object path plus a signed token. The
// token is the part that must survive the rewrite untouched.
const SIGNED_PATH = '/storage/v1/object/sign/expense-receipts/abc/def.jpg?token=eyJhbGciOi';

afterEach(() => {
  vi.unstubAllEnvs();
});

// BOTH ARGUMENTS ARE EXPLICIT AT EVERY CALL SITE, WITH NO DEFAULT, and that is
// deliberate rather than verbose. A default parameter fires on an explicit
// `undefined`, which is exactly the value a test for "this variable is not set"
// needs to pass: written as `pub = PUBLIC`, the one case that matters here
// quietly set the variable to PUBLIC and asserted against a branch it had just
// made unreachable. Passing undefined must mean unset, so nothing may fill it in.
function setEnv(internal: string | undefined, pub: string | undefined) {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', pub as string);
  vi.stubEnv('SUPABASE_INTERNAL_URL', internal as string);
}

describe('browserReachableSignedUrl', () => {
  // The production case, and the only one that is not already correct by
  // accident. The signing client is built on the tailnet address, so the URL
  // comes back pointing at a hostname no phone can resolve.
  it('moves an internally-signed URL onto the public origin', () => {
    setEnv(INTERNAL, PUBLIC);
    expect(browserReachableSignedUrl(INTERNAL + SIGNED_PATH)).toBe(PUBLIC + SIGNED_PATH);
  });

  it('keeps the signing token and the object path exactly as they were', () => {
    setEnv(INTERNAL, PUBLIC);
    const out = browserReachableSignedUrl(INTERNAL + SIGNED_PATH);
    expect(out).toContain('?token=eyJhbGciOi');
    expect(out).toContain('/expense-receipts/abc/def.jpg');
  });

  // Staging and localhost. The branch is never taken there, which is the whole
  // reason those environments cannot prove the case above.
  it('is the identity when no internal origin is configured', () => {
    setEnv(undefined, PUBLIC);
    const already = PUBLIC + SIGNED_PATH;
    expect(browserReachableSignedUrl(already)).toBe(already);
  });

  // A URL that is already reachable must not be rewritten a second time. With
  // the guard removed this is where a doubled origin would show up.
  it('leaves a URL already on the public origin alone', () => {
    setEnv(INTERNAL, PUBLIC);
    const already = PUBLIC + SIGNED_PATH;
    expect(browserReachableSignedUrl(already)).toBe(already);
    expect(browserReachableSignedUrl(already)).not.toContain(INTERNAL);
  });

  // getServerSupabaseUrl() strips a trailing slash from the internal value and
  // this strips one from the public value, so neither end can contribute the
  // double slash that kong answers with a 404 looking like a missing route.
  it('does not produce a double slash from a trailing slash on either origin', () => {
    setEnv(INTERNAL + '/', PUBLIC + '/');
    const out = browserReachableSignedUrl(INTERNAL + SIGNED_PATH);
    expect(out).toBe(PUBLIC + SIGNED_PATH);
    expect(out.slice('https://'.length)).not.toContain('//');
  });

  // Fail SAFE, not closed: with no public origin configured there is nothing to
  // rewrite onto, and handing back the URL we were given is strictly better than
  // manufacturing 'undefined/storage/...'.
  it('returns the URL untouched when no public origin is set', () => {
    setEnv(INTERNAL, undefined);
    expect(browserReachableSignedUrl(INTERNAL + SIGNED_PATH)).toBe(INTERNAL + SIGNED_PATH);
  });
});
