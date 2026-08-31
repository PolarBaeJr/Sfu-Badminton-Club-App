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

  it('refuses a handle no row could hold WITHOUT reading the ladder', async () => {
    // The bound is players_handle_shape_check's (00092), so anything outside it
    // has nothing to find. The assertion that matters is the second one: this
    // option is free text typed in Discord and it feeds an anonymous route, so
    // a 2000-character miss must not cost a full club read first.
    const { resolveProfile } = await import('../discord-profile');
    for (const typed of ['ab', 'x'.repeat(2000)]) {
      expect(await resolveProfile({ by: 'handle', value: typed })).toEqual({
        miss: 'no_such_handle',
      });
    }
    expect(rpc).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// RECENT FORM
//
// The card used to describe exactly one person, and resolveProfile guarantees
// that person is on the public ladder. A match row names OTHER people, and
// neither leaderboard-privacy.test.ts nor profile-status-privacy.test.ts would
// notice: the first keys on singles_elo/doubles_elo, the second on a
// from('players') select naming `status`, and discord-profile.ts is allowlisted
// in both. A read of match_participants that named an opponent trips neither.
// So the rule is asserted here.

/** A thenable chain that answers whatever the table was mapped to. */
function chain(result: unknown) {
  const obj: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
  };
  for (const m of ['select', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit']) {
    obj[m] = () => obj;
  }
  return obj;
}

/** Point `from` at one canned answer per table. Unmapped tables read empty. */
function tables(map: Record<string, unknown>) {
  from.mockImplementation((table: string) =>
    chain(map[table] ?? { data: [], error: null, count: 0 })
  );
}

function ladderRow(over: Record<string, unknown> = {}) {
  return { ...LADDER_ROW, ...over };
}

/** One `matches` row as the recent-form query selects it. */
function matchRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    played_at: '2026-08-20T02:00:00Z',
    match_type: 'doubles',
    score_summary: '21-15, 21-18',
    winner_side: 'a',
    ...over,
  };
}

describe('recent form is fetched only when it is drawn, and only for a listed member', () => {
  it('costs the bot nothing: without withForm no form table is read at all', async () => {
    tables({ players: { data: playerRow(), error: null } });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' });

    if (!('profile' in result)) throw new Error('expected a profile');
    // /api/discord/profile answers the bot, whose embed draws none of this,
    // and it is the caller sitting on Discord's 3s interaction deadline.
    for (const t of ['matches', 'match_participants', 'head_to_head_stats', 'session_attendance']) {
      expect(from).not.toHaveBeenCalledWith(t);
    }
    expect(result.profile.recent).toEqual([]);
    expect(result.profile.rival).toBeNull();
    // Null, not 0. "Not fetched" is not the same claim as "never came".
    expect(result.profile.nights).toBeNull();
  });

  it('fetches nothing for a member the ladder excludes, even when asked to', async () => {
    // Their rating is off the ladder by their own setting or the club's. Their
    // match history on a permanently-cached public PNG would be the same
    // disclosure by another route.
    rpc.mockResolvedValue({ data: [], error: null });
    tables({ players: { data: playerRow(), error: null } });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(from).not.toHaveBeenCalledWith('matches');
    expect(result.profile.recent).toEqual([]);
    expect(result.profile.nights).toBeNull();
  });
});

