import { describe, it, expect, vi, beforeEach } from 'vitest';

// @Internal / @Alumni / @External in the picker: the one place this bot reads a
// Discord role and writes it back to the app.
//
// What is pinned here is the difference between a membership role and a ping
// role, because the code path is shared and only the consequences differ:
//
//   - picking one updates players.membership_type, which is what prices a
//     tournament entry;
//   - picking one takes the other two off, because the app stores exactly one;
//   - un-picking one changes NOTHING on the website, because there is no
//     "no membership" to write;
//   - an unlinked account changes their Discord role and is told the website
//     did not follow, rather than being left to assume it did.

const fetchSelfRoles = vi.fn();
const setMembership = vi.fn();
const loadConfig = vi.fn();
const addRole = vi.fn();
const removeRole = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSelfRoles,
  setMembership,
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));

vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    addRole = addRole;
    removeRole = removeRole;
  },
}));

// This guild's map: 3 is @Internal, 5 is @Alumni, 900 is an ordinary ping role.
const REGISTRY = new Map([['g1', { linked: '1', internal: '3', alumni: '5' }]]);

const OFFERED = [
  { roleId: '900', label: 'Competitive nights', emoji: '🏸', sortOrder: 1 },
  { roleId: '3', label: 'SFU student', emoji: '🎓', sortOrder: 2 },
  { roleId: '5', label: 'SFU alumni', emoji: '🎓', sortOrder: 3 },
];

const CTX = { discordUserId: '42', guildId: 'g1' };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  fetchSelfRoles.mockResolvedValue({ roles: OFFERED, truncated: false });
  loadConfig.mockResolvedValue({ registry: REGISTRY, auditChannelId: null });
  setMembership.mockResolvedValue({ ok: true, updated: 1, unchanged: 0, skipped: 0, failed: 0 });
  addRole.mockResolvedValue('ok');
  removeRole.mockResolvedValue('ok');
});

describe('picking a membership role', () => {
  it('adds the role and tells the app what the member picked', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, [])) as {
      data: { content: string };
    };

    expect(addRole).toHaveBeenCalledWith('g1', '42', '3');
    expect(setMembership).toHaveBeenCalledWith([
      { discordUserId: '42', membershipType: 'internal' },
    ]);
    expect(res.data.content).toMatch(/internal/);
  });

  it('takes the other membership roles off, because the app stores one', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    // Holds @Alumni, clicks @Internal.
    await handleSelfRoleButton('selfrole:3', CTX, ['5']);

    expect(addRole).toHaveBeenCalledWith('g1', '42', '3');
    expect(removeRole).toHaveBeenCalledWith('g1', '42', '5');
    expect(setMembership).toHaveBeenCalledWith([
      { discordUserId: '42', membershipType: 'internal' },
    ]);
  });

  it('does not strip a membership role the member does not hold', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    await handleSelfRoleButton('selfrole:3', CTX, []);
    expect(removeRole).not.toHaveBeenCalled();
  });

  it('leaves the website alone when a membership role is turned OFF', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, ['3'])) as {
      data: { content: string };
    };

    expect(removeRole).toHaveBeenCalledWith('g1', '42', '3');
    // The membership column always holds one of the three; there is nothing to
    // write, and guessing a default would move somebody's fee tier silently.
    expect(setMembership).not.toHaveBeenCalled();
    expect(res.data.content).toMatch(/still has your membership/i);
  });

  it('says the website did not follow when the account is not linked', async () => {
    setMembership.mockResolvedValue({
      ok: true,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      failed: 0,
    });
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, [])) as {
      data: { content: string };
    };

    expect(addRole).toHaveBeenCalled();
    expect(res.data.content).toMatch(/\/link/);
  });

  it('keeps the role and admits the write failed rather than claiming success', async () => {
    setMembership.mockRejectedValue(new Error('app is down'));
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, [])) as {
      data: { content: string };
    };

    expect(addRole).toHaveBeenCalledWith('g1', '42', '3');
    expect(res.data.content).toMatch(/nightly sync/i);
  });
});

describe('an ordinary ping role is unaffected', () => {
  it('writes nothing to the app', async () => {
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:900', CTX, [])) as {
      data: { content: string };
    };

    expect(addRole).toHaveBeenCalledWith('g1', '42', '900');
    expect(setMembership).not.toHaveBeenCalled();
    expect(res.data.content).toMatch(/pinged/);
  });

  it('is unaffected by a guild whose role map cannot be read', async () => {
    // Degrading to "no membership roles" is the safe direction: the button
    // behaves as a ping role and the sweep repairs the website later.
    loadConfig.mockRejectedValue(new Error('config unavailable'));
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, [])) as {
      data: { content: string };
    };

    expect(addRole).toHaveBeenCalledWith('g1', '42', '3');
    expect(setMembership).not.toHaveBeenCalled();
    expect(res.data.content).toMatch(/SFU student/);
  });
});
