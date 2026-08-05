import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// AUTH_COOKIE_DOMAIN is read once at module load (the value is inlined by the
// Next build), so each case re-imports the module with the env var it wants.
async function loadConstants(domain?: string) {
  vi.resetModules();
  if (domain === undefined) {
    delete process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN;
  } else {
    process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN = domain;
  }
  return import('../constants');
}

const original = process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN;
});

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN;
  else process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN = original;
});

describe('AUTH_COOKIE_OPTIONS', () => {
  it('is name-only when the domain is unset, so Set-Cookie is unchanged', async () => {
    const { AUTH_COOKIE_OPTIONS, AUTH_COOKIE_NAME } = await loadConstants(undefined);
    expect(AUTH_COOKIE_OPTIONS).toEqual({ name: AUTH_COOKIE_NAME });
    expect('domain' in AUTH_COOKIE_OPTIONS).toBe(false);
  });

  it('treats an empty string as unset — an unfilled build arg must not scope the cookie', async () => {
    const { AUTH_COOKIE_OPTIONS, AUTH_COOKIE_DOMAIN, AUTH_COOKIE_NAME } = await loadConstants('');
    expect(AUTH_COOKIE_DOMAIN).toBeUndefined();
    expect(AUTH_COOKIE_OPTIONS).toEqual({ name: AUTH_COOKIE_NAME });
  });

  it('carries the domain when set, without touching the pinned name', async () => {
    const { AUTH_COOKIE_OPTIONS } = await loadConstants('.sfubadminton.com');
    expect(AUTH_COOKIE_OPTIONS).toEqual({
      name: 'sb-badminton-auth-token',
      domain: '.sfubadminton.com',
    });
  });
});

describe('isAuthCookieName', () => {
  it('matches the session cookie, its chunks and the PKCE verifier', async () => {
    const { isAuthCookieName } = await loadConstants('.sfubadminton.com');
    expect(isAuthCookieName('sb-badminton-auth-token')).toBe(true);
    expect(isAuthCookieName('sb-badminton-auth-token.0')).toBe(true);
    expect(isAuthCookieName('sb-badminton-auth-token.11')).toBe(true);
    expect(isAuthCookieName('sb-badminton-auth-token-code-verifier')).toBe(true);
    expect(isAuthCookieName('sb-badminton-auth-token-code-verifier.0')).toBe(true);
  });

  it('does not match unrelated cookies, including the admin passkey gate', async () => {
    const { isAuthCookieName } = await loadConstants('.sfubadminton.com');
    expect(isAuthCookieName('admin_passkey_verified')).toBe(false);
    expect(isAuthCookieName('admin_passkey_challenge')).toBe(false);
    expect(isAuthCookieName('sb-badminton-auth-tokenish')).toBe(false);
    expect(isAuthCookieName('theme')).toBe(false);
  });
});

describe('hostOnlyAuthCookieClears', () => {
  const written = [
    { name: 'sb-badminton-auth-token.0' },
    { name: 'sb-badminton-auth-token.1' },
    { name: 'admin_passkey_verified' },
  ];

  it('emits nothing when the domain is unset', async () => {
    const { hostOnlyAuthCookieClears } = await loadConstants(undefined);
    expect(hostOnlyAuthCookieClears(written)).toEqual([]);
  });

  it('expires only the auth cookies, and only on the host-only scope', async () => {
    const { hostOnlyAuthCookieClears } = await loadConstants('.sfubadminton.com');
    const clears = hostOnlyAuthCookieClears(written);
    expect(clears).toEqual([
      'sb-badminton-auth-token.0=; Path=/; Max-Age=0; SameSite=Lax',
      'sb-badminton-auth-token.1=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    // No Domain attribute: the deletion must not match the cookie just written.
    clears.forEach((c) => expect(c).not.toMatch(/Domain=/i));
  });
});

describe('duplicateAuthCookieClears', () => {
  it('emits nothing when the domain is unset', async () => {
    const { duplicateAuthCookieClears } = await loadConstants(undefined);
    expect(
      duplicateAuthCookieClears('sb-badminton-auth-token=a; sb-badminton-auth-token=b')
    ).toEqual([]);
  });

  it('emits nothing when each auth cookie appears once', async () => {
    const { duplicateAuthCookieClears } = await loadConstants('.sfubadminton.com');
    expect(
      duplicateAuthCookieClears('sb-badminton-auth-token=a; theme=dark; theme=light')
    ).toEqual([]);
  });

  it('expires the host-only copy when the same auth cookie arrives twice', async () => {
    const { duplicateAuthCookieClears } = await loadConstants('.sfubadminton.com');
    expect(
      duplicateAuthCookieClears(
        'sb-badminton-auth-token.0=stale; theme=dark; sb-badminton-auth-token.0=fresh'
      )
    ).toEqual(['sb-badminton-auth-token.0=; Path=/; Max-Age=0; SameSite=Lax']);
  });

  it('handles a missing Cookie header', async () => {
    const { duplicateAuthCookieClears } = await loadConstants('.sfubadminton.com');
    expect(duplicateAuthCookieClears(null)).toEqual([]);
    expect(duplicateAuthCookieClears(undefined)).toEqual([]);
  });
});
