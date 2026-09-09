import { describe, it, expect, vi, beforeEach } from 'vitest';

// The console's half of /say (00222). Four properties:
//
//  1. POST FIRST, RECORD SECOND — a crash between them is a duplicate somebody
//     mentions, not a club message that silently never went out.
//  2. THE DEFAULT IS SILENCE. A message with ping off must reach Discord with
//     an empty allowed_mentions.parse, so an @everyone typed into the text
//     reads as a mention and buzzes nobody.
//  3. A REFUSAL IS RECORDED, not swallowed. The reason is the only thing that
//     will get a missing permission fixed.
//  4. A FAILURE IN ONE MESSAGE DOES NOT ABORT THE REST.

const claimOutboxMessages = vi.fn();
const recordOutboxResult = vi.fn();
const postMessage = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  claimOutboxMessages,
  recordOutboxResult,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    postMessage = postMessage;
  },
}));

const MESSAGE = {
  id: 'o1',
  channelId: 'c1',
  content: 'Doors open at seven tonight.',
  embed: null,
  ping: false,
  attempts: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: new Map([['g1', {}]]), auditChannelId: null });
  claimOutboxMessages.mockResolvedValue({ messages: [MESSAGE] });
  postMessage.mockResolvedValue('m1');
  recordOutboxResult.mockResolvedValue({ ok: true });
});

describe('runOutbox', () => {
  it('posts, then records the message id Discord gave back', async () => {
    const { runOutbox } = await import('../outbox.js');
    const result = await runOutbox();

    expect(postMessage).toHaveBeenCalledWith('c1', expect.objectContaining({ content: MESSAGE.content }));
    expect(recordOutboxResult).toHaveBeenCalledWith({ id: 'o1', discordMessageId: 'm1' });
    expect(result).toEqual({ sent: 1, failed: 0 });

    // The order is the whole property: a record before the post would mark a
    // message sent that nobody ever saw.
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      recordOutboxResult.mock.invocationCallOrder[0] as number,
    );
  });

  it('MENTIONS NOBODY unless the sender asked', async () => {
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();
    expect((postMessage.mock.calls[0]?.[1] as { allowed_mentions: { parse: string[] } })
      .allowed_mentions.parse).toEqual([]);

    postMessage.mockClear();
    claimOutboxMessages.mockResolvedValue({ messages: [{ ...MESSAGE, ping: true }] });
    await runOutbox();
    expect((postMessage.mock.calls[0]?.[1] as { allowed_mentions: { parse: string[] } })
      .allowed_mentions.parse).toEqual(['users', 'roles', 'everyone']);
  });

  it('sends an embed with no content field at all', async () => {
    // Belt and braces with allowed_mentions: with no content, there is nothing
    // for Discord to parse a mention out of in the first place.
    claimOutboxMessages.mockResolvedValue({
      messages: [
        {
          ...MESSAGE,
          content: null,
          embed: { title: 'Courts closed', body: 'Gym booked.', type: 'urgent' },
        },
      ],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    const payload = postMessage.mock.calls[0]?.[1] as {
      content?: string;
      embeds: { title: string; color: number }[];
    };
    expect(payload.content).toBeUndefined();
    expect(payload.embeds[0]?.title).toBe('Courts closed');
    // The same literal the shared module and the announcement relay pin.
    expect(payload.embeds[0]?.color).toBe(0xe74c3c);
  });

  it('records a refusal with a reason rather than dropping it', async () => {
    postMessage.mockResolvedValue(null);
    const { runOutbox } = await import('../outbox.js');
    const result = await runOutbox();

    expect(result).toEqual({ sent: 0, failed: 1 });
    const [call] = recordOutboxResult.mock.calls as [[{ id: string; error: string }]];
    expect(call[0].id).toBe('o1');
    // Names the channel as the thing to check — the reason a person can act on.
    expect(call[0].error).toMatch(/channel/i);
    // NEVER recorded as sent.
    expect(call[0]).not.toHaveProperty('discordMessageId');
  });

  it('carries on with the rest when one message is refused', async () => {
    claimOutboxMessages.mockResolvedValue({
      messages: [MESSAGE, { ...MESSAGE, id: 'o2' }],
    });
    postMessage.mockResolvedValueOnce(null).mockResolvedValueOnce('m2');

    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 1 });
  });

  it('does not abort a guild because the claim failed', async () => {
    claimOutboxMessages.mockRejectedValue(new Error('503'));
    const { runOutbox } = await import('../outbox.js');
    // Counted, not thrown: a claim that never happened costs nothing, and the
    // rows are still pending for the next tick.
    expect(await runOutbox()).toEqual({ sent: 0, failed: 1 });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts nothing at all without a token', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(claimOutboxMessages).not.toHaveBeenCalled();
  });
});
