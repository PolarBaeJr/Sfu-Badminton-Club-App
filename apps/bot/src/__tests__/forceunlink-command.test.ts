import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /forceunlink: an officer disconnects ANOTHER member's Discord account and
// takes their club roles off now.
//
// WHAT IS PINNED HERE IS THE BOT'S HALF, and it is deliberately not the rules.
// Who may do this, whether that account is connected to anybody and what goes in
// the club audit log all live in the app route, which is type-checked and
// separately tested. This file covers the four things only the bot can get
// wrong: the command's own shape, the sentence each refusal turns into, the role
// strip afterwards, and the picker that feeds the target option.
//
// REFUSAL CODES ARE NEVER PRINTED. The route answers a 200 with a code chosen
// from a closed union; turning it into a sentence is commands.ts's job, and
// interpolating whatever arrived would put an app response body into a Discord
// message. Every case below asserts the code does not appear in the reply.
//
// WARNING FOR WHOEVER EDITS THIS FILE: apps/bot/tsconfig.json excludes
// src/**/__tests__/**, so nothing type-checks it. A type error here passes
// silently and the root `tsc --noEmit` will not see it.

const { forceUnlinkDiscordAccount, clearRevocations, fetchLinkedAccounts } = vi.hoisted(() => ({
  forceUnlinkDiscordAccount: vi.fn(),
  clearRevocations: vi.fn(),
  fetchLinkedAccounts: vi.fn(),
}));
const { syncMemberEverywhere } = vi.hoisted(() => ({ syncMemberEverywhere: vi.fn() }));
const { postAuditEntry } = vi.hoisted(() => ({ postAuditEntry: vi.fn() }));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  forceUnlinkDiscordAccount,
  clearRevocations,
  fetchLinkedAccounts,
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

import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  LINKED_ACCOUNT_PICKERS,
  dispatch,
  handleForceUnlink,
  handleLinkedAccountAutocomplete,
} from '../commands.js';

const OFFICER = '424242';
const TARGET = '214300000000000000';

const CONTEXT = { discordUserId: OFFICER, guildId: 'g1' };

const OPTIONS = [
  { name: 'member', value: TARGET },
  { name: 'reason', value: 'they left the club' },
];

const definition = () => COMMAND_DEFINITIONS.find((c) => c.name === 'forceunlink')!;

function run(context = CONTEXT) {
  return handleForceUnlink(OPTIONS as never, context) as unknown as Promise<{
    data: { content: string; flags: number };
  }>;
}

const clean = [{ guildId: 'g1', added: 0, removed: 3, forbidden: 0, failed: 0, absent: false }];
const refused = [{ guildId: 'g1', added: 0, removed: 0, forbidden: 3, failed: 0, absent: false }];
// The member walked away from the server with their link row intact, which is
// the case this whole command exists for.
const departed = [{ guildId: 'g1', added: 0, removed: 0, forbidden: 0, failed: 0, absent: true }];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  process.env.DISCORD_GUILDS = '{"g1":{"linked":"1"}}';
  forceUnlinkDiscordAccount.mockResolvedValue({ ok: true, memberName: 'Kiera Tan' });
  syncMemberEverywhere.mockResolvedValue(clean);
  postAuditEntry.mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILDS;
});

