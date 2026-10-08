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
//
// PAGING KEEPS BOTH. The page is client-controlled and the caller id is not: it
// comes off the interaction, never out of the custom_id, and the assertions below
// are what say so.

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

// The whole shape the app answers with, so a test says only what it is about.
function page(overrides: Record<string, unknown> = {}) {
  return {
    sessions: SESSIONS,
    linked: true,
    page: 1,
    totalPages: 1,
    total: 1,
    query: null,
    location: null,
    locations: [],
    ...overrides,
  };
}

interface Row {
  type: number;
  components: { custom_id: string; label?: string; disabled?: boolean; options?: unknown[] }[];
}

interface Rendered {
  type: number;
  data: {
    flags?: number;
    embeds?: { footer?: { text: string }; description?: string }[];
    components?: Row[];
    custom_id?: string;
  };
}

const CONTEXT = { discordUserId: '424242', guildId: 'g1' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/sessions', () => {
  it('passes the caller through so the app can filter to their track', async () => {
    fetchSessions.mockResolvedValue(page());
    const { handleSessions } = await import('../commands.js');

    await handleSessions(CONTEXT);

    expect(fetchSessions).toHaveBeenCalledWith('424242', 1);
  });

  it('replies EPHEMERALLY so a filtered schedule is not posted to the channel', async () => {
    fetchSessions.mockResolvedValue(page());
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions(CONTEXT)) as Rendered;

    // 64 = EPHEMERAL. Without it the per-caller filter is decorative.
    expect(response.data.flags).toBe(64);
    expect(response.data.embeds).toHaveLength(1);
  });

  it('tells an unlinked caller their list is narrowed, not empty', async () => {
    fetchSessions.mockResolvedValue(page({ linked: false }));
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions({ discordUserId: '999', guildId: 'g1' })) as Rendered;

    expect(response.data.flags).toBe(64);
    expect(response.data.embeds?.[0]?.footer?.text).toContain('/link');
  });

  it('sends no caller header when Discord gave us no id', async () => {
    fetchSessions.mockResolvedValue(page({ linked: false }));
    const { handleSessions } = await import('../commands.js');

    await handleSessions({ discordUserId: null, guildId: 'g1' });

    expect(fetchSessions).toHaveBeenCalledWith(null, 1);
  });

  it('points an unlinked caller at /link when nothing club-wide is open', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: [], linked: false, total: 0 }));
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions({
      discordUserId: '999',
      guildId: 'g1',
    })) as { data: { flags?: number; content: string } };

    expect(response.data.flags).toBe(64);
    expect(response.data.content).toContain('/link');
  });
});

