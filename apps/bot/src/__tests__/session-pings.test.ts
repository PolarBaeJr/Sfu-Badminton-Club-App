import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ordering property is the point of this file: POST FIRST, RECORD SECOND.
// The app's own reminder job claims before it sends, so a throw in between is a
// silent permanent drop. Here a failure means a retry, never a swallowed ping.

const fetchDuePings = vi.fn();
const recordPing = vi.fn();
const createMessage = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchDuePings,
  recordPing,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    createMessage = createMessage;
  },
}));

const PING = {
  sessionId: 's1',
  roleId: '900',
  channelId: 'c1',
  name: 'Competitive Practice',
  startsAt: '2026-09-15T02:30:00.000Z',
  location: 'West Gym',
  label: 'Competitive nights',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: { g1: {} }, auditChannelId: null });
  fetchDuePings.mockResolvedValue({ pings: [PING] });
  createMessage.mockResolvedValue(true);
  recordPing.mockResolvedValue({ ok: true });
});

describe('session pings', () => {
  it('posts, then records — never the other way round', async () => {
    const order: string[] = [];
    createMessage.mockImplementation(async () => {
      order.push('post');
      return true;
    });
    recordPing.mockImplementation(async () => {
      order.push('record');
      return { ok: true };
    });

    const { runSessionPings } = await import('../session-pings.js');
    await runSessionPings();

    expect(order).toEqual(['post', 'record']);
  });

  it('does NOT record a ping that failed to post, so it retries next tick', async () => {
    createMessage.mockResolvedValue(false);
    const { runSessionPings } = await import('../session-pings.js');
    const result = await runSessionPings();

    expect(recordPing).not.toHaveBeenCalled();
    expect(result).toMatchObject({ posted: 0, failed: 1 });
  });

  it('allows the role mention, or the ping notifies nobody', async () => {
    // Without allowed_mentions Discord renders <@&id> as plain text. The
    // message arrives, looks correct, and pings no one — a failure that is
    // invisible in the channel and in the logs alike.
    const { runSessionPings } = await import('../session-pings.js');
    await runSessionPings();

    const [, payload] = createMessage.mock.calls[0] as [string, { allowed_mentions: { roles: string[] } }];
    expect(payload.allowed_mentions.roles).toEqual(['900']);
  });

  it('mentions the role and uses a reader-local timestamp', async () => {
    const { runSessionPings } = await import('../session-pings.js');
    await runSessionPings();

    const [channelId, payload] = createMessage.mock.calls[0] as [string, { content: string }];
    expect(channelId).toBe('c1');
    expect(payload.content).toContain('<@&900>');
    expect(payload.content).toContain('Competitive Practice');
    // <t:unix:R> — rendered in each reader's own timezone by Discord.
    expect(payload.content).toMatch(/<t:\d+:R>/);
  });

  it('counts a posted-but-unrecorded ping as posted, not lost', async () => {
    recordPing.mockRejectedValue(new Error('app down'));
    const { runSessionPings } = await import('../session-pings.js');
    const result = await runSessionPings();

    expect(createMessage).toHaveBeenCalled();
    expect(result.posted).toBe(1);
  });

  it('carries on to the next guild when one fails', async () => {
    loadConfig.mockResolvedValue({ registry: { g1: {}, g2: {} }, auditChannelId: null });
    fetchDuePings
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce({ pings: [PING] });

    const { runSessionPings } = await import('../session-pings.js');
    const result = await runSessionPings();

    expect(result.posted).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('does nothing without a bot token rather than throwing', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const { runSessionPings } = await import('../session-pings.js');
    await expect(runSessionPings()).resolves.toMatchObject({ posted: 0 });
    expect(createMessage).not.toHaveBeenCalled();
  });
});
