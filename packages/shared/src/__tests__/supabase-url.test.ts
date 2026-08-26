import { describe, it, expect, vi, afterEach } from 'vitest';
import { getServerSupabaseUrl } from '../utils/supabase-url';

// The properties that matter on a helper standing between every server-side
// Supabase call and the network:
//
//   1. AN ABSENT OR BROKEN OVERRIDE CHANGES NOTHING. This ships to a live app
//      whose auth depends on it. Anything other than a clean fallback is an
//      outage, so "unset" and "garbage" must both behave exactly as before.
//   2. IT NEVER THROWS. Every caller is on the path that decides whether a
//      member is signed in; a throw here is a lockout, not an error page.

const PUBLIC = 'https://sfubadminton.com/supabase';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setEnv(internal?: string, pub: string | undefined = PUBLIC) {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', pub as string);
  vi.stubEnv('SUPABASE_INTERNAL_URL', internal as string);
}

describe('getServerSupabaseUrl', () => {
  it('uses the public origin when no override is set', () => {
    setEnv(undefined);
    expect(getServerSupabaseUrl()).toBe(PUBLIC);
  });

  it('uses the internal origin when one is set', () => {
    setEnv('http://100.123.79.47:54321');
    expect(getServerSupabaseUrl()).toBe('http://100.123.79.47:54321');
  });

  it('strips a trailing slash, because callers concatenate paths', () => {
    // `${origin}/rest/v1/...` against a stored slash yields a double slash,
    // which kong answers with a 404 that looks like a missing route.
    setEnv('http://100.123.79.47:54321/');
    expect(getServerSupabaseUrl()).toBe('http://100.123.79.47:54321');
  });

  it('accepts an https internal origin too', () => {
    setEnv('https://supabase.internal');
    expect(getServerSupabaseUrl()).toBe('https://supabase.internal');
  });

  // ---- A BAD OVERRIDE MUST NOT TAKE AUTH DOWN ----------------------------

  it.each(['', '   '])('treats %o as unset', (v) => {
    setEnv(v);
    expect(getServerSupabaseUrl()).toBe(PUBLIC);
  });

  it.each([
    'not a url',
    'postgres://user@host:5432/db',
    'ftp://host/path',
    '//100.123.79.47:54321',
  ])('falls back to the public origin for %s', (bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setEnv(bad);

    expect(getServerSupabaseUrl()).toBe(PUBLIC);
    // Silence here would mean a service quietly running on the slow, fragile
    // path with nothing anywhere saying why.
    expect(warn).toHaveBeenCalled();
  });

  it('never throws, even when both variables are missing', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined as unknown as string);
    vi.stubEnv('SUPABASE_INTERNAL_URL', undefined as unknown as string);
    expect(() => getServerSupabaseUrl()).not.toThrow();
  });
});