describe('/sessions paging', () => {
  it('carries one row of four controls when there is more than one page', async () => {
    fetchSessions.mockResolvedValue(page({ totalPages: 3, total: 28 }));
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions(CONTEXT)) as Rendered;
    const rows = response.data.components ?? [];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.components.map((c) => c.label)).toEqual([
      'Previous',
      'Next',
      'Go to page',
      'Find',
    ]);
    expect(response.data.embeds?.[0]?.footer?.text).toContain('Page 1 of 3');
  });

  it('disables the edges rather than omitting them', async () => {
    fetchSessions.mockResolvedValue(page({ page: 1, totalPages: 3, total: 28 }));
    const { handleSessions } = await import('../commands.js');
    const first = (await handleSessions(CONTEXT)) as Rendered;

    expect(first.data.components?.[0]?.components[0]?.disabled).toBe(true);
    expect(first.data.components?.[0]?.components[1]?.disabled).toBe(false);

    fetchSessions.mockResolvedValue(page({ page: 3, totalPages: 3, total: 28 }));
    const last = (await handleSessions(CONTEXT)) as Rendered;

    expect(last.data.components?.[0]?.components[0]?.disabled).toBe(false);
    expect(last.data.components?.[0]?.components[1]?.disabled).toBe(true);
  });

  it('carries no controls at all on a single page', async () => {
    fetchSessions.mockResolvedValue(page({ totalPages: 1 }));
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions(CONTEXT)) as Rendered;
    expect(response.data.components).toEqual([]);
  });

  it('gives every control a DISTINCT id, on every page', async () => {
    // A duplicate custom_id makes Discord refuse the whole message, and on an
    // interaction response that arrives as "the application did not respond"
    // with nothing logged. Direction is encoded in the id so that cannot happen
    // even where prev and next resolve to the same page.
    const { handleSessions } = await import('../commands.js');

    for (const current of [1, 2, 3]) {
      fetchSessions.mockResolvedValue(page({ page: current, totalPages: 3, total: 28 }));
      const response = (await handleSessions(CONTEXT)) as Rendered;
      const ids = (response.data.components?.[0]?.components ?? []).map((c) => c.custom_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('emits ONLY `e` ids, so the first click edits the reply in place', async () => {
    fetchSessions.mockResolvedValue(page({ totalPages: 3, total: 28 }));
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions(CONTEXT)) as Rendered;
    for (const button of response.data.components?.[0]?.components ?? []) {
      expect(button.custom_id.startsWith('ses:e:')).toBe(true);
    }
  });

  it('carries no location select: that control belongs to the public board', async () => {
    fetchSessions.mockResolvedValue(
      page({
        totalPages: 3,
        total: 28,
        locations: [
          { id: 'aaaaaaaa', label: 'West Gym' },
          { id: 'bbbbbbbb', label: 'East Gym' },
        ],
      })
    );
    const { handleSessions } = await import('../commands.js');

    const response = (await handleSessions(CONTEXT)) as Rendered;
    expect(response.data.components).toHaveLength(1);
  });
});

describe('/sessions paging clicks', () => {
  it('edits the message in place, with BOTH embeds and components', async () => {
    // Omit components from a type 7 and the buttons vanish from the message with
    // no error anywhere.
    fetchSessions.mockResolvedValue(page({ page: 2, totalPages: 3, total: 28 }));
    const { handleSessionPageButton } = await import('../commands.js');

    const response = (await handleSessionPageButton('ses:e:next:2:-', CONTEXT)) as Rendered;

    expect(response.type).toBe(7);
    expect(response.data).toHaveProperty('embeds');
    expect(response.data).toHaveProperty('components');
  });

  it('takes the caller from the interaction and the page from the id', async () => {
    fetchSessions.mockResolvedValue(page({ page: 2, totalPages: 3, total: 28 }));
    const { handleSessionPageButton } = await import('../commands.js');

    await handleSessionPageButton('ses:e:next:2:-', CONTEXT);

    expect(fetchSessions).toHaveBeenCalledWith('424242', 2, undefined, undefined);
  });

  it('falls back to page 1 on an id it cannot read', async () => {
    fetchSessions.mockResolvedValue(page());
    const { handleSessionPageButton } = await import('../commands.js');

    await handleSessionPageButton('ses:e:next:nonsense:-', CONTEXT);

    expect(fetchSessions).toHaveBeenCalledWith('424242', 1, undefined, undefined);
  });

  it('opens a modal for go and for find, with no app call', async () => {
    const { handleSessionPageButton } = await import('../commands.js');

    const go = (await handleSessionPageButton('ses:e:go:3:-', CONTEXT)) as Rendered;
    const find = (await handleSessionPageButton('ses:e:find:-:-', CONTEXT)) as Rendered;

    expect(go.type).toBe(9);
    expect(go.data.custom_id).toBe('sesmodal:go:-');
    expect(find.type).toBe(9);
    expect(find.data.custom_id).toBe('sesmodal:find:-');
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  it('acknowledges an action it does not know and changes nothing', async () => {
    const { handleSessionPageButton } = await import('../commands.js');

    const response = (await handleSessionPageButton('ses:e:sideways:-:-', CONTEXT)) as Rendered;

    expect(response.type).toBe(6);
    expect(fetchSessions).not.toHaveBeenCalled();
  });
});

describe('/sessions modals', () => {
  function typed(customId: string, value: string) {
    return [{ type: 1, components: [{ type: 4, custom_id: customId, value }] }];
  }

  it('answers a go submit ephemerally, NEVER with an in-place edit', async () => {
    // The only assertion of this invariant anywhere: a modal submit is its own
    // interaction, so a type 7 from here would replace a message the member is
    // not looking at.
    fetchSessions.mockResolvedValue(page({ page: 2, totalPages: 3, total: 28 }));
    const { handleSessionListModal } = await import('../commands.js');

    const response = (await handleSessionListModal(
      'sesmodal:go:-',
      typed('page', '2'),
      CONTEXT
    )) as Rendered;

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
    expect(fetchSessions).toHaveBeenCalledWith('424242', 2, undefined, undefined);
  });

  it('reads a typed page that is not a number as page 1', async () => {
    fetchSessions.mockResolvedValue(page());
    const { handleSessionListModal } = await import('../commands.js');

    await handleSessionListModal('sesmodal:go:-', typed('page', 'later'), CONTEXT);

    expect(fetchSessions).toHaveBeenCalledWith('424242', 1, undefined, undefined);
  });

  it('answers a find with the matches and NO controls', async () => {
    fetchSessions.mockResolvedValue(page({ query: 'club', total: 3 }));
    const { handleSessionListModal } = await import('../commands.js');

    const response = (await handleSessionListModal(
      'sesmodal:find:-',
      typed('q', 'Club'),
      CONTEXT
    )) as Rendered;

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
    expect(response.data.components).toBeUndefined();
    // Sent as typed; the app lowercases and echoes what it applied, which is
    // what the check below compares against.
    expect(fetchSessions).toHaveBeenCalledWith('424242', 1, 'Club', undefined);
  });

  it('refuses a whitespace-only search WITHOUT calling the app', async () => {
    const { handleSessionListModal } = await import('../commands.js');

    const response = (await handleSessionListModal(
      'sesmodal:find:-',
      typed('q', '   '),
      CONTEXT
    )) as { data: { content: string } };

    expect(response.data.content).toContain('Type something');
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  it('REFUSES TO FRAME AN UNFILTERED PAGE AS A SEARCH RESULT', async () => {
    // Deploy skew: a bot asking a player image that does not read `q` gets the
    // unfiltered page back, and calling those ten rows matches would be a wrong
    // answer rather than a cosmetic one.
    fetchSessions.mockResolvedValue(page({ query: null, total: 28 }));
    const { handleSessionListModal } = await import('../commands.js');

    const response = (await handleSessionListModal(
      'sesmodal:find:-',
      typed('q', 'club'),
      CONTEXT
    )) as { data: { content: string; embeds?: unknown[] } };

    expect(response.data.content).toContain("isn't available yet");
    expect(response.data.embeds).toBeUndefined();
  });
});
