import { describe, it, expect } from 'vitest';
import {
  AUDIENCE_OPTIONS,
  DISCORD_CHANNEL_SETTINGS,
  TYPE_OPTIONS,
  audienceLabel,
  bylineName,
  composerModes,
  reachPercent,
  relayChip,
  showsModeSelector,
  tallyOpens,
  typeBadge,
} from '../../app/announcements/announcement-shape';

// The two enums this screen writes into, copied from 00001_schema.sql (595 and
// 597). If a migration widens either, this fails and the select is updated —
// which is the point. A form offering a value Postgres rejects is a form that
// cannot save, and one MISSING a value silently hides a category from the club.
const ANNOUNCEMENT_TYPE = ['info', 'warning', 'urgent', 'event'];
const ANNOUNCEMENT_AUDIENCE = ['all', 'competitive', 'recreational', 'eligible_only'];

// The channel settings the club is allowed to have, copied from `WRITABLE` in
// apps/player/src/app/api/discord/settings/route.ts, which that file calls the
// rule rather than the menu. A key the picker offers and nothing can ever write
// is a dead entry in a dropdown; a key missing from the picker is a channel the
// club configured and the console then pretends it cannot see.
const DISCORD_CHANNEL_KEYS = [
  'announcement_channel_id',
  'session_ping_channel_id',
  'match_results_channel_id',
  'feedback_channel_id',
  'event_feedback_channel_id',
  'audit_channel_id',
];

describe('announcement vocabulary', () => {
  it('offers exactly the announcement_type enum', () => {
    expect(TYPE_OPTIONS.map((o) => o.value).sort()).toEqual([...ANNOUNCEMENT_TYPE].sort());
  });

  it('offers exactly the announcement_audience enum', () => {
    expect(AUDIENCE_OPTIONS.map((o) => o.value).sort()).toEqual([...ANNOUNCEMENT_AUDIENCE].sort());
  });

  it('gives every real category a badge', () => {
    for (const type of ANNOUNCEMENT_TYPE) {
      expect(typeBadge(type).label).toBe(type.toUpperCase());
    }
  });

  it('falls back rather than returning undefined for a category it has never seen', () => {
    // A fifth value added by a future migration must render as itself, not
    // pass `undefined` into the Badge variant prop.
    const badge = typeBadge('venue');
    expect(badge.variant).toBe('neutral');
    expect(badge.label).toBe('VENUE');
  });

  it('labels an unknown audience as itself', () => {
    expect(audienceLabel('all')).toBe('Every member');
    expect(audienceLabel('varsity')).toBe('varsity');
  });
});

