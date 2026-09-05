import { describe, it, expect, vi, beforeEach } from 'vitest';

// /profile answers with an UPLOADED png, not an embed pointing at one.
//
// Two shapes have to hold and neither announces itself when broken. The
// attachment declaration lives inside `data` on an interaction callback, and
// getting that wrong is a 200 with no image and no error anywhere. And the card
// draws the provisional asterisk itself, so the footnote has to survive the move
// out of the embed footer — a cached public image with a bare `*` on it is the
// failure, and it outlives the message.
//
// The four misses stay ephemeral. They are the reason /profile is not deferred
// at all (index.ts defers everything ephemerally), so a change that made one of
// them public would undo the whole shape.

const fetchProfile = vi.fn();
const fetchCard = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchProfile,
  fetchCard,
}));

const CARD = {
  filename: 'card.png',
  contentType: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

const CONTEXT = { discordUserId: '424242', guildId: 'g1' };

function profile(over: Record<string, unknown> = {}) {
  return {
    profile: {
      id: 'p1',
      name: 'Ada Lam',
      handle: 'ada',
      avatarUrl: null,
      bio: null,
      status: 'competitive',
      ranked: true,
      doubles: { elo: 1200, provisional: false, wins: 9, losses: 3, streak: 2, rank: 4, compRank: 2 },
      singles: null,
      tournamentPoints: null,
      awards: [],
      ...over,
    },
    cardUrl: 'https://app.example/api/discord/card/tok',
  };
}

async function run(type?: string) {
  const { handleProfile } = await import('../commands.js');
  const options = type ? [{ name: 'type', type: 3, value: type }] : undefined;
  return handleProfile(options as never, CONTEXT) as Promise<{
    type: number;
    data: Record<string, unknown>;
    file?: typeof CARD;
  }>;
}

beforeEach(() => {
  vi.resetAllMocks();
  fetchCard.mockResolvedValue(CARD);
});

describe('/profile', () => {
  it('uploads the card instead of embedding a link to it', async () => {
    fetchProfile.mockResolvedValue(profile());
    const response = await run();

    // No embed at all. The card is the whole message.
    expect(response.data.embeds).toBeUndefined();
    expect(response.file).toBe(CARD);
    // INSIDE data, and the declared name matching the part's. Beside `data` it
    // is silently ignored and the message renders with no picture.
    expect(response.data.attachments).toEqual([{ id: 0, filename: 'card.png' }]);
  });

  it('sends the card with no message body, whatever the profile carries', async () => {
    // THE BIO AND THE FOOTNOTE ARE THE TWO THINGS THAT USED TO BE TYPED HERE,
    // so this asserts on a profile that would have produced both. They are
    // drawn on the card now: text beside an image does not survive a forward,
    // a quote or an embed, and the card has to be complete on its own.
    fetchProfile.mockResolvedValue(
      profile({
        bio: 'Left-handed, plays doubles',
        singles: { elo: 900, provisional: true, wins: 2, losses: 1, streak: 1, rank: 11, compRank: null },
      })
    );
    const response = await run();

    expect(response.data.content).toBeUndefined();
    expect(response.data.attachments).toEqual([{ id: 0, filename: 'card.png' }]);
    // Not just "no content" -- the strings themselves must be gone, or a
    // refactor that reinstates them under another key passes the line above.
    const body = JSON.stringify(response.data);
    expect(body).not.toContain('Left-handed');
    expect(body).not.toContain('provisional');
  });

  it('falls back to the url alone when the card cannot be fetched', async () => {
    // fetchCard answers null for every failure rather than throwing, precisely
    // so this branch is reachable. The bio is NOT re-added here: the link
    // points at the card that already draws it.
    fetchProfile.mockResolvedValue(profile({ bio: 'Doubles only' }));
    fetchCard.mockResolvedValue(null);
    const response = await run();

    expect(response.file).toBeUndefined();
    expect(response.data.attachments).toBeUndefined();
    expect(response.data.content).toBe('https://app.example/api/discord/card/tok');
  });

  it('skips the card fetch when fetchProfile has already eaten the budget', async () => {
    // Otherwise the skip and a null card are byte-identical from outside, and a
    // sign error here would pass every other test in this file. The first
    // Date.now is `started`; everything after it is the check.
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2_400);
    fetchProfile.mockResolvedValue(profile());

    const response = await run();

    expect(fetchCard).not.toHaveBeenCalled();
    expect(response.data.content).toContain('/api/discord/card/tok');
    now.mockRestore();
  });

  it('caps the card fetch so a slow read cannot eat the send window', async () => {
    // NOT the whole 2550 that is left. A read returning at the deadline still
    // leaves a multipart body to encode and write, and a blown deadline has no
    // fallback while a null card has one.
    //
    // The literal tracks MAX_CARD_FETCH_MS in commands.ts, which is a measured
    // number rather than a round one -- a real card renders in 611-1046ms from
    // inside the bot container on the Pi. If you change it there, change it
    // here, and re-measure rather than picking a new round number.
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(50);
    fetchProfile.mockResolvedValue(profile());

    await run();

    expect(fetchCard).toHaveBeenCalledWith(expect.any(String), 1_800);
    now.mockRestore();
  });

  it('honours a type the member has, on the card url', async () => {
    fetchProfile.mockResolvedValue(profile());

    const response = await run('comp_doubles');

    expect(fetchCard).toHaveBeenCalledWith(
      'https://app.example/api/discord/card/tok?type=comp_doubles',
      expect.any(Number)
    );
    expect(response.file).toBe(CARD);
  });

  it('says so in words when the member has no rank on the ladder asked for', async () => {
    // THE BUG THIS EXISTS FOR: the route falls back to the default table for a
    // member with no competitive rank, and that render is byte-identical to the
    // one with no type at all. From the member's side the option did nothing.
    fetchProfile.mockResolvedValue(
      profile({ status: 'recreational', doubles: { ...profile().profile.doubles, compRank: null } })
    );

    const response = await run('comp_doubles');

    expect(response.data.flags).toBe(64);
    expect(response.data.content).toContain('does not have competitive stats');
    // No card at all -- and asserting the fetch never happened is what stops a
    // future version answering in words AND spending the budget rendering the
    // very card the words say is wrong.
    expect(fetchCard).not.toHaveBeenCalled();
    expect(response.file).toBeUndefined();
  });

  it('treats a player app too old to send compRank as no competitive rank', async () => {
    // NOT the same as compRank: null, and the difference is a live one: an
    // older player app omits the key, so the value is undefined. A `=== null`
    // check reads that as a real competitive rank and renders the very card
    // this refusal exists to stop -- silently, and only on the deployment where
    // the bot has rolled ahead of its player, which is not a rare shape here.
    //
    // The key is DELETED rather than set, because setting it to undefined would
    // pass a `=== null` check for the wrong reason and is not what the wire
    // actually carries.
    const stale = profile();
    delete (stale.profile.doubles as Record<string, unknown>).compRank;
    fetchProfile.mockResolvedValue(stale);

    const response = await run('comp_doubles');

    expect(response.data.content).toContain('does not have competitive stats');
    expect(fetchCard).not.toHaveBeenCalled();
  });

  it('refuses a discipline the member has never played', async () => {
    fetchProfile.mockResolvedValue(profile({ singles: null }));

    const response = await run('open_singles');

    expect(response.data.flags).toBe(64);
    expect(response.data.content).toContain('singles');
    expect(fetchCard).not.toHaveBeenCalled();
  });

  it('leaves an unrecognised type to the route rather than inventing a miss', async () => {
    // The route matches against a fixed list of four and draws the default
    // table for anything else. Refusing here would be the bot answering for a
    // rule it does not own.
    fetchProfile.mockResolvedValue(profile());

    const response = await run('nonsense');

    expect(response.file).toBe(CARD);
    expect(response.data.content).toBeUndefined();
  });

  it('keeps every miss ephemeral and carries no file', async () => {
    const { handleProfile } = await import('../commands.js');

    for (const miss of ['not_linked', 'target_unlinked', 'no_such_handle', 'not_found']) {
      fetchProfile.mockResolvedValue({ miss });
      const response = (await handleProfile(undefined, CONTEXT)) as {
        data: { flags?: number };
        file?: unknown;
      };

      // 64 = EPHEMERAL. "You haven't linked yet" belongs to the caller, not the
      // channel, and no_such_handle deliberately does not say whether the
      // handle exists.
      expect(response.data.flags, miss).toBe(64);
      expect(response.file, miss).toBeUndefined();
    }
  });
});
