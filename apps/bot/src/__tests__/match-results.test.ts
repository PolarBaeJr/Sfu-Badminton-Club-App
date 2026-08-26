import { describe, it, expect, vi, beforeEach } from 'vitest';

// Four properties this file pins down:
//
//  1. POST FIRST, RECORD SECOND. A crash between the two is a duplicate
//     somebody notices, not a result that silently never went out.
//  2. RETRACT DELETES BEFORE IT CLEARS. The other way round strands the message
//     with nothing pointing at it, and nothing ever takes it down.
//  3. A 404 ON EDIT IS RECORDED, NOT RETRIED. Otherwise the relay PATCHes a
//     dead message id every ten minutes until the match ages out.
//  4. NO RATING IS EVER RENDERED. The route does not send one, and this side
//     must not invent one from win_flag or anything else.

const fetchMatchResultActions = vi.fn();
const recordMatchPost = vi.fn();
const clearMatchPost = vi.fn();
const postMessage = vi.fn();
const editMessage = vi.fn();
const deleteMessage = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchMatchResultActions,
  recordMatchPost,
  clearMatchPost,
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
  matchId: 'm1',
  channelId: 'c1',
  discordMessageId: null,
  summary: 'Alice Nguyen def. Bao Tran — 21-18, 21-15',
  teamA: 'Alice Nguyen',
  teamB: 'Bao Tran',
  score: '21-18, 21-15',
  winner: 'a' as const,
  matchType: 'singles',
  playedAt: '2026-08-24T02:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: { g1: {} }, auditChannelId: null });
  fetchMatchResultActions.mockResolvedValue({ actions: [POST_ACTION], skipped: [] });
  postMessage.mockResolvedValue('msg-1');
  editMessage.mockResolvedValue('ok');
  deleteMessage.mockResolvedValue(true);
  recordMatchPost.mockResolvedValue({ ok: true });
  clearMatchPost.mockResolvedValue({ ok: true });
});

async function run() {
  const { runMatchResults } = await import('../match-results.js');
  return runMatchResults();
}

describe('runMatchResults', () => {
  it('posts a result and records it afterwards', async () => {
    const result = await run();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(recordMatchPost).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'm1', discordMessageId: 'msg-1', guildId: 'g1' })
    );
    expect(result.posted).toBe(1);
  });

  it('records the summary the route sent, so the next tick sees no diff', async () => {
    await run();
    const [input] = recordMatchPost.mock.calls[0] as [{ summary: string }];

    expect(input.summary).toBe(POST_ACTION.summary);
  });

  it('does NOT record a post Discord refused', async () => {
    // An unrecorded failure stays due and retries; a recorded one is a result
    // the relay believes it published and never will.
    postMessage.mockResolvedValue(null);
    const result = await run();

    expect(recordMatchPost).not.toHaveBeenCalled();
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('mentions nobody', async () => {
    // A relay that could @everyone the server on every confirmed match is one
    // bad afternoon away from the channel being muted.
    await run();
    const [, payload] = postMessage.mock.calls[0] as [
      string,
      { content?: string; allowed_mentions: { parse: string[] } },
    ];

    // No content field at all, so nothing can be parsed out of it in the first
    // place; allowed_mentions is the second layer.
    expect(payload.content).toBeUndefined();
    expect(payload.allowed_mentions.parse).toEqual([]);
  });

  it('renders no rating anywhere in the message', async () => {
    // The route never sends one. This asserts the bot does not derive one.
    await run();
    const [, payload] = postMessage.mock.calls[0] as [string, unknown];

    expect(JSON.stringify(payload)).not.toMatch(/rating|elo|[+-]\d+\s*(pts|points)/i);
  });

  it('names both players on each side of a doubles result', async () => {
    fetchMatchResultActions.mockResolvedValue({
      actions: [
        {
          ...POST_ACTION,
          matchType: 'doubles',
          teamA: 'Alice Nguyen & Bao Tran',
          teamB: 'Cam Diaz & Dev Rao',
        },
      ],
      skipped: [],
    });
    await run();
    const [, payload] = postMessage.mock.calls[0] as [
      string,
      { embeds: { title: string; description: string }[] },
    ];

    expect(payload.embeds[0]?.title).toContain('Doubles');
    expect(payload.embeds[0]?.description).toContain('Alice Nguyen & Bao Tran');
    expect(payload.embeds[0]?.description).toContain('Cam Diaz & Dev Rao');
  });

  it('puts the loser second even when side b won', async () => {
    fetchMatchResultActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, winner: 'b' as const }],
      skipped: [],
    });
    await run();
    const [, payload] = postMessage.mock.calls[0] as [
      string,
      { embeds: { description: string }[] },
    ];

    expect(payload.embeds[0]?.description).toBe('**Bao Tran** def. Alice Nguyen');
  });

  it('deletes before it clears, on a retract', async () => {
    const order: string[] = [];
    deleteMessage.mockImplementation(() => {
      order.push('delete');
      return Promise.resolve(true);
    });
    clearMatchPost.mockImplementation(() => {
      order.push('clear');
      return Promise.resolve({ ok: true });
    });
    fetchMatchResultActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'retract' as const, discordMessageId: 'msg-1' }],
      skipped: [],
    });

    const result = await run();
    expect(order).toEqual(['delete', 'clear']);
    expect(result.retracted).toBe(1);
  });

  it('does not clear the mapping when the delete failed', async () => {
    // Clearing anyway would strand a live message with nothing pointing at it.
    deleteMessage.mockResolvedValue(false);
    fetchMatchResultActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'retract' as const, discordMessageId: 'msg-1' }],
      skipped: [],
    });

    const result = await run();
    expect(clearMatchPost).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('records an edit aimed at a hand-deleted message rather than retrying it', async () => {
    editMessage.mockResolvedValue('gone');
    fetchMatchResultActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'edit' as const, discordMessageId: 'msg-1' }],
      skipped: [],
    });

    const result = await run();
    expect(recordMatchPost).toHaveBeenCalledWith(
      expect.objectContaining({ discordMessageId: 'msg-1' })
    );
    expect(result.stale).toBe(1);
    expect(result.edited).toBe(0);
  });

  it('does not record an edit Discord rejected for any other reason', async () => {
    editMessage.mockResolvedValue('failed');
    fetchMatchResultActions.mockResolvedValue({
      actions: [{ ...POST_ACTION, kind: 'edit' as const, discordMessageId: 'msg-1' }],
      skipped: [],
    });

    const result = await run();
    expect(recordMatchPost).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it("logs why a match was held back rather than counting it silently", async () => {
    // Most skips here are DECISIONS, not faults, and "we played and it never
    // appeared" has to have an answer.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMatchResultActions.mockResolvedValue({
      actions: [],
      skipped: [{ matchId: 'm9', reason: 'a participant is hidden from public ranking' }],
    });

    const result = await run();
    expect(result.skipped).toBe(1);
    expect(log.mock.calls.flat().join(' ')).toContain('hidden from public ranking');
    log.mockRestore();
  });

  it("one guild's failure does not abort the others", async () => {
    loadConfig.mockResolvedValue({ registry: { g1: {}, g2: {} }, auditChannelId: null });
    fetchMatchResultActions
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ actions: [POST_ACTION], skipped: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await run();
    expect(result.posted).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('does nothing at all without a bot token', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await run();
    expect(postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      posted: 0,
      edited: 0,
      retracted: 0,
      stale: 0,
      failed: 0,
      skipped: 0,
    });
  });
});
