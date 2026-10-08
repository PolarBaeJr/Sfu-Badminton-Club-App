import { describe, it, expect, vi, beforeEach } from 'vitest';

// /announce is two interactions: the command opens a modal, the submit files it.
//
// TWO THINGS HAVE TO HOLD ACROSS THAT GAP AND NEITHER ANNOUNCES ITSELF.
//
// The four command options survive only in the custom_id -- Discord echoes back
// nothing else from the first interaction -- so an id this build cannot read has
// to fail CLOSED on `draft`. A draft an exec has to go and publish is an
// annoyance; a publish nobody asked for is on the website and in the
// announcements channel before anyone can say otherwise.
//
// And the success reply has to say that nobody was notified. This path files the
// announcement and dispatches nothing: no in-app bell, no push. An exec who
// reads "posted" and walks away believes they have told the club when they have
// not, and that is the one outcome this feature must not produce quietly.

// vi.hoisted because the static import below triggers the mock factory during
// hoisting, before a bare const would have initialised.
const { submitAnnouncement } = vi.hoisted(() => ({ submitAnnouncement: vi.fn() }));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  submitAnnouncement,
}));

import {
  COMMAND_DEFINITIONS,
  dispatch,
  handleAnnounceModal,
  isAnnounceModal,
} from '../commands.js';

const CONTEXT = { discordUserId: '424242', guildId: 'g1' };

interface Modal {
  type: number;
  data: {
    custom_id?: string;
    title?: string;
    content?: string;
    flags?: number;
    components?: { components: Record<string, unknown>[] }[];
  };
}

/** Open the modal the way Discord would, with the options a member picked. */
function open(options: { name: string; value: string | boolean }[] = []): Promise<Modal> {
  return dispatch('announce', options as never, CONTEXT) as unknown as Promise<Modal>;
}

/** Submit it, with whatever was typed into the two boxes. */
function submit(customId: string, title = 'Gym B this week', body = 'We have moved courts.') {
  return handleAnnounceModal(
    customId,
    [
      { type: 1, components: [{ type: 4, custom_id: 'title', value: title }] },
      { type: 1, components: [{ type: 4, custom_id: 'body', value: body }] },
    ],
    CONTEXT
  ) as unknown as Promise<{ data: { content: string; flags: number } }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitAnnouncement.mockResolvedValue({ ok: true, announcementId: 'a1', status: 'published' });
});

describe('opening the modal', () => {
  it('asks for a headline and a paragraph, not a single line', async () => {
    const modal = await open();

    expect(modal.type).toBe(9); // MODAL
    const inputs = (modal.data.components ?? []).map((row) => row.components[0]);
    expect(inputs.map((i) => i.custom_id)).toEqual(['title', 'body']);
    // style 2 = PARAGRAPH. A SHORT box is where people write one sentence and
    // stop, which is the whole reason the words are not a command option.
    expect(inputs[1].style).toBe(2);
  });

  it('carries the options in the custom_id, with nothing stashed in memory', async () => {
    // /bug has to stash its screenshot in a per-process Map, and losing that
    // costs a picture. Losing an option here would cost a publish nobody asked
    // for, so nothing is remembered between the two requests.
    const modal = await open([
      { name: 'type', value: 'urgent' },
      { name: 'pin', value: true },
      { name: 'evergreen', value: true },
    ]);

    expect(modal.data.custom_id).toBe('announce:urgent:101');
    expect(isAnnounceModal(modal.data.custom_id)).toBe(true);
  });

  it('defaults to an info announcement that is neither pinned nor a draft', async () => {
    expect((await open()).data.custom_id).toBe('announce:info:000');
  });

  it('reads a false toggle as false rather than the truthy string "false"', async () => {
    // Discord sends a BOOLEAN option as a real JSON boolean. Reading one through
    // String() makes every explicit `False` a `true`, which would publish a
    // pinned draft on request.
    const modal = await open([
      { name: 'pin', value: false },
      { name: 'draft', value: false },
    ]);

    expect(modal.data.custom_id).toBe('announce:info:000');
  });

  it('says in the modal title whether this will go live', async () => {
    expect((await open()).data.title).toBe('Post an announcement');
    expect((await open([{ name: 'draft', value: true }])).data.title).toBe(
      'Draft an announcement'
    );
  });
});

