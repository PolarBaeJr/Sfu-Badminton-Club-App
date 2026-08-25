import { describe, expect, it, vi } from 'vitest';
import { buildAuditEmbed, postAuditEntry, summaryFromOutcomes } from '../audit.js';
import type { SweepSummary } from '../reconcile.js';
import type { SyncOutcome } from '../sync.js';

const NOW = new Date('2026-08-25T10:50:00.000Z');

function summary(over: Partial<SweepSummary> = {}): SweepSummary {
  return {
    cleared: [],
    changes: [],
    members: 0,
    added: 0,
    removed: 0,
    forbidden: 0,
    failed: 0,
    absent: 0,
    ...over,
  };
}

function outcome(over: Partial<SyncOutcome> = {}): SyncOutcome {
  return { guildId: 'g1', added: 0, removed: 0, forbidden: 0, failed: 0, absent: false, ...over };
}

describe('buildAuditEmbed', () => {
  it('names the members it changed rather than only counting them', () => {
    const embed = buildAuditEmbed(
      {
        kind: 'sweep',
        guilds: 1,
        trigger: 'scheduled',
        summary: summary({
          members: 40,
          added: 3,
          removed: 1,
          changes: [
            { discordUserId: '111', added: 2, removed: 0, forbidden: 0, failed: 0 },
            { discordUserId: '222', added: 1, removed: 1, forbidden: 0, failed: 0 },
          ],
        }),
      },
      NOW
    );
    expect(embed.description).toContain('<@111> — +2');
    expect(embed.description).toContain('<@222> — +1 -1');
    expect(embed.title).toBe('Nightly role sync');
  });

  it('says so plainly when a sweep found nothing to do', () => {
    const embed = buildAuditEmbed(
      { kind: 'sweep', guilds: 2, trigger: 'scheduled', summary: summary({ members: 40 }) },
      NOW
    );
    expect(embed.description).toMatch(/already had the right roles/);
  });

  // The point of the cap is that it is VISIBLE. A truncated list that reads as
  // complete is worse than no list at all.
  it('states the remainder instead of silently truncating', () => {
    const changes = Array.from({ length: 30 }, (_, i) => ({
      discordUserId: String(i),
      added: 1,
      removed: 0,
      forbidden: 0,
      failed: 0,
    }));
    const embed = buildAuditEmbed(
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary({ changes, added: 30 }) },
      NOW
    );
    expect(embed.description).toContain('…and 5 more');
    // The COUNTS stay true even though the list is cut.
    expect(embed.fields?.find((f) => f.name === 'Roles added')?.value).toBe('30');
  });

  // A 403 on an exec is the expected answer every single night. Colouring it
  // red would make a correct sweep look like an incident, nightly.
  it('colours a refusal amber and a real failure red', () => {
    const refused = buildAuditEmbed(
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary({ forbidden: 4 }) },
      NOW
    );
    const failed = buildAuditEmbed(
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary({ failed: 1 }) },
      NOW
    );
    expect(refused.color).toBe(0xf1c40f);
    expect(failed.color).toBe(0xe74c3c);
  });

  it('omits count fields that are zero so the interesting ones stand out', () => {
    const embed = buildAuditEmbed(
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary({ members: 5, added: 1 }) },
      NOW
    );
    const names = (embed.fields ?? []).map((f) => f.name);
    expect(names).not.toContain('Failed');
    expect(names).not.toContain('Refused (outranks bot)');
    expect(names).toContain('Roles added');
  });

  it('distinguishes a manual sweep from the nightly one', () => {
    const embed = buildAuditEmbed(
      { kind: 'sweep', guilds: 1, trigger: 'manual', summary: summary() },
      NOW
    );
    expect(embed.title).toMatch(/manually triggered/);
  });

  it('records a member event even when nothing needed changing', () => {
    const embed = buildAuditEmbed(
      { kind: 'member', reason: 'linked', discordUserIds: ['999'], summary: summary({ members: 1 }) },
      NOW
    );
    expect(embed.title).toBe('Account linked');
    expect(embed.description).toContain('<@999>');
    expect(embed.description).toMatch(/No role changes were needed/);
  });
});

describe('postAuditEntry', () => {
  it('is a no-op with no channel configured', async () => {
    const api = { createMessage: vi.fn() };
    const posted = await postAuditEntry(
      api as never,
      undefined,
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary() },
      NOW
    );
    expect(posted).toBe(false);
    expect(api.createMessage).not.toHaveBeenCalled();
  });

  // Rule 1 in audit.ts: the log never fails the work it records.
  it('swallows a thrown error rather than failing the caller', async () => {
    const api = { createMessage: vi.fn().mockRejectedValue(new Error('boom')) };
    const log = vi.fn();
    const posted = await postAuditEntry(
      api as never,
      '123',
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary() },
      NOW,
      log
    );
    expect(posted).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not write audit entry'));
  });

  it('warns when Discord refuses the post, since an empty channel looks the same', async () => {
    const api = { createMessage: vi.fn().mockResolvedValue(false) };
    const log = vi.fn();
    await postAuditEntry(
      api as never,
      '123',
      { kind: 'sweep', guilds: 1, trigger: 'scheduled', summary: summary() },
      NOW,
      log
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('can post in that channel'));
  });

  it('sends the embed under an embeds array', async () => {
    const api = { createMessage: vi.fn().mockResolvedValue(true) };
    await postAuditEntry(
      api as never,
      'chan',
      { kind: 'member', reason: 'unlinked', discordUserIds: ['7'], summary: summary() },
      NOW
    );
    expect(api.createMessage).toHaveBeenCalledWith('chan', {
      embeds: [expect.objectContaining({ title: 'Account unlinked' })],
    });
  });
});

describe('summaryFromOutcomes', () => {
  it('rolls several guilds into one row', () => {
    const s = summaryFromOutcomes('42', [
      outcome({ removed: 3 }),
      outcome({ guildId: 'g2', removed: 2, forbidden: 1 }),
    ]);
    expect(s.removed).toBe(5);
    expect(s.forbidden).toBe(1);
    expect(s.changes).toEqual([
      { discordUserId: '42', added: 0, removed: 5, forbidden: 1, failed: 0 },
    ]);
  });

  it('records no change when every guild was already correct', () => {
    const s = summaryFromOutcomes('42', [outcome(), outcome({ guildId: 'g2', absent: true })]);
    expect(s.changes).toEqual([]);
    expect(s.absent).toBe(1);
  });
});
