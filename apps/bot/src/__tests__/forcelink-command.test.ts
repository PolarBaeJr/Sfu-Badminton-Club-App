import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /forcelink: an exec attaches a Discord account to a club member who cannot run
// /link themselves.
//
// WHAT IS PINNED HERE IS THE BOT'S HALF, and it is deliberately not the rules.
// Who may do this, which member the handle names and what gets written all live
// in the app route, which is type-checked and separately tested. This file covers
// the three things only the bot can get wrong: the command's own shape, the
// sentence each refusal turns into, and the role strip afterwards.
//
// REFUSAL CODES ARE NEVER PRINTED. The route answers a 200 with a code chosen
// from a closed union; turning it into a sentence is commands.ts's job, and
// interpolating whatever arrived would put an app response body into a Discord
// message. Every case below asserts the code does not appear in the reply.
//
// WARNING FOR WHOEVER EDITS THIS FILE: apps/bot/tsconfig.json excludes
// src/**/__tests__/**, so nothing type-checks it. A type error here passes
// silently and the root `tsc --noEmit` will not see it.

const { forceLinkDiscordAccount, clearRevocations } = vi.hoisted(() => ({
  forceLinkDiscordAccount: vi.fn(),
  clearRevocations: vi.fn(),
}));
const { syncMemberEverywhere } = vi.hoisted(() => ({ syncMemberEverywhere: vi.fn() }));
const { postAuditEntry } = vi.hoisted(() => ({ postAuditEntry: vi.fn() }));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  forceLinkDiscordAccount,
  clearRevocations,
}));
vi.mock('../sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync.js')>()),
  syncMemberEverywhere,
}));
// summaryFromOutcomes stays REAL: the interesting assertion is which account the
// rolled-up summary is keyed to, and a fake would be asserting the fake.
vi.mock('../audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit.js')>()),
  postAuditEntry,
}));

import { COMMAND_DEFINITIONS, DEFERRED_COMMANDS, dispatch, handleForceLink } from '../commands.js';

const OFFICER = '424242';
const ARRIVING = '214300000000000000';
const OLD = '109900000000000000';

const CONTEXT = { discordUserId: OFFICER, guildId: 'g1' };

const OPTIONS = [
  { name: 'account', value: ARRIVING },
  { name: 'member', value: 'kiera' },
  { name: 'reason', value: 'they lost that account' },
];

const definition = () => COMMAND_DEFINITIONS.find((c) => c.name === 'forcelink')!;

function run(context = CONTEXT) {
  return handleForceLink(OPTIONS as never, context) as unknown as Promise<{
    data: { content: string; flags: number };
  }>;
}

const clean = [{ guildId: 'g1', added: 0, removed: 3, forbidden: 0, failed: 0, absent: false }];
const refused = [{ guildId: 'g1', added: 0, removed: 0, forbidden: 3, failed: 0, absent: false }];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  process.env.DISCORD_GUILDS = '{"g1":{"linked":"1"}}';
  forceLinkDiscordAccount.mockResolvedValue({
    ok: true,
    displacedDiscordUserId: null,
    memberName: 'Kiera Tan',
    alreadyThatAccount: false,
  });
  syncMemberEverywhere.mockResolvedValue(clean);
  postAuditEntry.mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILDS;
});