describe('the Discord channel picker', () => {
  it('offers exactly the channels the club can configure', () => {
    expect(DISCORD_CHANNEL_SETTINGS.map((s) => s.key).sort()).toEqual(
      [...DISCORD_CHANNEL_KEYS].sort(),
    );
  });

  it('has something to call every one of them', () => {
    // An entry with no label renders as a blank line in the dropdown, which is
    // indistinguishable from a broken picker.
    for (const setting of DISCORD_CHANNEL_SETTINGS) {
      expect(setting.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('reachPercent', () => {
  it('is opens over the targeted audience', () => {
    expect(reachPercent(152, 214)).toBe(71);
    expect(reachPercent(0, 214)).toBe(0);
    expect(reachPercent(214, 214)).toBe(100);
  });

  it('clamps above 100', () => {
    // announcement_reads is not constrained to the audience: RLS lets any
    // member read any published post, so a reader outside the target adds to
    // the numerator and not the denominator. Uncapped this renders 104%.
    expect(reachPercent(20, 19)).toBe(100);
  });

  it('returns null rather than dividing by nobody', () => {
    expect(reachPercent(0, 0)).toBeNull();
    expect(reachPercent(3, -1)).toBeNull();
  });
});

describe('bylineName', () => {
  it('initials the given name and shouts the surname', () => {
    expect(bylineName('Alice Mercer')).toBe('A. MERCER');
    expect(bylineName('  mei  ling  tan ')).toBe('M. TAN');
  });

  it('keeps a single-word name whole', () => {
    // "A." would name nobody.
    expect(bylineName('Prince')).toBe('PRINCE');
  });

  it('has nothing to say about a missing name', () => {
    expect(bylineName(null)).toBeNull();
    expect(bylineName(undefined)).toBeNull();
    expect(bylineName('   ')).toBeNull();
  });
});

// THE OPENED FIGURES, AFTER THEY STOPPED BEING ONE COUNT QUERY PER POST.
//
// The page now pages every receipt in and buckets them here, so the property
// worth proving is that the swap changed the number of round trips and NOT a
// single figure: the same counts, exact, with a draft still absent rather than
// zero.
describe('tallyOpens', () => {
  const receipt = (id: string) => ({ announcement_id: id });

  it('counts every receipt against its own post', () => {
    const counts = tallyOpens(
      [receipt('a'), receipt('b'), receipt('a'), receipt('a'), receipt('b')],
      ['a', 'b'],
    );

    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(2);
  });

  it('gives a published post with no readers a zero', () => {
    const counts = tallyOpens([receipt('a')], ['a', 'b']);

    // Nobody has opened b, which is a real answer and a different one from
    // "b is a draft".
    expect(counts.get('b')).toBe(0);
    expect(counts.has('b')).toBe(true);
  });

  it('leaves a draft out of the map entirely', () => {
    // A receipt CAN exist against a post that is a draft today — publish it,
    // members read it, revert it — and it still must not produce a figure the
    // byline would print.
    const counts = tallyOpens([receipt('draft'), receipt('live')], ['live']);

    expect(counts.has('draft')).toBe(false);
    expect(counts.get('draft')).toBeUndefined();
    expect(counts.get('live')).toBe(1);
  });

  it('never folds an unknown post into another post’s total', () => {
    const counts = tallyOpens([receipt('a'), receipt('ghost'), receipt('a')], ['a']);

    expect([...counts.entries()]).toEqual([['a', 2]]);
  });

  it('is exact across a page boundary', () => {
    // The caller reads in windows of 1000 and concatenates; this asserts the
    // arithmetic does not care where the windows fell.
    const many = Array.from({ length: 2500 }, () => receipt('a'));
    expect(tallyOpens(many, ['a']).get('a')).toBe(2500);
  });

  it('has nothing to count when nothing is published', () => {
    expect([...tallyOpens([receipt('a')], []).entries()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Discord chip
// ---------------------------------------------------------------------------

describe('relayChip', () => {
  const NOW = Date.parse('2026-09-09T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
  const ctx = { now: NOW, channelConfigured: true, posted: null };
  const row = {
    status: 'published',
    target_audience: 'all',
    expires_at: null as string | null,
    updated_at: hoursAgo(1),
    title: 'Courts closed',
    body: 'Gym booked.',
    type: 'info',
  };

  it('says a fresh published post is queued', () => {
    expect(relayChip(row, ctx)).toBe('Queued');
  });

  it('says nothing at all about a draft', () => {
    // The DRAFT badge sits beside it. A second label saying the same thing in
    // different words is noise on every row of a list.
    expect(relayChip({ ...row, status: 'draft' }, ctx)).toBeNull();
  });

  it('calls a narrowly-addressed post website only, not failed', () => {
    // It is a decision, not a fault, and the wording has to carry that.
    expect(relayChip({ ...row, target_audience: 'competitive' }, ctx)).toBe('Website only');
  });

  it('says NOT SENT for a relayable post the lookback cannot reach', () => {
    // The row a chip reading only `relayable` would call Queued forever.
    expect(relayChip({ ...row, updated_at: hoursAgo(100) }, ctx)).toBe('Not sent');
  });

  it('distinguishes a message that is in the channel from one that needs editing', () => {
    const posted = { syncedTitle: row.title, syncedBody: row.body, syncedType: 'info' };
    expect(relayChip(row, { ...ctx, posted })).toBe('In channel');
    expect(relayChip({ ...row, title: 'Moved' }, { ...ctx, posted })).toBe('Edit due');
  });

  it('warns that a narrowed post already in the channel is coming down', () => {
    const posted = { syncedTitle: row.title, syncedBody: row.body, syncedType: 'info' };
    expect(relayChip({ ...row, target_audience: 'competitive' }, { ...ctx, posted })).toBe(
      'Coming down',
    );
  });

  it('says nothing when no channel is configured', () => {
    // "We could not find out" and "it is not in Discord" must not read the same.
    expect(relayChip(row, { ...ctx, channelConfigured: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which composers the one left-hand card offers
// ---------------------------------------------------------------------------
//
// `announcements.create.write` and `announcements.discord.write` are separate
// keys reaching separate audiences, so all four combinations are reachable. This
// is the only place the choice is made — the card calls showsModeSelector rather
// than counting the modes itself, so what is asserted here is the rule and not a
// copy of it.
describe('composerModes', () => {
  it('offers both, website first, when both keys are held', () => {
    const modes = composerModes({ canCreate: true, canSendDiscord: true });

    expect(modes).toEqual(['website', 'discord']);
    // The default mode is the website post: it is the audience every member is
    // in, and a Discord message cannot be taken back.
    expect(modes[0]).toBe('website');
    expect(showsModeSelector(modes)).toBe(true);
  });

  it('offers only the website composer, with no strip, for create alone', () => {
    const modes = composerModes({ canCreate: true, canSendDiscord: false });

    expect(modes).toEqual(['website']);
    // A lone pill the viewer cannot navigate away from is noise, so the card
    // draws the composer exactly as it did before.
    expect(showsModeSelector(modes)).toBe(false);
  });

  it('offers only the Discord composer, with no strip, for discord alone', () => {
    // THE CASE WHOSE RENDERING CHANGES. This viewer used to be told writing was
    // not part of their access in the left column while a working Discord
    // composer sat in the right one. Now the left card IS the Discord composer
    // and there is no refusal, because the refusal means "neither composer".
    const modes = composerModes({ canCreate: false, canSendDiscord: true });

    expect(modes).toEqual(['discord']);
    expect(showsModeSelector(modes)).toBe(false);
  });

  it('offers nothing when neither key is held', () => {
    const modes = composerModes({ canCreate: false, canSendDiscord: false });

    // Empty is what makes the page draw the withheld message.
    expect(modes).toEqual([]);
    expect(showsModeSelector(modes)).toBe(false);
  });

  it('keeps the order stable regardless of how the capabilities are given', () => {
    // The tab strip's left-to-right order is this array's order, so it must not
    // depend on the shape of the object handed in.
    expect(composerModes({ canSendDiscord: true, canCreate: true })).toEqual([
      'website',
      'discord',
    ]);
  });
});
