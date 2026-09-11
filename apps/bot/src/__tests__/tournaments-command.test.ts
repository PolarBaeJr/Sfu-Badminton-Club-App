import { describe, it, expect, vi, beforeEach } from 'vitest';

// /tournaments is ephemeral for a reason one step removed from /sessions'. There
// is no leak in the LIST: the column that pretended to gate a tournament was
// dropped in 00109 and the website filters nothing. What is per-caller is the
// eligibility note, and a public reply would announce to the channel which
// membership type the caller holds.
//
// PAGING HERE WILL LOOK LIKE NOTHING CHANGED for a long time: the controls are
// omitted below eleven upcoming tournaments and the club runs a handful. That is
// the design working, not the work missing, which is why it is pinned by tests
// rather than by looking at Discord.

const fetchTournaments = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchTournaments,
}));

const TOURNAMENTS = [
  {
    id: 't1',
    name: 'Autumn Classic',
    startDate: '2026-10-03',
    endDate: '2026-10-04',
    events: ['mens_singles'],
    registrationOpen: true,
    eligible: true,
  },
];

function page(overrides: Record<string, unknown> = {}) {
  return {
    tournaments: TOURNAMENTS,
    linked: true,
    page: 1,
    totalPages: 1,
    total: 1,
    query: null,
    ...overrides,
  };
}

interface Rendered {
  type: number;
  data: {
    flags?: number;
    custom_id?: string;
    embeds?: { footer?: { text: string }; description?: string }[];
    components?: { components: { custom_id: string; label?: string }[] }[];
  };
}

const CONTEXT = { discordUserId: '424242', guildId: 'g1' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/tournaments', () => {
  it('asks as the caller and replies ephemerally', async () => {
    fetchTournaments.mockResolvedValue(page());
    const { handleTournaments } = await import('../commands.js');

    const response = (await handleTournaments(CONTEXT)) as Rendered;

    expect(fetchTournaments).toHaveBeenCalledWith('424242', 1);
    expect(response.data.flags).toBe(64);
    // The fixture has to survive formatTournament, or every shape assertion
    // below would pass over a description full of `undefined`.
    expect(response.data.embeds?.[0]?.description).toContain('Autumn Classic');
  });

  it('carries no controls while there is only one page', async () => {
    fetchTournaments.mockResolvedValue(page());
    const { handleTournaments } = await import('../commands.js');

    expect(((await handleTournaments(CONTEXT)) as Rendered).data.components).toEqual([]);
  });

  it('carries one row of four once there is more than one page', async () => {
    fetchTournaments.mockResolvedValue(page({ totalPages: 2, total: 14 }));
    const { handleTournaments } = await import('../commands.js');

    const rows = ((await handleTournaments(CONTEXT)) as Rendered).data.components ?? [];

    expect(rows).toHaveLength(1);
    const ids = rows[0]?.components.map((c) => c.custom_id) ?? [];
    expect(ids).toHaveLength(4);
    // Distinct in every case, because direction is in the id: a duplicate
    // custom_id makes Discord refuse the whole message.
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id.startsWith('trn:e:')).toBe(true);
  });

  it('pages in place, with BOTH embeds and components', async () => {
    fetchTournaments.mockResolvedValue(page({ page: 2, totalPages: 2, total: 14 }));
    const { handleTournamentPageButton } = await import('../commands.js');

    const response = (await handleTournamentPageButton('trn:e:next:2:-', CONTEXT)) as Rendered;

    expect(response.type).toBe(7);
    expect(response.data).toHaveProperty('embeds');
    expect(response.data).toHaveProperty('components');
    expect(fetchTournaments).toHaveBeenCalledWith('424242', 2);
  });

  it('opens its own modals, never the sessions ones', async () => {
    const { handleTournamentPageButton } = await import('../commands.js');

    const go = (await handleTournamentPageButton('trn:e:go:2:-', CONTEXT)) as Rendered;

    expect(go.type).toBe(9);
    expect(go.data.custom_id).toBe('trnmodal:go:-');
    expect(fetchTournaments).not.toHaveBeenCalled();
  });

  it('answers a modal submit ephemerally, never with an edit', async () => {
    fetchTournaments.mockResolvedValue(page({ page: 2, totalPages: 2, total: 14 }));
    const { handleTournamentListModal } = await import('../commands.js');

    const response = (await handleTournamentListModal(
      'trnmodal:go:-',
      [{ type: 1, components: [{ type: 4, custom_id: 'page', value: '2' }] }],
      CONTEXT
    )) as Rendered;

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
  });

  it('refuses to frame an unfiltered page as a search result', async () => {
    fetchTournaments.mockResolvedValue(page({ query: null, total: 14 }));
    const { handleTournamentListModal } = await import('../commands.js');

    const response = (await handleTournamentListModal(
      'trnmodal:find:-',
      [{ type: 1, components: [{ type: 4, custom_id: 'q', value: 'autumn' }] }],
      CONTEXT
    )) as { data: { content: string; embeds?: unknown[] } };

    expect(response.data.content).toContain("isn't available yet");
    expect(response.data.embeds).toBeUndefined();
  });
});