describe('a match row may not name somebody the ladder does not list', () => {
  it('drops the name of an off-ladder opponent but keeps the result', async () => {
    rpc.mockResolvedValue({ data: [ladderRow()], error: null }); // p1 only
    tables({
      players: { data: playerRow(), error: null },
      matches: { data: [matchRow()], error: null },
      match_participants: {
        data: [
          { match_id: 'm1', player_id: 'p1', team_side: 'a', win_flag: true },
          // Hidden, suspended or pending — the ladder is the same answer for
          // all three, and none of them consented to a public image.
          { match_id: 'm1', player_id: 'hidden', team_side: 'b', win_flag: false },
        ],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.recent).toHaveLength(1);
    expect(result.profile.recent[0]!.opponents).toEqual([]);
    // The row is still a row: the member's own result is theirs to show.
    expect(result.profile.recent[0]!.won).toBe(true);
    expect(result.profile.recent[0]!.score).toBe('21-15, 21-18');
    expect(JSON.stringify(result.profile)).not.toContain('hidden');
  });

  it('names an opponent who is on the ladder', async () => {
    rpc.mockResolvedValue({
      data: [ladderRow(), ladderRow({ id: 'p2', name: 'Kiera Chan', handle: 'kiera' })],
      error: null,
    });
    tables({
      players: { data: playerRow(), error: null },
      matches: { data: [matchRow()], error: null },
      match_participants: {
        data: [
          { match_id: 'm1', player_id: 'p1', team_side: 'a', win_flag: true },
          { match_id: 'm1', player_id: 'p2', team_side: 'b', win_flag: false },
        ],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.recent[0]!.opponents).toEqual(['Kiera Chan']);
  });

  it('never counts the member\'s own partner as an opponent', async () => {
    rpc.mockResolvedValue({
      data: [
        ladderRow(),
        ladderRow({ id: 'mate', name: 'Sam Lee' }),
        ladderRow({ id: 'p2', name: 'Kiera Chan' }),
      ],
      error: null,
    });
    tables({
      players: { data: playerRow(), error: null },
      matches: { data: [matchRow()], error: null },
      match_participants: {
        data: [
          { match_id: 'm1', player_id: 'p1', team_side: 'a', win_flag: true },
          { match_id: 'm1', player_id: 'mate', team_side: 'a', win_flag: true },
          { match_id: 'm1', player_id: 'p2', team_side: 'b', win_flag: false },
        ],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.recent[0]!.opponents).toEqual(['Kiera Chan']);
  });
});

describe('the score reads from the member\'s side, not the admin\'s', () => {
  it('flips every game when the member played on side b', async () => {
    // score_summary is written sideA-sideB. Side A is whichever side the
    // submitting admin entered first, so printing it raw shows half the club
    // losing matches they won.
    rpc.mockResolvedValue({ data: [ladderRow()], error: null });
    tables({
      players: { data: playerRow(), error: null },
      matches: {
        data: [matchRow({ score_summary: '15-21, 18-21', winner_side: 'b' })],
        error: null,
      },
      match_participants: {
        data: [{ match_id: 'm1', player_id: 'p1', team_side: 'b', win_flag: null }],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.recent[0]!.score).toBe('21-15, 21-18');
    // win_flag was null; winner_side is the same answer off the match row.
    expect(result.profile.recent[0]!.won).toBe(true);
  });
});

describe('the rival record belongs to the member it is drawn on', () => {
  it('does not invert when the member is player_b', async () => {
    // head_to_head_stats has CHECK (player_a_id < player_b_id), so which
    // column holds the member is not knowable in advance — and reading the
    // wrong win count inverts the record with two entirely plausible numbers.
    rpc.mockResolvedValue({
      data: [ladderRow(), ladderRow({ id: 'p2', name: 'Kiera Chan' })],
      error: null,
    });
    tables({
      players: { data: playerRow(), error: null },
      head_to_head_stats: {
        data: [
          {
            player_a_id: 'p2',
            player_b_id: 'p1',
            player_a_wins: 2,
            player_b_wins: 5,
            total_matches: 7,
          },
        ],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.rival).toEqual({ name: 'Kiera Chan', wins: 5, losses: 2 });
  });

  it('adds the singles and doubles rows for the same person together', async () => {
    rpc.mockResolvedValue({
      data: [ladderRow(), ladderRow({ id: 'p2', name: 'Kiera Chan' })],
      error: null,
    });
    tables({
      players: { data: playerRow(), error: null },
      head_to_head_stats: {
        data: [
          { player_a_id: 'p1', player_b_id: 'p2', player_a_wins: 1, player_b_wins: 1, total_matches: 2 },
          { player_a_id: 'p1', player_b_id: 'p2', player_a_wins: 2, player_b_wins: 0, total_matches: 2 },
        ],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    // A rival is a person, not a discipline.
    expect(result.profile.rival).toEqual({ name: 'Kiera Chan', wins: 3, losses: 1 });
  });

  it('will not name an off-ladder rival, and will not call one meeting a rivalry', async () => {
    rpc.mockResolvedValue({ data: [ladderRow(), ladderRow({ id: 'p3', name: 'Sam Lee' })], error: null });
    tables({
      players: { data: playerRow(), error: null },
      head_to_head_stats: {
        data: [
          // Most-played, but not on the ladder: no name may be drawn for them.
          { player_a_id: 'hidden', player_b_id: 'p1', player_a_wins: 1, player_b_wins: 8, total_matches: 9 },
          // On the ladder, but a single meeting is a coincidence.
          { player_a_id: 'p1', player_b_id: 'p3', player_a_wins: 1, player_b_wins: 0, total_matches: 1 },
        ],
        error: null,
      },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.rival).toBeNull();
    expect(JSON.stringify(result.profile)).not.toContain('hidden');
  });
});

describe('nights played counts nights the member was there', () => {
  it('asks only for the statuses that mean present', async () => {
    // no_show and excused are rows on the record too, and counting them would
    // make the figure "nights on file" rather than "nights played".
    const { PRESENT_STATUSES } = await import('../schedule');
    expect([...PRESENT_STATUSES]).toEqual(['checked_in', 'present']);

    const src = readFileSync(join(SRC, 'lib', 'discord-profile.ts'), 'utf8');
    expect(src).toMatch(/session_attendance/);
    expect(src).toMatch(/\.in\('status', \[\.\.\.PRESENT_STATUSES\]\)/);
  });

  it('reports the count the database returned', async () => {
    rpc.mockResolvedValue({ data: [ladderRow()], error: null });
    tables({
      players: { data: playerRow(), error: null },
      session_attendance: { data: null, error: null, count: 27 },
    });

    const { resolveProfile } = await import('../discord-profile');
    const result = await resolveProfile({ by: 'playerId', value: 'p1' }, { withForm: true });

    if (!('profile' in result)) throw new Error('expected a profile');
    expect(result.profile.nights).toBe(27);
  });
});
