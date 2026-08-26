import { describe, it, expect, vi, beforeEach } from 'vitest';

// /sessions returns a schedule the APP has already narrowed to the caller. Two
// things have to hold for that to mean anything, and they are only meaningful
// together:
//
//   1. the caller's Discord id is actually sent, or the app answers with the
//      unlinked view for everybody;
//   2. the reply is ephemeral, or one competitive member's filtered schedule is
//      posted into a channel every recreational member can read.
//
// Pinning only the first would leave the reported bug shipping under a green
// suite, which is why the flag is asserted here rather than left to review.

const fetchSessions = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSessions,
}));

const SESSIONS = [
  {
    id: 's1',
    name: 'Club night',
    date: '2026-09-01',
    startTime: '19:30',
    endTime: '21:30',
    startsAt: '2026-09-02T02:30:00Z',
    location: 'West Gym',
    track: 'all',
    going: 12,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/sessions', () => {
  it('passes the caller through so the app can filter to their track', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: true });
    const { handleSessions } = await import('../commands.js');

    await handleSessions({ discordUserId: '424242', guildId: 'g1' });

    expect(fetchSessions).toHaveBeenCalledWith('424242');
  });

  it('replies EPHEMERALLY so a filtered schedule is not posted to the channel', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: true });
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions({
      discordUserId: '424242',
      guildId: 'g1',
    })) as { data: { flags?: number; embeds?: unknown[] } };

    // 64 = EPHEMERAL. Without it the per-caller filter is decorative.
    expect(response.data.flags).toBe(64);
    expect(response.data.embeds).toHaveLength(1);
  });

  it('tells an unlinked caller their list is narrowed, not empty', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: false });
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions({
      discordUserId: '999', guildId: 'g1',
    })) as { data: { flags?: number; embeds: { footer: { text: string } }[] } };

    expect(response.data.flags).toBe(64);
    expect(response.data.embeds[0].footer.text).toContain('/link');
  });

  it('sends no caller header when Discord gave us no id', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: false });
    const { handleSessions } = await import('../commands.js');

    await handleSessions({ discordUserId: null, guildId: 'g1' });

    expect(fetchSessions).toHaveBeenCalledWith(null);
  });

  it('points an unlinked caller at /link when nothing club-wide is open', async () => {
    fetchSessions.mockResolvedValue({ sessions: [], linked: false });
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions({
      discordUserId: '999', guildId: 'g1',
    })) as { data: { flags?: number; content: string } };

    expect(response.data.flags).toBe(64);
    expect(response.data.content).toContain('/link');
  });
});
