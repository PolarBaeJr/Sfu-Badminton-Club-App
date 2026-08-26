import { describe, it, expect, vi, beforeEach } from 'vitest';

// The relay side of /bug, /feedback and the tournament survey. What this pins:
//
//  1. POST FIRST, RECORD SECOND. A crash between the two is a duplicate
//     somebody notices, not a report that silently never went out.
//  2. RETRACT DELETES BEFORE IT CLEARS. The other way round strands the message
//     with nothing pointing at it, and nothing ever takes it down.
//  3. A 404 ON EDIT IS RECORDED, NOT RETRIED. Otherwise the relay PATCHes a
//     dead message id every ten minutes until the row ages out.
//  4. A SCREENSHOT NEVER HOLDS THE WORDS BACK. Its url expires in about a day;
//     a report that outlived it still has to reach the channel.
//  5. THE BOT ONLY FETCHES FROM DISCORD'S CDN. Anything else is an SSRF with a
//     readback channel: whoever holds the service secret could make the bot GET
//     an address inside the Pi's network and mirror the answer into Discord.

const fetchFeedbackActions = vi.fn();
const recordFeedbackPost = vi.fn();
const clearFeedbackPost = vi.fn();
const postMessageWithFile = vi.fn();
const editMessage = vi.fn();
const deleteMessage = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchFeedbackActions,
  recordFeedbackPost,
  clearFeedbackPost,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    postMessageWithFile = postMessageWithFile;
    editMessage = editMessage;
    deleteMessage = deleteMessage;
  },
}));

const REPORT = {
  kind: 'post' as const,
  source: 'report' as const,
  sourceId: 'r1',
  channelId: 'c-exec',
  discordMessageId: null,
  summary: 'Ladder spins\nIt never loads',
  title: 'Ladder spins',
  body: 'It never loads',
  author: 'Alice Nguyen (<@123>)',
  context: 'Bug report',
  rating: null,
  imageUrl: null,
  createdAt: '2026-08-26T02:00:00.000Z',
};

const SURVEY = {
  ...REPORT,
  source: 'event_feedback' as const,
  sourceId: 'f1',
  channelId: 'c-survey',
  summary: '4|Great draw, long waits',
  title: 'Summer Open',
  body: 'Great draw, long waits',
  author: 'Bao Tran',
  context: 'Summer Open',
  rating: 4,
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: { g1: {} }, auditChannelId: null });
  fetchFeedbackActions.mockResolvedValue({ actions: [REPORT], skipped: [] });
  postMessageWithFile.mockResolvedValue('msg-1');
  editMessage.mockResolvedValue('ok');
  deleteMessage.mockResolvedValue(true);
  recordFeedbackPost.mockResolvedValue({ ok: true });
  clearFeedbackPost.mockResolvedValue({ ok: true });
});

async function run() {
  const { runFeedback } = await import('../feedback.js');
  return runFeedback();
}

describe('posting', () => {
  it('posts to the channel the route chose, and records only after Discord accepts', async () => {
    // The channel comes from the ACTION, never from this file: reports and
    // survey responses go to separately configured channels, and deciding it
    // here would be one place for the two to be conflated.
    const result = await run();

    expect(postMessageWithFile).toHaveBeenCalledWith('c-exec', expect.anything(), null);
    expect(recordFeedbackPost).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'report', sourceId: 'r1', discordMessageId: 'msg-1' })
    );
    expect(result.posted).toBe(1);
  });

  it('does not record a post Discord refused', async () => {
    // Recording it would mean a report the relay believes it published and
    // never will. Left unrecorded it retries on the next tick.
    postMessageWithFile.mockResolvedValue(null);
    const result = await run();

    expect(recordFeedbackPost).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('renders the rating for a survey response and never invents one for a report', async () => {
    fetchFeedbackActions.mockResolvedValue({ actions: [SURVEY, REPORT], skipped: [] });
    await run();

    const [surveyPayload] = postMessageWithFile.mock.calls[0]!.slice(1) as [
      { embeds: { fields?: { name: string; value: string }[] }[] },
    ];
    const [reportPayload] = postMessageWithFile.mock.calls[1]!.slice(1) as [
      { embeds: { fields?: { name: string; value: string }[] }[] },
    ];

    expect(surveyPayload.embeds[0]?.fields?.find((f) => f.name === 'Rating')?.value).toContain(
      '4/5'
    );
    expect(reportPayload.embeds[0]?.fields?.find((f) => f.name === 'Rating')).toBeUndefined();
  });

  it('parses no mentions out of what it posts', async () => {
    // `author` is rendered as <@id> so an exec can click through. Without this
    // every relayed report would notify its reporter about a room they cannot
    // see — turning a quiet complaint into a ping.
    await run();
    const [payload] = postMessageWithFile.mock.calls[0]!.slice(1) as [
      { allowed_mentions: { parse: string[] }; content?: unknown },
    ];

    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.content).toBeUndefined();
  });
});

