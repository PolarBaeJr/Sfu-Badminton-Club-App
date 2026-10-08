import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /forceupdate: an officer re-applies the club's current view of ONE member's
// roles, now.
//
// WHAT IS PINNED HERE IS THE BOT'S HALF. Who may do this and whether that
// account is connected to anybody live in the app route, which is type-checked
// and separately tested. This file covers the command's shape, the sentence each
// refusal turns into, and the resync afterwards.
//
// THE ONE REFUSAL WITH TEETH IS target_not_linked. syncMembersNow reads an id
// that is absent from the roster as "strip everything", deliberately, because
// that is how a tombstone gets cleared for free. So a resync aimed at an
// unlinked account would be a SILENT FULL STRIP rather than the refresh the
// officer asked for, and the case below is what keeps that one keystroke away
// from happening.
//
// WARNING FOR WHOEVER EDITS THIS FILE: apps/bot/tsconfig.json excludes
// src/**/__tests__/**, so nothing type-checks it. A type error here passes
// silently and the root `tsc --noEmit` will not see it.

const { forceSyncMember } = vi.hoisted(() => ({ forceSyncMember: vi.fn() }));
const { postAuditEntry } = vi.hoisted(() => ({ postAuditEntry: vi.fn() }));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  forceSyncMember,
}));
vi.mock('../audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit.js')>()),
  postAuditEntry,
}));
// MUST BE MOCKED. syncMembersNow loads config and builds a Discord client of its
// own, so unmocked it reaches the network, throws, and is swallowed by the
// catch in the handler. Every assertion in this file would then pass against a
// resync that never ran, which is exactly the trap forcelink-command.test.ts
// fell into once already.
const { syncMembersNow } = vi.hoisted(() => ({ syncMembersNow: vi.fn() }));
vi.mock('../member-sync.js', () => ({ syncMembersNow }));

import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  dispatch,
  handleForceUpdate,
} from '../commands.js';

const OFFICER = '424242';
const TARGET = '214300000000000000';

const CONTEXT = { discordUserId: OFFICER, guildId: 'g1' };

const OPTIONS = [{ name: 'member', value: TARGET }];

const definition = () => COMMAND_DEFINITIONS.find((c) => c.name === 'forceupdate')!;

function run(context = CONTEXT) {
  return handleForceUpdate(OPTIONS as never, context) as unknown as Promise<{
    data: { content: string; flags: number };
  }>;
}

const summaryOf = (over: Record<string, number> = {}) => ({
  cleared: [],
  changes: [],
  members: 1,
  added: 2,
  removed: 0,
  forbidden: 0,
  failed: 0,
  absent: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  process.env.DISCORD_GUILDS = '{"g1":{"linked":"1"}}';
  forceSyncMember.mockResolvedValue({ ok: true, memberName: 'Kiera Tan' });
  postAuditEntry.mockResolvedValue(true);
  syncMembersNow.mockResolvedValue({
    summary: summaryOf(),
    api: {},
    auditChannelId: 'audit-1',
  });
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILDS;
});

