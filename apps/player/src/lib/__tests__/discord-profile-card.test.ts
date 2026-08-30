import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Discord profile card, and the three ways it could quietly stop being safe.
//
// The card is the only anonymous route under /api/discord: Discord's CDN
// fetches the PNG with no session and no service secret. Everything that keeps
// that from being a public dump of the roster is asserted here.

const SRC = join(__dirname, '..', '..');

const rpc = vi.fn();
const maybeSingle = vi.fn();
const from = vi.fn();

vi.mock('../supabase-server', () => ({
  createServiceRoleClient: () => ({ rpc, from }),
}));

const LADDER_ROW = {
  id: 'p1',
  name: 'Bo Chen',
  handle: 'bochen',
  avatar_url: null,
  status: 'competitive',
  singles_elo: 1100,
  doubles_elo: 1250,
  singles_wins: 4,
  singles_losses: 2,
  doubles_wins: 9,
  doubles_losses: 3,
  singles_provisional: false,
  doubles_provisional: true,
  current_singles_streak: 2,
  current_doubles_streak: -1,
  tournament_points: 40,
};

/** A player row as the service-role key sees it — raw status included. */
function playerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    full_name: 'Bo Chen',
    handle: 'bochen',
    avatar_url: null,
    bio: 'left-handed',
    status: 'competitive',
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  maybeSingle.mockReset();
  from.mockReset();
  from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
  rpc.mockResolvedValue({ data: [LADDER_ROW], error: null });
  maybeSingle.mockResolvedValue({ data: playerRow(), error: null });
  process.env.DISCORD_SERVICE_SECRET = 'secret-under-test';
});

afterEach(() => {
  delete process.env.DISCORD_SERVICE_SECRET;
});

describe('the card token is the only way to name a card', () => {
  it('round-trips the player id it was minted for', async () => {
    const { mintCardToken, readCardToken } = await import('../discord-card-token');
    const token = mintCardToken('player-abc');
    expect(token).toBeTruthy();
    expect(readCardToken(token!)).toBe('player-abc');
  });

  it('refuses a token whose payload was edited to name somebody else', async () => {
    const { mintCardToken, readCardToken } = await import('../discord-card-token');
    const token = mintCardToken('player-abc')!;
    const [, sig] = token.split('.');

    // The forgery this signature exists to stop: keep the signature, swap the
    // id. It only works if the id is OUTSIDE the signed payload.
    const forged = `${Buffer.from(
      JSON.stringify({ p: 'player-victim', e: Math.floor(Date.now() / 1000) + 60 })
    ).toString('base64url')}.${sig}`;

    expect(readCardToken(forged)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const { mintCardToken, readCardToken, CARD_TOKEN_TTL_SECONDS } = await import(
      '../discord-card-token'
    );
    const token = mintCardToken('player-abc')!;
    expect(readCardToken(token, Date.now() + (CARD_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  it('fails closed when the secret is unset, rather than signing with nothing', async () => {
    delete process.env.DISCORD_SERVICE_SECRET;
    const { mintCardToken, readCardToken } = await import('../discord-card-token');
    expect(mintCardToken('player-abc')).toBeNull();
    expect(readCardToken('anything.atall')).toBeNull();
  });

  it('refuses a token minted under a different secret', async () => {
    const { mintCardToken } = await import('../discord-card-token');
    const token = mintCardToken('player-abc')!;

    vi.resetModules();
    process.env.DISCORD_SERVICE_SECRET = 'rotated-secret-xx';
    const { readCardToken } = await import('../discord-card-token');
    expect(readCardToken(token)).toBeNull();
  });
});

describe('the card is always the stranger\'s view', () => {
  it('collapses a moderation status even on the member\'s own card', async () => {
    maybeSingle.mockResolvedValue({ data: playerRow({ status: 'suspended' }), error: null });
    rpc.mockResolvedValue({ data: [], error: null });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' });

    expect('profile' in result).toBe(true);
    if (!('profile' in result)) return;
    expect(result.profile.status).toBeNull();
    // The word cannot be anywhere in what gets drawn.
    expect(JSON.stringify(result.profile)).not.toContain('suspended');
  });

  it('gives an off-ladder member no figures at all, not zeroes', async () => {
    // Absence from get_leaderboard() IS the hide_from_leaderboard decision.
    rpc.mockResolvedValue({ data: [], error: null });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.ranked).toBe(false);
    expect(result.profile.doubles).toBeNull();
    expect(result.profile.singles).toBeNull();
    expect(result.profile.tournamentPoints).toBeNull();
  });

  it('still refuses a pending-approval row outright', async () => {
    maybeSingle.mockResolvedValue({
      data: playerRow({ status: 'pending_approval' }),
      error: null,
    });
    rpc.mockResolvedValue({ data: [], error: null });

    const { resolveProfile } = await import('../discord-profile');
    expect(await resolveProfile({ by: 'playerId', value: 'p1' })).toEqual({ miss: 'not_found' });
  });
});

describe('handle lookup cannot reach somebody who is off the ladder', () => {
  it('finds a listed member by handle, case-insensitively and with a stray @', async () => {
    const { resolveProfile } = await import('../discord-profile');
    for (const typed of ['bochen', 'BoChen', '@bochen']) {
      const result = await resolveProfile({ by: 'handle', value: typed });
      if (!('profile' in result)) throw new Error(`expected a profile for ${typed}`);
      expect(result.profile.id).toBe('p1');
    }
  });

  it('does not find an unlisted member, even though players.handle still holds one', async () => {
    // The member has a handle on their row — they are simply not on the ladder.
    // Reading players.handle instead of the ladder would find them, which is
    // the whole reason the lookup is written the way it is.
    rpc.mockResolvedValue({ data: [], error: null });

    const { resolveProfile } = await import('../discord-profile');
    expect(await resolveProfile({ by: 'handle', value: 'bochen' })).toEqual({
      miss: 'no_such_handle',
    });
  });
});

describe('the two ways the card route fails silently in the container', () => {
  it('is excluded from the middleware matcher, or Discord caches a login redirect', () => {
    const middleware = readFileSync(join(SRC, 'middleware.ts'), 'utf8');
    expect(middleware).toMatch(/api\/discord\/card\//);
  });

  it('has its fonts traced into the standalone bundle', () => {
    // Nothing imports the .ttf files — the route reads them off disk — so
    // without this entry the route builds clean and 500s on its first real
    // request, in the container, where nobody is watching.
    const config = readFileSync(join(SRC, '..', 'next.config.js'), 'utf8');
    expect(config).toMatch(/outputFileTracingIncludes/);
    expect(config).toMatch(/'\/api\/discord\/card\/\[token\]':\s*\['\.\/src\/fonts\/\*\.ttf'\]/);
  });

  it('ships the .ttf faces satori can actually read, not the browser\'s .woff2', () => {
    for (const f of ['BarlowCondensed-Bold.ttf', 'Barlow-Regular.ttf', 'Barlow-SemiBold.ttf']) {
      const buf = readFileSync(join(SRC, 'fonts', f));
      // sfnt version 1.0 — a TrueType file. A WOFF2 would start with 'wOF2',
      // which satori cannot parse at all.
      expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x01, 0x00, 0x00]));
    }
  });
});
