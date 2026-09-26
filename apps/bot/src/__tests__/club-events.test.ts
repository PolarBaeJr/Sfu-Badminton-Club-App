import { describe, it, expect, vi, beforeEach } from 'vitest';

// The same two properties as the tournament pass, through the same engine:
// call Discord first and record second, and record the event's own values
// rather than what was sent. Club events add a third: the location and
// description recorded are the APP's, so a fallback location sent to Discord
// never reads back as a change.

const fetchClubEventActions = vi.fn();
const recordClubEvent = vi.fn();
const clearClubEvent = vi.fn();
const createScheduledEvent = vi.fn();
const modifyScheduledEvent = vi.fn();
const deleteScheduledEvent = vi.fn();
const hasManageEvents = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchClubEventActions,
  recordClubEvent,
  clearClubEvent,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    createScheduledEvent = createScheduledEvent;
    modifyScheduledEvent = modifyScheduledEvent;
    deleteScheduledEvent = deleteScheduledEvent;
    hasManageEvents = hasManageEvents;
  },
}));

const CREATE = {
  kind: 'create' as const,
  eventId: 'e1',
  discordEventId: null,
  name: 'Games Night',
  // Clamped: the event's own start is in the past, so the send value was
  // pushed forward by the app.
  startsAt: '2026-10-01T02:00:00.000Z',
  endsAt: '2026-10-01T04:00:00.000Z',
  syncedStartsAt: '2026-10-01T01:58:00.000Z',
  syncedEndsAt: '2026-10-01T04:00:00.000Z',
  patchTimes: true,
  location: null,
  description: 'Social\n\nDetails and sign-up: https://example.test/events/e1',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: new Map([['g1', {}]]), auditChannelId: null });
  fetchClubEventActions.mockResolvedValue({ actions: [CREATE], skipped: [] });
  hasManageEvents.mockResolvedValue(true);
  createScheduledEvent.mockResolvedValue('evt-1');
  modifyScheduledEvent.mockResolvedValue('ok');
  deleteScheduledEvent.mockResolvedValue(true);
  recordClubEvent.mockResolvedValue({ ok: true });
  clearClubEvent.mockResolvedValue({ ok: true });
});

describe('club events', () => {
  it('creates, then records, never the other way round', async () => {
    const order: string[] = [];
    createScheduledEvent.mockImplementation(async () => {
      order.push('create');
      return 'evt-1';
    });
    recordClubEvent.mockImplementation(async () => {
      order.push('record');
      return { ok: true };
    });

    const { runClubEvents } = await import('../club-events.js');
    const result = await runClubEvents();

    expect(order).toEqual(['create', 'record']);
    expect(result.created).toBe(1);
  });

  it("records the event's own values: unclamped start, the app's null location, the description", async () => {
    const { runClubEvents } = await import('../club-events.js');
    await runClubEvents();

    const payload = createScheduledEvent.mock.calls[0]?.[1] as {
      startsAt: string;
      location: string;
    };
    expect(payload.startsAt).toBe(CREATE.startsAt);
    // Discord got a location, because an EXTERNAL event needs one...
    expect(payload.location.length).toBeGreaterThan(0);
    // ...but the record keeps the app's null, so the next tick sees no change.
    expect(recordClubEvent).toHaveBeenCalledWith({
      eventId: 'e1',
      guildId: 'g1',
      discordEventId: 'evt-1',
      name: CREATE.name,
      syncedStartsAt: CREATE.syncedStartsAt,
      syncedEndsAt: CREATE.syncedEndsAt,
      location: null,
      description: CREATE.description,
    });
  });

  it('does NOT record an event Discord refused', async () => {
    createScheduledEvent.mockResolvedValue(null);

    const { runClubEvents } = await import('../club-events.js');
    const result = await runClubEvents();

    expect(recordClubEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: 0, failed: 1 });
  });

  it('deletes the Discord event BEFORE forgetting the mapping', async () => {
    const order: string[] = [];
    deleteScheduledEvent.mockImplementation(async () => {
      order.push('delete');
      return true;
    });
    clearClubEvent.mockImplementation(async () => {
      order.push('clear');
      return { ok: true };
    });
    fetchClubEventActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'cancel', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runClubEvents } = await import('../club-events.js');
    const result = await runClubEvents();

    expect(order).toEqual(['delete', 'clear']);
    expect(clearClubEvent).toHaveBeenCalledWith('e1', 'g1');
    expect(result.cancelled).toBe(1);
  });

  it('keeps the mapping when the Discord delete fails', async () => {
    deleteScheduledEvent.mockResolvedValue(false);
    fetchClubEventActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'cancel', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runClubEvents } = await import('../club-events.js');
    const result = await runClubEvents();

    expect(clearClubEvent).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('RECORDS an update whose event is gone, as stale', async () => {
    modifyScheduledEvent.mockResolvedValue('gone');
    fetchClubEventActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'update', discordEventId: 'evt-1' }],
      skipped: [],
    });

    const { runClubEvents } = await import('../club-events.js');
    const result = await runClubEvents();

    expect(recordClubEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'e1', discordEventId: 'evt-1' })
    );
    expect(createScheduledEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stale: 1, updated: 0, failed: 0 });
  });

  it('carries patchTimes through to the API call', async () => {
    fetchClubEventActions.mockResolvedValue({
      actions: [{ ...CREATE, kind: 'update', discordEventId: 'evt-1', patchTimes: false }],
      skipped: [],
    });

    const { runClubEvents } = await import('../club-events.js');
    await runClubEvents();

    expect(modifyScheduledEvent).toHaveBeenCalledWith('g1', 'evt-1', expect.anything(), false);
  });

  it('counts the skips the app reports', async () => {
    fetchClubEventActions.mockResolvedValue({
      actions: [],
      skipped: [{ eventId: '*', reason: 'events_disabled' }],
    });

    const { runClubEvents } = await import('../club-events.js');
    const result = await runClubEvents();

    expect(result.skipped).toBe(1);
    expect(hasManageEvents).not.toHaveBeenCalled();
  });
});