describe('the command definition', () => {
  it('is hidden from every member and unavailable in a DM', () => {
    expect(definition().default_member_permissions).toBe('0');
    expect(definition().dm_permission).toBe(false);
  });

  it('takes one required, autocompleting account and NO reason', () => {
    // No reason, deliberately: nothing is written to the club's records and the
    // act is convergent, so there is no by-hand edit to justify. The Discord
    // audit entry still names who ran it and about whom.
    const options = definition().options!;
    expect(options.map((o) => o.name)).toEqual(['member']);
    expect(options.map((o) => o.type)).toEqual([3]);
    expect(options.every((o) => o.required)).toBe(true);
    expect((options[0] as { autocomplete?: boolean }).autocomplete).toBe(true);
  });

  it('keeps every description inside Discord’s limit', () => {
    // Discord refuses a description over 100 characters, and refusing one takes
    // the whole command registration down rather than that one field.
    for (const option of definition().options!) {
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
    expect(definition().description.length).toBeLessThanOrEqual(100);
  });

  it('is deferred, unlike the modal commands', () => {
    expect(DEFERRED_COMMANDS.has('forceupdate')).toBe(true);
  });

  it('is reachable through dispatch', async () => {
    await dispatch('forceupdate', OPTIONS as never, CONTEXT);

    expect(forceSyncMember).toHaveBeenCalledWith({
      discordUserId: OFFICER,
      targetDiscordUserId: TARGET,
    });
  });
});

describe('refusals', () => {
  const cases: [string, RegExp][] = [
    ['not_linked', /`\/link`/],
    ['not_permitted', /permission/i],
    ['target_not_linked', /not connected/i],
  ];

  for (const [refusal, matcher] of cases) {
    it(`renders ${refusal} as its own sentence, without printing the code`, async () => {
      forceSyncMember.mockResolvedValue({ ok: false, refusal });

      const reply = await run();

      expect(reply.data.content).toMatch(matcher);
      expect(reply.data.content).not.toContain(refusal);
      expect(reply.data.flags).toBe(64);
      // NOTHING MAY REACH THE SYNC ON A REFUSAL. For target_not_linked in
      // particular, a resync would be a silent full strip.
      expect(syncMembersNow).not.toHaveBeenCalled();
    });
  }

  it('sends an officer with an unlinked target to /forcelink', async () => {
    forceSyncMember.mockResolvedValue({ ok: false, refusal: 'target_not_linked' });

    const reply = await run();

    expect(reply.data.content).toMatch(/`\/forcelink`/);
    expect(syncMembersNow).not.toHaveBeenCalled();
  });

  it('refuses without calling the app when Discord did not identify the caller', async () => {
    const reply = await run({ discordUserId: null, guildId: 'g1' });

    expect(forceSyncMember).not.toHaveBeenCalled();
    expect(reply.data.flags).toBe(64);
  });
});

describe('the resync', () => {
  it('syncs exactly the one account the officer named', async () => {
    // ONE MEMBER, NEVER THE ROSTER. The everyone path is POST /sync with
    // {"trigger":"manual"}, which holds the sweepInFlight guard a slash command
    // cannot reach.
    await run();

    expect(syncMembersNow).toHaveBeenCalledWith([TARGET]);
  });

  it('files a resynced entry carrying the summary unchanged', async () => {
    const summary = summaryOf();
    syncMembersNow.mockResolvedValue({ summary, api: {}, auditChannelId: 'audit-1' });

    await run();

    const event = postAuditEntry.mock.calls[0][2];
    expect(event.kind).toBe('member');
    expect(event.reason).toBe('resynced');
    expect(event.discordUserIds).toEqual([TARGET]);
    // STRAIGHT THROUGH. syncMembersNow already returns a SweepSummary;
    // summaryFromOutcomes is for the SyncOutcome[] path, and crossing the two is
    // the easy mistake here.
    expect(event.summary).toBe(summary);
  });

  it('names no member in the audit entry', async () => {
    await run();

    expect(JSON.stringify(postAuditEntry.mock.calls[0][2])).not.toContain('Kiera Tan');
  });

  it('reports the counts when roles actually moved', async () => {
    const reply = await run();

    expect(reply.data.content).toContain('Kiera Tan');
    expect(reply.data.content).toMatch(/2 roles added/);
  });

  it('says plainly that nothing needed changing when nothing did', async () => {
    // Clean does NOT mean anything was added. A member whose roles were already
    // correct adds zero, and promising them "shortly" would invent a problem.
    syncMembersNow.mockResolvedValue({
      summary: summaryOf({ added: 0, removed: 0 }),
      api: {},
      auditChannelId: 'audit-1',
    });

    const reply = await run();

    expect(reply.data.content).toMatch(/already had the right club roles/i);
    expect(reply.data.content).not.toMatch(/shortly/);
  });

  it('promises "shortly" rather than claiming roles Discord refused', async () => {
    // A 403 is the ordinary answer for an exec whose top role outranks the bot.
    syncMembersNow.mockResolvedValue({
      summary: summaryOf({ added: 0, forbidden: 3 }),
      api: {},
      auditChannelId: 'audit-1',
    });

    const reply = await run();

    expect(reply.data.content).toMatch(/shortly/);
  });

  it('does not fail the command when the resync itself throws', async () => {
    // NOTHING WAS WRITTEN TO THE CLUB'S RECORDS, so there is nothing half-done
    // and the worst case is a re-run of a convergent command. A missing bot
    // token reaches this path too, because syncMembersNow throws outright on
    // one: the reply has to survive that rather than read a summary that was
    // never produced.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    syncMembersNow.mockRejectedValue(new Error('DISCORD_BOT_TOKEN is not set'));

    const reply = await run();

    expect(reply.data.flags).toBe(64);
    expect(reply.data.content).toMatch(/shortly/);
    expect(postAuditEntry).not.toHaveBeenCalled();
  });
});
