import { describe, it, expect, vi, beforeEach } from 'vitest';

// Three properties this file pins down:
//
//  1. POST FIRST, RECORD SECOND. A crash between the two is a duplicate
//     somebody notices, not a club notice that silently never went out.
//  2. RETRACT DELETES BEFORE IT CLEARS. The other way round strands the
//     message with nothing pointing at it, and nothing ever takes it down.
//  3. NOBODY IS MENTIONED. A relay that could @everyone the server on every
//     publish is one bad afternoon away from the channel being muted.

const fetchAnnouncementActions = vi.fn();
const recordAnnouncementPost = vi.fn();
const clearAnnouncementPost = vi.fn();
const postMessage = vi.fn();
const editMessage = vi.fn();
const deleteMessage = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchAnnouncementActions,
  recordAnnouncementPost,
  clearAnnouncementPost,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    postMessage = postMessage;
    editMessage = editMessage;
    deleteMessage = deleteMessage;
  },
}));

const POST_ACTION = {
  kind: 'post' as const,
  announcementId: 'a1',
  channelId: 'c1',
  discordMessageId: null,
  title: 'Courts closed Friday',
  body: 'Gym maintenance. No session.',
  type: 'warning',
  url: 'https://example.test/announcements',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: { g1: {} }, auditChannelId: null });
  fetchAnnouncementActions.mockResolvedValue({ actions: [POST_ACTION], skipped: [] });
  postMessage.mockResolvedValue('m1');
  editMessage.mockResolvedValue('ok');
  deleteMessage.mockResolvedValue(true);
  recordAnnouncementPost.mockResolvedValue({ ok: true });
  clearAnnouncementPost.mockResolvedValue({ ok: true });
});

describe('runAnnouncements', () => {
  it('posts, then records the message id Discord gave back', async () => {
    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(postMessage).toHaveBeenCalledWith('c1', expect.anything());
    expect(recordAnnouncementPost).toHaveBeenCalledWith(
      expect.objectContaining({ announcementId: 'a1', guildId: 'g1', discordMessageId: 'm1' })
    );
    expect(result.posted).toBe(1);
  });

  it('does NOT record a post Discord refused', async () => {
    // An unrecorded failure stays due and is retried, which is what makes a bot
    // restart a delay rather than a dropped club notice. Recording it would
    // mark an announcement relayed that nobody ever saw.
    postMessage.mockResolvedValue(null);

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(recordAnnouncementPost).not.toHaveBeenCalled();
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('MENTIONS NOBODY', async () => {
    const { runAnnouncements } = await import('../announcements.js');
    await runAnnouncements();

    const payload = postMessage.mock.calls[0]?.[1] as {
      content?: string;
      allowed_mentions: { parse: string[] };
      embeds: { title: string; description?: string; color: number }[];
    };

    // No content field at all, so there is nothing for Discord to parse a
    // mention out of even before allowed_mentions is considered.
    expect(payload.content).toBeUndefined();
    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.embeds[0]?.title).toBe('Courts closed Friday');
  });

  it('colours the embed by announcement type', async () => {
    const { runAnnouncements } = await import('../announcements.js');
    await runAnnouncements();
    const warning = (postMessage.mock.calls[0]?.[1] as { embeds: { color: number }[] }).embeds[0]
      ?.color;

    postMessage.mockClear();
    fetchAnnouncementActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, type: 'urgent' }],
      skipped: [],
    });
    await runAnnouncements();
    const urgent = (postMessage.mock.calls[0]?.[1] as { embeds: { color: number }[] }).embeds[0]
      ?.color;

    // Different, because an exec who escalates a notice expects it to look
    // escalated — the reason the mapping remembers the type at all.
    expect(warning).not.toBe(urgent);
  });

  it('edits through PATCH rather than posting a second copy', async () => {
    fetchAnnouncementActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'edit', discordMessageId: 'm1' }],
      skipped: [],
    });

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(postMessage).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith('c1', 'm1', expect.anything());
    expect(result.edited).toBe(1);
  });

  it('RECORDS an edit whose message is gone, rather than retrying it forever', async () => {
    // The loop this prevents: somebody deletes the relayed message by hand, the
    // author then corrects the announcement on the website, and every tick after
    // that PATCHes a dead id. Unlike a post — which falls out of the 72-hour
    // lookback and stops being due — the mapping read has no time bound, so for
    // an announcement with no expiry the retry never ends.
    //
    // Recording the new values settles the diff. Nothing is reposted, which is
    // the documented policy for a hand-deleted relay.
    editMessage.mockResolvedValue('gone');
    fetchAnnouncementActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'edit', discordMessageId: 'm1' }],
      skipped: [],
    });

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(recordAnnouncementPost).toHaveBeenCalledWith(
      expect.objectContaining({ announcementId: 'a1', discordMessageId: 'm1' })
    );
    expect(postMessage).not.toHaveBeenCalled();
    // Counted apart from a real edit: nobody saw this one change.
    expect(result).toMatchObject({ stale: 1, edited: 0, failed: 0 });
  });

  it('does NOT record an edit Discord merely refused', async () => {
    // The other half of the pair above. A 403 or a 500 is worth retrying and a
    // 404 is not, so recording both would abandon changes that would have
    // landed on the next tick.
    editMessage.mockResolvedValue('failed');
    fetchAnnouncementActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'edit', discordMessageId: 'm1' }],
      skipped: [],
    });

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(recordAnnouncementPost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, stale: 0, edited: 0 });
  });

  it('DELETES BEFORE IT CLEARS, on a retract', async () => {
    const order: string[] = [];
    deleteMessage.mockImplementation(async () => {
      order.push('discord');
      return true;
    });
    clearAnnouncementPost.mockImplementation(async () => {
      order.push('app');
      return { ok: true };
    });
    fetchAnnouncementActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'retract', discordMessageId: 'm1' }],
      skipped: [],
    });

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(order).toEqual(['discord', 'app']);
    expect(result.retracted).toBe(1);
  });

  it('leaves the mapping alone when the delete fails', async () => {
    // Clearing it anyway would strand the message: nothing left pointing at it,
    // and no tick that could ever try again.
    deleteMessage.mockResolvedValue(false);
    fetchAnnouncementActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'retract', discordMessageId: 'm1' }],
      skipped: [],
    });

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(clearAnnouncementPost).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it("does not let one guild's failure abort the others", async () => {
    loadConfig.mockResolvedValue({ registry: { g1: {}, g2: {} }, auditChannelId: null });
    fetchAnnouncementActions
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ actions: [POST_ACTION], skipped: [] });

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(result.failed).toBe(1);
    expect(result.posted).toBe(1);
  });

  it('does nothing at all without a bot token', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const { runAnnouncements } = await import('../announcements.js');
    const result = await runAnnouncements();

    expect(postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: 0, edited: 0, retracted: 0, stale: 0, failed: 0, skipped: 0 });
  });
});