describe('the command definition', () => {
  it('is hidden from every member and unavailable in a DM', () => {
    // GATE 1 ONLY, and it is tidiness rather than security: it keeps exec tooling
    // out of everyone's picker. dm_permission is load-bearing beside it, because
    // default_member_permissions is a guild-only filter with no meaning in a DM.
    expect(definition().default_member_permissions).toBe('0');
    expect(definition().dm_permission).toBe(false);
  });

  it('takes a USER, a handle and a reason, all required', () => {
    const options = definition().options!;
    expect(options.map((o) => o.name)).toEqual(['account', 'member', 'reason']);
    expect(options.map((o) => o.type)).toEqual([6, 3, 3]);
    expect(options.every((o) => o.required)).toBe(true);
  });

  it('autocompletes the handle and only the handle', () => {
    // A USER option cannot autocomplete: Discord allows it on STRING, INTEGER and
    // NUMBER only, which is the same reason /profile has a separate handle option.
    const options = definition().options!;
    expect(options.map((o) => (o as { autocomplete?: boolean }).autocomplete ?? false)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('warns in the handle description that the picker cannot offer everybody', () => {
    // The member this command exists for is very often pending approval or hidden,
    // so they have no ladder row and are never suggested. An officer who does not
    // know that reads an empty picker as "no such member".
    const member = definition().options!.find((o) => o.name === 'member')!;
    expect(member.description).toMatch(/ladder/i);
    // Discord refuses an option description over 100 characters, and refusing it
    // takes the whole command registration down.
    for (const option of definition().options!) {
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
    expect(definition().description.length).toBeLessThanOrEqual(100);
  });

  it('is deferred, unlike the modal commands', () => {
    // The route makes about six round trips and the strip is a Discord call per
    // guild, which does not fit in Discord's three seconds. Deferring is only
    // wrong for a command that opens a modal or answers publicly, and this does
    // neither.
    expect(DEFERRED_COMMANDS.has('forcelink')).toBe(true);
  });

  it('is reachable through dispatch', async () => {
    await dispatch('forcelink', OPTIONS as never, CONTEXT);

    expect(forceLinkDiscordAccount).toHaveBeenCalledWith({
      discordUserId: OFFICER,
      targetDiscordUserId: ARRIVING,
      handle: 'kiera',
      reason: 'they lost that account',
    });
  });
});

describe('refusals', () => {
  const cases: [string, RegExp][] = [
    ['not_linked', /`\/link`/],
    ['not_permitted', /permission/i],
    ['no_such_member', /handle/i],
    ['already_linked_elsewhere', /different club member/i],
    ['no_reason', /why/i],
  ];

  for (const [refusal, matcher] of cases) {
    it(`renders ${refusal} as its own sentence, without printing the code`, async () => {
      forceLinkDiscordAccount.mockResolvedValue({ ok: false, refusal });

      const reply = await run();

      expect(reply.data.content).toMatch(matcher);
      expect(reply.data.content).not.toContain(refusal);
      expect(reply.data.flags).toBe(64);
      // Nothing was linked, so nothing should have been stripped either.
      expect(syncMemberEverywhere).not.toHaveBeenCalled();
      expect(clearRevocations).not.toHaveBeenCalled();
    });
  }

  it('tells an unlinked officer this command cannot fix their own account', async () => {
    // The route resolves the CALLER by their Discord id, so /forcelink can never
    // be the recovery path for an unlinked exec fixing themselves. The reply has
    // to say so, because the first instinct is to assume it can.
    forceLinkDiscordAccount.mockResolvedValue({ ok: false, refusal: 'not_linked' });

    const reply = await run();

    expect(reply.data.content).toMatch(/cannot fix your own/i);
  });

  it('says nothing about which check failed when permission is refused', async () => {
    // A banned exec and a member who never had the capability get the same
    // sentence.
    forceLinkDiscordAccount.mockResolvedValue({ ok: false, refusal: 'not_permitted' });

    const reply = await run();

    expect(reply.data.content).not.toMatch(/banned|suspended|standing/i);
  });

  it('refuses without calling the app when Discord did not identify the caller', async () => {
    const reply = await run({ discordUserId: null, guildId: 'g1' });

    expect(forceLinkDiscordAccount).not.toHaveBeenCalled();
    expect(reply.data.flags).toBe(64);
  });
});

describe('a link that displaced an account', () => {
  beforeEach(() => {
    forceLinkDiscordAccount.mockResolvedValue({
      ok: true,
      displacedDiscordUserId: OLD,
      memberName: 'Kiera Tan',
      alreadyThatAccount: false,
    });
  });

  it('strips the displaced account now and clears its tombstone', async () => {
    const reply = await run();

    // THE DISPLACED ACCOUNT, never the arriving one. A null desired state strips
    // every managed role, and the membership role goes with it: an account the app
    // no longer knows must not keep the role that opens the member-only channels.
    expect(syncMemberEverywhere).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      OLD,
      null,
      { revokeMembership: true }
    );
    expect(clearRevocations).toHaveBeenCalledWith([OLD]);
    expect(reply.data.content).toContain('removed');
  });

  it('does NOT clear the tombstone when Discord refused the strip', async () => {
    // A 403 is the ordinary answer for an exec, whose top role outranks the bot.
    // The tombstone has to survive so the sweep retries it.
    syncMemberEverywhere.mockResolvedValue(refused);

    const reply = await run();

    expect(clearRevocations).not.toHaveBeenCalled();
    expect(reply.data.content).toMatch(/shortly/);
  });

  it('still reports success when the strip throws', async () => {
    // The link is written and the trigger tombstoned the old account, so the
    // roles come off at the next sweep regardless. Failing here would invite the
    // officer to run it again against a link that is already correct.
    syncMemberEverywhere.mockRejectedValue(new Error('discord down'));

    const reply = await run();

    expect(reply.data.content).toContain('Kiera Tan');
    expect(clearRevocations).not.toHaveBeenCalled();
  });

  it('logs the entry against both accounts, keyed to the one that lost roles', async () => {
    await run();

    const event = postAuditEntry.mock.calls[0][2];
    expect(event.kind).toBe('member');
    expect(event.reason).toBe('linked');
    expect(event.discordUserIds).toEqual([ARRIVING, OLD]);
    // The outcomes are the DISPLACED account's removals, so the summary is keyed
    // to it. Keying it to the arriving account would render the removals beside
    // the account that just gained a link.
    expect(event.summary.changes[0].discordUserId).toBe(OLD);
    expect(event.summary.removed).toBe(3);
  });

  it('names no member and no handle in the audit entry', async () => {
    // audit.ts's rule: Discord ids rendered as mentions, and nothing else. An
    // audit channel inherits whatever permissions somebody set on it.
    await run();

    const posted = JSON.stringify(postAuditEntry.mock.calls[0][2]);
    expect(posted).not.toContain('Kiera Tan');
    expect(posted).not.toContain('kiera');
  });
});

describe('a link that displaced nothing', () => {
  it('strips nobody, clears nothing, and still records the act', async () => {
    const reply = await run();

    expect(syncMemberEverywhere).not.toHaveBeenCalled();
    expect(clearRevocations).not.toHaveBeenCalled();
    expect(postAuditEntry).toHaveBeenCalled();
    const event = postAuditEntry.mock.calls[0][2];
    expect(event.discordUserIds).toEqual([ARRIVING]);
    expect(reply.data.content).toContain('Kiera Tan');
  });

  it('says plainly when the link already named that account', async () => {
    forceLinkDiscordAccount.mockResolvedValue({
      ok: true,
      displacedDiscordUserId: null,
      memberName: 'Kiera Tan',
      alreadyThatAccount: true,
    });

    const reply = await run();

    expect(reply.data.content).toMatch(/already connected/i);
    expect(syncMemberEverywhere).not.toHaveBeenCalled();
  });

  it('leaves the roles to the sweep when there is no bot token', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const reply = await run();

    expect(postAuditEntry).not.toHaveBeenCalled();
    expect(reply.data.content).toContain('Kiera Tan');
  });
});