describe('reading the options back', () => {
  it('sends exactly what the member picked', async () => {
    await submit('announce:warning:110');

    expect(submitAnnouncement).toHaveBeenCalledWith({
      discordUserId: '424242',
      title: 'Gym B this week',
      body: 'We have moved courts.',
      type: 'warning',
      pin: true,
      draft: true,
      evergreen: false,
    });
  });

  it('FAILS CLOSED ON DRAFT when the id is one it cannot read', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A build that changes the packing under
    // a modal somebody still has open, or a caller that is not Discord, must not
    // resolve to "publish". Every unreadable shape lands on draft.
    for (const id of ['announce:info', 'announce:info:', 'announce:info:11', 'announce:info:abc']) {
      vi.clearAllMocks();
      await submit(id);
      expect(submitAnnouncement.mock.calls[0][0].draft, id).toBe(true);
    }
  });

  it('falls back to info for a type it does not know, without touching the flags', async () => {
    await submit('announce:catastrophic:001');

    expect(submitAnnouncement.mock.calls[0][0]).toMatchObject({
      type: 'info',
      evergreen: true,
      draft: false,
    });
  });
});

describe('what the exec is told', () => {
  it('says nobody was notified, in those words', async () => {
    // THE LOAD-BEARING SENTENCE. Without it "Posted" reads as "the club has been
    // told", and no bell row and no push ever went out.
    const reply = await submit('announce:info:000');

    expect(reply.data.content).toContain('Nobody was notified');
    expect(reply.data.content).toContain('publish it from the console');
    expect(reply.data.flags).toBe(64);
  });

  it('names the delay rather than implying the channel already has it', async () => {
    const reply = await submit('announce:info:000');

    expect(reply.data.content).toContain('five minutes');
  });

  it('says a draft is not public, and does not promise the channel anything', async () => {
    submitAnnouncement.mockResolvedValue({ ok: true, announcementId: 'a1', status: 'draft' });

    const reply = await submit('announce:info:010');

    expect(reply.data.content).toContain('draft');
    expect(reply.data.content).not.toContain('five minutes');
  });

  it('turns each refusal into its own sentence, and never prints the code', async () => {
    const cases = [
      { refusal: 'not_linked', expect: '/link' },
      { refusal: 'no_active_season', expect: 'evergreen' },
      { refusal: 'not_permitted', expect: 'permission' },
    ];

    for (const c of cases) {
      submitAnnouncement.mockResolvedValue({ ok: false, refusal: c.refusal });
      const reply = await submit('announce:info:000');

      expect(reply.data.content, c.refusal).toContain(c.expect);
      // Nothing the app puts in a response body reaches a Discord message.
      expect(reply.data.content, c.refusal).not.toContain(c.refusal);
      // And every one of them says the announcement did not happen. A refusal
      // that leaves an exec unsure is a refusal they retype their way past.
      expect(reply.data.content, c.refusal).toContain('Nothing was posted');
    }
  });

  it('treats a refusal it has never heard of as a refusal, not a success', async () => {
    // The app is a separate deployment and can be newer than this bot.
    submitAnnouncement.mockResolvedValue({ ok: false, refusal: 'some_future_reason' });

    const reply = await submit('announce:info:000');

    expect(reply.data.content).toContain('Nothing was posted');
  });

  it('refuses an empty announcement without calling the app', async () => {
    const reply = (await handleAnnounceModal(
      'announce:info:000',
      [{ type: 1, components: [{ type: 4, custom_id: 'title', value: '  ' }] }],
      CONTEXT
    )) as { data: { content: string } };

    expect(reply.data.content).toContain('headline');
    expect(submitAnnouncement).not.toHaveBeenCalled();
  });
});

describe('the command definition', () => {
  const announce = COMMAND_DEFINITIONS.find((c) => c.name === 'announce') as {
    default_member_permissions?: string;
    dm_permission?: boolean;
    options: { name: string; type: number }[];
  };

  it('is hidden from the picker until a server admin grants it', () => {
    // '0' is Discord's "no default access". It is a COMMAND-LIST FILTER and not
    // authorization -- the route asks the caller's own club account for
    // announcements.create.write -- but it keeps the club's only publish command
    // out of every member's picker.
    expect(announce.default_member_permissions).toBe('0');
    expect(announce.dm_permission).toBe(false);
  });

  it('offers the three toggles as real booleans', () => {
    // type 5 = BOOLEAN. A string option would arrive as "true"/"false" and the
    // false case would read as set.
    const toggles = announce.options.filter((o) => ['pin', 'draft', 'evergreen'].includes(o.name));
    expect(toggles).toHaveLength(3);
    expect(toggles.every((o) => o.type === 5)).toBe(true);
  });

  it('offers no audience option at all', () => {
    // Anything but `all` is skipped by the relay as `narrow_audience`, and this
    // path notifies nobody -- so a narrow announcement filed from Discord would
    // reach no channel and no bell, existing only for somebody who opened the
    // page. The choice stays in the console, where it works.
    expect(announce.options.some((o) => o.name === 'audience')).toBe(false);
  });
});
