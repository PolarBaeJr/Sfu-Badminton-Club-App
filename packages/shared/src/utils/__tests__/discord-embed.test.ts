import { describe, it, expect } from 'vitest';
import {
  ANNOUNCEMENT_EMBED_COLORS,
  ANNOUNCEMENT_EMBED_COLOR_DEFAULT,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_LOOKBACK_HOURS,
  EMBED_TITLE_MAX,
  announcementEmbed,
  announcementRelayVerdict,
  announcementRelayState,
  embedColorHex,
} from '../discord-embed';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const base = {
  status: 'published',
  target_audience: 'all',
  expires_at: null as string | null,
  updated_at: hoursAgo(1),
  title: 'Courts closed Friday',
  body: 'Gym is booked for convocation.',
  type: 'info',
};

// ---- THE TRIPWIRE --------------------------------------------------------
//
// The other half of this lives in apps/bot/src/__tests__/announcements.test.ts
// and pins the SAME four literals against the bot's own COLORS map. Both halves
// are needed: apps/bot has no dependency on this package (zero production deps,
// deliberately), so nothing at build time can notice the two drifting apart. A
// test on only one side catches a change to that side.
describe('the colours the bot posts', () => {
  it('pins the four literals apps/bot/src/announcements.ts also pins', () => {
    expect(ANNOUNCEMENT_EMBED_COLORS).toEqual({
      info: 0x3498db,
      warning: 0xf1c40f,
      urgent: 0xe74c3c,
      event: 0x2ecc71,
    });
    expect(ANNOUNCEMENT_EMBED_COLOR_DEFAULT).toBe(0x95a5a6);
  });

  it('renders one as CSS', () => {
    expect(embedColorHex(0x3498db)).toBe('#3498db');
    // The pad matters: a colour with a low leading byte would otherwise come
    // out five characters long and render as nothing.
    expect(embedColorHex(0x0abcde)).toBe('#0abcde');
  });
});

describe('the embed itself', () => {
  it('builds what embedFor builds', () => {
    expect(announcementEmbed({ title: 'Hi', body: 'There', type: 'urgent', url: 'https://x' }))
      .toEqual({ title: 'Hi', description: 'There', color: 0xe74c3c, url: 'https://x' });
  });

  it('leaves the description off entirely for an empty body', () => {
    // Not '', which Discord rejects as an empty field. An announcement is
    // allowed a title and no body (00001: body DEFAULT '').
    const embed = announcementEmbed({ title: 'Hi', body: '', type: 'info' });
    expect(embed.description).toBeUndefined();
    expect('url' in embed).toBe(false);
  });

  it('falls back to grey for a type nothing maps', () => {
    expect(announcementEmbed({ title: 'x', body: 'y', type: 'invented' }).color).toBe(
      ANNOUNCEMENT_EMBED_COLOR_DEFAULT
    );
  });

  it('trims to the tighter of the two caps', () => {
    const embed = announcementEmbed({ title: 'T'.repeat(400), body: 'B'.repeat(9000), type: 'info' });
    expect(embed.title).toHaveLength(EMBED_TITLE_MAX);
    // 4000, not Discord's 4096: the relay route cuts first, so the bot's
    // 4096 slice never has anything to do.
    expect(embed.description).toHaveLength(ANNOUNCEMENT_BODY_MAX);
  });
});

describe('whether it is relayed at all', () => {
  it('relays a published announcement addressed to everyone', () => {
    expect(announcementRelayVerdict(base, NOW)).toEqual({ relayable: true, reason: null });
  });

  it('names a narrow audience rather than dropping it in silence', () => {
    expect(announcementRelayVerdict({ ...base, target_audience: 'competitive' }, NOW)).toEqual({
      relayable: false,
      reason: 'narrow_audience',
    });
  });

  it('names an expiry that has passed', () => {
    expect(announcementRelayVerdict({ ...base, expires_at: hoursAgo(1) }, NOW)).toEqual({
      relayable: false,
      reason: 'expired',
    });
  });

  it('treats an expiry still ahead as no expiry', () => {
    expect(announcementRelayVerdict({ ...base, expires_at: hoursAgo(-1) }, NOW).relayable).toBe(true);
  });

  it('gives a draft no reason, because nobody is surprised by it', () => {
    expect(announcementRelayVerdict({ ...base, status: 'draft' }, NOW)).toEqual({
      relayable: false,
      reason: null,
    });
  });
});

