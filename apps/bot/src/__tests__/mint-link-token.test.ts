import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mintLinkToken, AlreadyLinkedError, AppApiError } from '../api.js';

// Covers the REAL mintLinkToken, not a mock of it. link-commands.test.ts stubs
// this function to drive handleLink, so nothing there exercises the mapping
// from an HTTP status onto an error type -- which is the part that decides
// whether a member is told "already connected" or "the app is down".

const TOKEN = 'a'.repeat(64);

function jsonResponse(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.APP_API_URL = 'https://app.example';
  process.env.APP_PUBLIC_URL = 'https://public.example';
  process.env.DISCORD_SERVICE_SECRET = 'secret';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APP_API_URL;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.DISCORD_SERVICE_SECRET;
});

describe('mintLinkToken', () => {
  it('maps 409 onto AlreadyLinkedError, not AppApiError', async () => {
    // The distinction is the whole point: dispatch() renders any AppApiError
    // as "couldn't reach the club app", which would be false here.
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'already_linked' }));

    await expect(mintLinkToken('42', 'g1')).rejects.toBeInstanceOf(AlreadyLinkedError);
    await expect(mintLinkToken('42', 'g1')).rejects.not.toBeInstanceOf(AppApiError);
  });

  it('still maps other failures onto AppApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'mint_failed' }));

    await expect(mintLinkToken('42', 'g1')).rejects.toBeInstanceOf(AppApiError);
  });

  it('returns a public URL carrying the token in the path, not the query', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: TOKEN, expiresAt: new Date().toISOString() })
    );

    const { url } = await mintLinkToken('42', 'g1');

    // Query strings leak into referrers, analytics and access logs; the path
    // form is deliberate.
    expect(url).toBe(`https://public.example/link/${TOKEN}`);
    expect(url).not.toContain('?');
  });

  it('mints against the app origin while linking to the public one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: TOKEN, expiresAt: new Date().toISOString() })
    );

    await mintLinkToken('42', 'g1');

    const target = String(fetchMock.mock.calls[0]?.[0]);
    expect(target).toBe('https://app.example/api/discord/link-tokens');
  });

  it('rejects a 200 that carries no token rather than building a broken link', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { expiresAt: new Date().toISOString() }));

    await expect(mintLinkToken('42', 'g1')).rejects.toBeInstanceOf(AppApiError);
  });
});
