import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /link and /unlink are the only commands that act on the CALLER rather than on
// public data, so what is pinned here is mostly about identity: that the right
// Discord account is named, and that nothing succeeds without one.

const mintLinkToken = vi.fn();
const deleteLink = vi.fn();
const clearRevocations = vi.fn();
const syncMemberEverywhere = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  mintLinkToken,
  deleteLink,
  clearRevocations,
}));
vi.mock('../sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync.js')>()),
  syncMemberEverywhere,
}));

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  process.env.DISCORD_GUILDS = '{"g1":{"linked":"1"}}';
});
afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILDS;
});

describe('/link', () => {
  it('mints against the caller and replies ephemerally with a button', async () => {
    mintLinkToken.mockResolvedValue({
      url: 'https://sfubadminton.com/link/' + 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    const { handleLink } = await import('../commands.js');
    const reply = await handleLink({ discordUserId: '123456789', guildId: 'g1' });

    expect(mintLinkToken).toHaveBeenCalledWith('123456789', 'g1');
    // EPHEMERAL IS THE POINT: the reply carries a single-use credential, and
    // anyone who could read it could attach their own account instead.
    expect(reply.data.flags).toBe(64);

    // The token must ride in a BUTTON, not in the message body — Discord
    // unfurls URLs it finds in content, and an unfurl is a GET from Discord's
    // servers against a one-time token.
    const button = reply.data.components?.[0]?.components?.[0] as { url?: string };
    expect(button?.url).toContain('/link/');
    expect(JSON.stringify(reply.data.embeds)).not.toContain('/link/');
  });

  it('refuses when Discord did not identify the caller', async () => {
    const { handleLink } = await import('../commands.js');
    const reply = await handleLink({ discordUserId: null, guildId: null });

    // Minting here would bind a token to "null" and hand it to whoever asked.
    expect(mintLinkToken).not.toHaveBeenCalled();
    expect(reply.data.flags).toBe(64);
  });
});

describe('/unlink', () => {
  it('says so plainly when the caller was never linked', async () => {
    deleteLink.mockResolvedValue(false);

    const { handleUnlink } = await import('../commands.js');
    const reply = await handleUnlink({ discordUserId: '123456789', guildId: null });

    expect(reply.data.content).toContain('not connected');
    // Nothing was deleted, so nothing is pending — stripping roles or clearing
    // a tombstone here would be acting on an account we never touched.
    expect(syncMemberEverywhere).not.toHaveBeenCalled();
    expect(clearRevocations).not.toHaveBeenCalled();
  });

  it('strips roles immediately and clears the tombstone', async () => {
    deleteLink.mockResolvedValue(true);
    syncMemberEverywhere.mockResolvedValue([
      { guildId: 'g1', added: 0, removed: 3, forbidden: 0, failed: 0, absent: false },
    ]);

    const { handleUnlink } = await import('../commands.js');
    const reply = await handleUnlink({ discordUserId: '123456789', guildId: null });

    // null desired state = strip every managed role.
    expect(syncMemberEverywhere).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '123456789',
      null
    );
    expect(clearRevocations).toHaveBeenCalledWith(['123456789']);
    expect(reply.data.content).toContain('removed');
  });

  it('does NOT clear the tombstone when Discord refused the strip', async () => {
    // The ordinary case for an exec, whose top role outranks the bot. The
    // tombstone has to survive so the sweep retries it.
    deleteLink.mockResolvedValue(true);
    syncMemberEverywhere.mockResolvedValue([
      { guildId: 'g1', added: 0, removed: 0, forbidden: 3, failed: 0, absent: false },
    ]);

    const { handleUnlink } = await import('../commands.js');
    const reply = await handleUnlink({ discordUserId: '123456789', guildId: null });

    expect(clearRevocations).not.toHaveBeenCalled();
    // The member is told it worked, because it did — the link is gone and the
    // roles are a matter of when, not whether.
    expect(reply.data.content).toContain('shortly');
  });

  it('still reports success when the strip throws', async () => {
    // The delete already tombstoned the account, so the roles come off at the
    // next sweep regardless. Failing the command here would invite the member
    // to run /unlink again against a link that no longer exists.
    deleteLink.mockResolvedValue(true);
    syncMemberEverywhere.mockRejectedValue(new Error('discord down'));

    const { handleUnlink } = await import('../commands.js');
    const reply = await handleUnlink({ discordUserId: '123456789', guildId: null });

    expect(reply.data.content).toContain('Disconnected');
    expect(clearRevocations).not.toHaveBeenCalled();
  });
});