describe('editing and retracting', () => {
  it('deletes before it clears the mapping', async () => {
    const order: string[] = [];
    deleteMessage.mockImplementation(async () => {
      order.push('delete');
      return true;
    });
    clearFeedbackPost.mockImplementation(async () => {
      order.push('clear');
      return { ok: true };
    });
    fetchFeedbackActions.mockResolvedValue({
      actions: [{ ...SURVEY, kind: 'retract', discordMessageId: 'msg-9' }],
      skipped: [],
    });

    const result = await run();

    expect(order).toEqual(['delete', 'clear']);
    expect(result.retracted).toBe(1);
  });

  it('leaves the mapping alone when the delete failed', async () => {
    // Clearing it would strand a live message with nothing pointing at it.
    deleteMessage.mockResolvedValue(false);
    fetchFeedbackActions.mockResolvedValue({
      actions: [{ ...SURVEY, kind: 'retract', discordMessageId: 'msg-9' }],
      skipped: [],
    });

    const result = await run();

    expect(clearFeedbackPost).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('records an edit aimed at a message somebody deleted by hand', async () => {
    // A PATCH cannot resurrect it. Unrecorded, the identical diff is re-sent
    // every tick until the row ages out.
    editMessage.mockResolvedValue('gone');
    fetchFeedbackActions.mockResolvedValue({
      actions: [{ ...SURVEY, kind: 'edit', discordMessageId: 'msg-9' }],
      skipped: [],
    });

    const result = await run();

    expect(recordFeedbackPost).toHaveBeenCalledWith(
      expect.objectContaining({ discordMessageId: 'msg-9' })
    );
    expect(result.stale).toBe(1);
    expect(result.edited).toBe(0);
  });

  it('never fetches a screenshot on an edit', async () => {
    // An edit cannot change attachments without re-uploading everything it
    // keeps, and the only editable source has no image in the first place.
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    fetchFeedbackActions.mockResolvedValue({
      actions: [
        { ...REPORT, kind: 'edit', discordMessageId: 'msg-9', imageUrl: 'https://cdn.discordapp.com/a/b/c.png' },
      ],
      skipped: [],
    });

    await run();
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('one guild failing does not stop the others', () => {
  it('carries on to the next guild', async () => {
    loadConfig.mockResolvedValue({ registry: { g1: {}, g2: {} }, auditChannelId: null });
    fetchFeedbackActions
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValueOnce({ actions: [REPORT], skipped: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await run();

    expect(result.failed).toBe(1);
    expect(result.posted).toBe(1);
  });
});

describe('fetchImage', () => {
  const OK_URL = 'https://cdn.discordapp.com/attachments/1/2/shot.png';

  function response(init: {
    status?: number;
    type?: string;
    body?: Uint8Array;
    length?: string;
  }) {
    const bytes = init.body ?? new Uint8Array([1, 2, 3]);
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers: {
        get: (h: string) =>
          h === 'content-type' ? (init.type ?? 'image/png') : (init.length ?? String(bytes.length)),
      },
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Response;
  }

  it('fetches a Discord attachment', async () => {
    const { fetchImage } = await import('../feedback.js');
    const impl = vi.fn().mockResolvedValue(response({}));

    const file = await fetchImage(OK_URL, impl as unknown as typeof fetch);

    expect(file?.contentType).toBe('image/png');
    expect(file?.filename).toBe('shot.png');
  });

  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://badminton.sfubadminton.com/api/admin/secrets',
    'http://cdn.discordapp.com/attachments/1/2/shot.png',
    'https://cdn.discordapp.com.evil.test/a.png',
  ])('refuses to fetch %s', async (url) => {
    // THE SSRF GUARD. Without it the service secret buys a GET from inside the
    // Pi's network with the answer mirrored into a Discord channel.
    const { fetchImage } = await import('../feedback.js');
    const impl = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await fetchImage(url, impl as unknown as typeof fetch)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses something that is not an image', async () => {
    const { fetchImage } = await import('../feedback.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const impl = vi.fn().mockResolvedValue(response({ type: 'text/html' }));

    expect(await fetchImage(OK_URL, impl as unknown as typeof fetch)).toBeNull();
  });

  it('refuses an over-large file on the declared length, before reading it', async () => {
    const { fetchImage } = await import('../feedback.js');
    const impl = vi.fn().mockResolvedValue(response({ length: String(50 * 1024 * 1024) }));

    expect(await fetchImage(OK_URL, impl as unknown as typeof fetch)).toBeNull();
  });

  it('treats an expired signature as ordinary, not as a failure', async () => {
    // The url dies in about a day. A report that outlived it is the common
    // case, and it still has to reach the channel.
    const { fetchImage } = await import('../feedback.js');
    const impl = vi.fn().mockResolvedValue(response({ status: 403 }));

    expect(await fetchImage(OK_URL, impl as unknown as typeof fetch)).toBeNull();
  });

  it('posts the report anyway when the screenshot cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('gone')));
    fetchFeedbackActions.mockResolvedValue({
      actions: [{ ...REPORT, imageUrl: OK_URL }],
      skipped: [],
    });

    const result = await run();

    expect(postMessageWithFile).toHaveBeenCalledWith('c-exec', expect.anything(), null);
    expect(result.posted).toBe(1);
    expect(result.imagesDropped).toBe(1);
    vi.unstubAllGlobals();
  });
});