describe('the command definition', () => {
  it('is hidden from every member and unavailable in a DM', () => {
    // GATE 1 ONLY, and it is tidiness rather than security. dm_permission is
    // load-bearing beside it, because default_member_permissions is a guild-only
    // filter with no meaning in a DM.
    expect(definition().default_member_permissions).toBe('0');
    expect(definition().dm_permission).toBe(false);
  });

  it('takes an account and a reason, both required strings', () => {
    const options = definition().options!;
    expect(options.map((o) => o.name)).toEqual(['member', 'reason']);
    expect(options.map((o) => o.type)).toEqual([3, 3]);
    expect(options.every((o) => o.required)).toBe(true);
  });

  it('autocompletes the account and only the account', () => {
    // A STRING RATHER THAN A USER OPTION, because a USER option is populated
    // from the guild's member list and the member this command exists for has
    // very often LEFT the server with their link row intact.
    const options = definition().options!;
    expect(options.map((o) => (o as { autocomplete?: boolean }).autocomplete ?? false)).toEqual([
      true,
      false,
    ]);
  });

  it('tells the officer a raw ID works too, within Discord’s description limit', () => {
    // Autocomplete returns at most 25 rows, so in a club past that size the
    // picker cannot offer everybody and a pasted snowflake is the way through.
    const member = definition().options!.find((o) => o.name === 'member')!;
    expect(member.description).toMatch(/ID/);
    // Discord refuses an option description over 100 characters, and refusing it
    // takes the whole command registration down.
    for (const option of definition().options!) {
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
    expect(definition().description.length).toBeLessThanOrEqual(100);
  });

  it('is deferred, unlike the modal commands', () => {
    // The route makes four round trips and the strip is a Discord call per
    // guild. Deferring is only wrong for a command that opens a modal or answers
    // publicly, and this does neither.
    expect(DEFERRED_COMMANDS.has('forceunlink')).toBe(true);
  });

  it('is reachable through dispatch', async () => {
    await dispatch('forceunlink', OPTIONS as never, CONTEXT);

    // THE CALLER AND THE TARGET ARE DIFFERENT PEOPLE, and the route checks the
    // capability of the first one. Swapping them would ask whether the member
    // being disconnected may disconnect themselves.
    expect(forceUnlinkDiscordAccount).toHaveBeenCalledWith({
      discordUserId: OFFICER,
      targetDiscordUserId: TARGET,
      reason: 'they left the club',
    });
  });
});

describe('refusals', () => {
  const cases: [string, RegExp][] = [
    ['not_linked', /`\/link`/],
    ['not_permitted', /permission/i],
    ['no_reason', /why/i],
    ['target_not_linked', /not connected/i],
  ];

  for (const [refusal, matcher] of cases) {
    it(`renders ${refusal} as its own sentence, without printing the code`, async () => {
      forceUnlinkDiscordAccount.mockResolvedValue({ ok: false, refusal });

      const reply = await run();

      expect(reply.data.content).toMatch(matcher);
      expect(reply.data.content).not.toContain(refusal);
      expect(reply.data.flags).toBe(64);
      // Nothing was unlinked, so nothing should have been stripped either.
      expect(syncMemberEverywhere).not.toHaveBeenCalled();
      expect(clearRevocations).not.toHaveBeenCalled();
    });
  }

  it('says nothing was changed when another officer won the race', async () => {
    // The loser's delete matched no rows, which the route reports as
    // target_not_linked. Claiming success there would put an audit row under
    // the wrong officer's name.
    forceUnlinkDiscordAccount.mockResolvedValue({ ok: false, refusal: 'target_not_linked' });

    const reply = await run();

    expect(reply.data.content).toMatch(/nothing was changed/i);
  });

  it('says nothing about which check failed when permission is refused', async () => {
    // A banned exec and a member who never had the capability get the same
    // sentence.
    forceUnlinkDiscordAccount.mockResolvedValue({ ok: false, refusal: 'not_permitted' });

    const reply = await run();

    expect(reply.data.content).not.toMatch(/banned|suspended|standing/i);
  });

  it('refuses without calling the app when Discord did not identify the caller', async () => {
    const reply = await run({ discordUserId: null, guildId: 'g1' });

    expect(forceUnlinkDiscordAccount).not.toHaveBeenCalled();
    expect(reply.data.flags).toBe(64);
  });
});

describe('the strip that follows the delete', () => {
  it('strips the target everywhere and clears its tombstone', async () => {
    const reply = await run();

    // A null desired state strips every managed role, and the membership role
    // goes with it: an account the app no longer knows must not keep the role
    // that opens the member-only channels.
    expect(syncMemberEverywhere).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      TARGET,
      null,
      { revokeMembership: true }
    );
    expect(clearRevocations).toHaveBeenCalledWith([TARGET]);
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

  it('treats a member who has left the server as a clean unlink', async () => {
    // THE CASE THE COMMAND EXISTS FOR. There were no roles to take off somebody
    // who is not in the guild, and the link row, which is what the officer asked
    // to remove, is already gone. Reporting that as a failure would be a lie
    // about the only half that mattered.
    syncMemberEverywhere.mockResolvedValue(departed);

    const reply = await run();

    expect(clearRevocations).toHaveBeenCalledWith([TARGET]);
    expect(reply.data.content).toContain('removed');
  });

  it('still reports success when the strip throws', async () => {
    // The row is already deleted and 00165's trigger tombstoned the account, so
    // the roles come off at the next sweep regardless. Failing here would invite
    // the officer to run it again against a row that no longer exists, which
    // would answer target_not_linked and read as a broken command.
    syncMemberEverywhere.mockRejectedValue(new Error('discord down'));

    const reply = await run();

    expect(reply.data.content).toContain('Kiera Tan');
    expect(clearRevocations).not.toHaveBeenCalled();
  });

  it('leaves the roles to the sweep when there is no bot token', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const reply = await run();

    expect(syncMemberEverywhere).not.toHaveBeenCalled();
    expect(postAuditEntry).not.toHaveBeenCalled();
    expect(reply.data.content).toMatch(/shortly/);
  });
});

describe('the audit entry', () => {
  it('files one member entry, keyed to the disconnected account', async () => {
    await run();

    const event = postAuditEntry.mock.calls[0][2];
    expect(event.kind).toBe('member');
    // No new AuditEvent variant: MEMBER_TITLES.unlinked is "Account unlinked",
    // which is exactly what happened.
    expect(event.reason).toBe('unlinked');
    expect(event.discordUserIds).toEqual([TARGET]);
    expect(event.summary.changes[0].discordUserId).toBe(TARGET);
    expect(event.summary.removed).toBe(3);
  });

  it('names no member in the audit entry', async () => {
    // audit.ts's rule: Discord ids rendered as mentions, and nothing else. The
    // ephemeral reply may name the member because only the officer reads it; an
    // audit channel inherits whatever permissions somebody set on it.
    await run();

    const posted = JSON.stringify(postAuditEntry.mock.calls[0][2]);
    expect(posted).not.toContain('Kiera Tan');
    expect(posted).not.toContain('they left the club');
  });
});

// The picker behind the `member` option on both force commands. It is tested
// here rather than in autocomplete.test.ts because that file is about the
// LADDER picker, and the whole point of this one is that it reads the link rows
// instead.
describe('the linked-account picker', () => {
  const focused = (value: string) => [{ name: 'member', value, type: 3, focused: true }];

  const choices = (response: unknown) =>
    (response as { data: { choices: { name: string; value: string }[] } }).data.choices;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('feeds the two force commands and leaves the ladder pickers alone', () => {
    // /profile and /forcelink read the club ladder, which is the
    // privacy-equivalent source /profile's own route is built on. Moving either
    // onto this list would start suggesting members the ladder hides.
    expect(LINKED_ACCOUNT_PICKERS.has('forceunlink')).toBe(true);
    expect(LINKED_ACCOUNT_PICKERS.has('forceupdate')).toBe(true);
    expect(LINKED_ACCOUNT_PICKERS.has('forcelink')).toBe(false);
    expect(LINKED_ACCOUNT_PICKERS.has('profile')).toBe(false);
  });

  it('answers with the SNOWFLAKE as the value and the readable label as the name', async () => {
    // The value lands straight in the option the handler hands to the route,
    // whose delete keys on discord_user_id, so anything decorative in it becomes
    // an unlink for an account nobody has.
    fetchLinkedAccounts.mockResolvedValue({
      ok: true,
      choices: [{ name: `Kiera Tan (competitive) ${TARGET}`, value: TARGET }],
    });

    const response = await handleLinkedAccountAutocomplete(focused('kie') as never, CONTEXT);

    expect(fetchLinkedAccounts).toHaveBeenCalledWith({ discordUserId: OFFICER, query: 'kie' });
    expect(choices(response)[0]).toEqual({
      name: `Kiera Tan (competitive) ${TARGET}`,
      value: TARGET,
    });
  });

  it('answers a REFUSAL with an empty list rather than an error', async () => {
    // An error would itself confirm that rows exist, which is exactly the
    // disclosure the route's capability check is there to prevent. An officer
    // without the capability sees an empty picker, not a complaint.
    fetchLinkedAccounts.mockResolvedValue({ ok: false, refusal: 'not_permitted' });

    const response = await handleLinkedAccountAutocomplete(focused('kie') as never, CONTEXT);

    expect(choices(response)).toEqual([]);
  });

  it('answers a timeout with an empty list rather than throwing', async () => {
    // An autocomplete has no user-visible failure mode: a throw renders as
    // "loading options failed" with nothing in the log saying why.
    fetchLinkedAccounts.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    const response = await handleLinkedAccountAutocomplete(focused('kie') as never, CONTEXT);

    expect(choices(response)).toEqual([]);
  });

  it('truncates past Discord’s limit of 25', async () => {
    // Discord rejects the WHOLE response above 25, not the surplus rows, so a
    // route that ever stopped capping would leave the picker suggesting nothing
    // at all.
    fetchLinkedAccounts.mockResolvedValue({
      ok: true,
      choices: Array.from({ length: 60 }, (_, i) => ({ name: `Member ${i}`, value: `${i}` })),
    });

    const response = await handleLinkedAccountAutocomplete(focused('') as never, CONTEXT);

    expect(choices(response)).toHaveLength(25);
  });

  it('asks for nothing when Discord did not identify the caller', async () => {
    // The route needs the officer's id to run the capability check, so there is
    // nothing to ask with.
    const response = await handleLinkedAccountAutocomplete(focused('kie') as never, {
      discordUserId: null,
      guildId: 'g1',
    });

    expect(fetchLinkedAccounts).not.toHaveBeenCalled();
    expect(choices(response)).toEqual([]);
  });
});