describe('what the next tick will actually do', () => {
  const ctx = { now: NOW, channelConfigured: true, posted: null };

  it('posts a fresh one', () => {
    expect(announcementRelayState(base, ctx).state).toBe('posts');
  });

  it('says nothing will happen to a relayable one the lookback cannot reach', () => {
    // THE CASE A NAIVE PREVIEW LIES ABOUT. Published, addressed to everyone,
    // not expired — and untouched for five days, so the fresh read never sees
    // it and it will never be posted. "Relayable" is not "will appear".
    expect(
      announcementRelayState({ ...base, updated_at: hoursAgo(ANNOUNCEMENT_LOOKBACK_HOURS + 1) }, ctx)
        .state
    ).toBe('too_old');
  });

  it('edits a mapped one whose text moved', () => {
    const posted = { syncedTitle: 'Old', syncedBody: base.body, syncedType: 'info' };
    expect(announcementRelayState(base, { ...ctx, posted }).state).toBe('edits');
  });

  it('leaves a mapped one alone when nothing moved', () => {
    const posted = { syncedTitle: base.title, syncedBody: base.body, syncedType: 'info' };
    expect(announcementRelayState(base, { ...ctx, posted }).state).toBe('in_sync');
  });

  it('compares the TRIMMED body, so a long one is not permanently out of step', () => {
    // The mapping stores what was sent, which is the trimmed body. Comparing
    // against the untrimmed one would report an edit on every single tick.
    const long = { ...base, body: 'B'.repeat(9000) };
    const posted = {
      syncedTitle: base.title,
      syncedBody: 'B'.repeat(ANNOUNCEMENT_BODY_MAX),
      syncedType: 'info',
    };
    expect(announcementRelayState(long, { ...ctx, posted }).state).toBe('in_sync');
  });

  it('edits a mapped one however old it is', () => {
    // The mapped set is read with no time bound. Only a FIRST post is
    // time-limited, which is why too_old and edits can disagree about the
    // same announcement.
    const posted = { syncedTitle: 'Old', syncedBody: base.body, syncedType: 'info' };
    const old = { ...base, updated_at: hoursAgo(1000) };
    expect(announcementRelayState(old, { ...ctx, posted }).state).toBe('edits');
  });

  it('retracts a mapped one that stopped being relayable', () => {
    const posted = { syncedTitle: base.title, syncedBody: base.body, syncedType: 'info' };
    const narrowed = { ...base, target_audience: 'competitive' };
    expect(announcementRelayState(narrowed, { ...ctx, posted })).toEqual({
      state: 'retracts',
      reason: 'narrow_audience',
    });
  });

  it('says a draft simply stays off', () => {
    expect(announcementRelayState({ ...base, status: 'draft' }, ctx)).toEqual({
      state: 'stays_off',
      reason: null,
    });
  });

  it('names a missing channel instead of promising a post', () => {
    expect(announcementRelayState(base, { ...ctx, channelConfigured: false }).state).toBe(
      'no_channel'
    );
  });

  it('still edits a mapped one after the channel setting is cleared', () => {
    // The relay keeps mapped messages reachable when the setting goes away, or
    // a club turning the relay off would strand everything it had posted.
    const posted = { syncedTitle: 'Old', syncedBody: base.body, syncedType: 'info' };
    expect(
      announcementRelayState(base, { ...ctx, channelConfigured: false, posted }).state
    ).toBe('edits');
  });
});
