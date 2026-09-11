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
const isMemberBanned = vi.fn();
const loadConfig = vi.fn();
const addRole = vi.fn();
const removeRole = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSelfRoles,
  setMembership,
  isMemberBanned,
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
  isMemberBanned.mockResolvedValue(false);
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
    // And it does NOT promise a nightly sync will fix it. Nothing reads these
    // roles back any more, so the only repairs are another click or an exec.
    expect(res.data.content).toMatch(/ask an exec/i);
    expect(res.data.content).not.toMatch(/nightly/i);
  });
});

describe('a banned member cannot set their own membership', () => {
  // membership_type prices a tournament entry and gates which events a member
  // may enter, and this click is the only thing that writes it: there is no
  // sweep behind it to correct a write that should not have happened.

  it('refuses the write, and says nothing about which check failed', async () => {
    isMemberBanned.mockResolvedValue(true);
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, [])) as {
      data: { content: string };
    };

    expect(setMembership).not.toHaveBeenCalled();
    // The ROLE still goes on, and stays on. Taking it off here is the sweep's
    // job, through revokeMembership, which is the path that always did it.
    expect(addRole).toHaveBeenCalledWith('g1', '42', '3');
    expect(res.data.content).not.toMatch(/ban/i);
  });

  it('fails closed when it cannot find out whether they are banned', async () => {
    // "I could not find out" is not "they are in good standing", and nothing
    // revisits this write later.
    isMemberBanned.mockRejectedValue(new Error('app is down'));
    const { handleSelfRoleButton } = await import('../commands.js');
    const res = (await handleSelfRoleButton('selfrole:3', CTX, [])) as {
      data: { content: string };
    };

    expect(setMembership).not.toHaveBeenCalled();
    expect(res.data.content).toMatch(/ask an exec/i);
  });

  it('is not asked about when a membership role is turned OFF', async () => {
    // Nothing is written on the way off, so there is nothing to refuse, and
    // this path must not spend a request out of Discord's 3-second budget.
    const { handleSelfRoleButton } = await import('../commands.js');
    await handleSelfRoleButton('selfrole:3', CTX, ['3']);
    expect(isMemberBanned).not.toHaveBeenCalled();
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
    // And it does not go asking the app about a ban. A ping role has no
    // consequence on the website, and the whole click has three seconds.
    expect(isMemberBanned).not.toHaveBeenCalled();
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
