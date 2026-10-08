import { describe, it, expect, vi, beforeEach } from 'vitest';

// /bug and /feedback are TWO INTERACTIONS: the command opens a modal, and the
// modal submit files the report. The properties that matter:
//
//   1. THE COMMAND FILES NOTHING. If it did, pressing Escape on the modal would
//      leave a blank row.
//   2. THE KIND SURVIVES THE ROUND TRIP. Discord echoes back the custom_id and
//      the typed values and nothing else, so a kind that is not in the
//      custom_id is a kind that is lost.
//   3. THE REPLY IS EPHEMERAL. Filing a complaint is not publishing it.
//   4. NEITHER COMMAND IS EXEC-GATED. EXEC_ONLY sits in the same file; copying
//      it here would hide /bug from everybody who would ever report a bug.
//   5. THE CALLER'S DISCORD ID IS SENT. It is the rate-limit key AND the only
//      handle on an unlinked reporter.
//   6. A 429 IS NOT RENDERED AS AN OUTAGE. Otherwise members retry a limiter
//      that is working, pushing their next allowed attempt further out.
//   7. A SCREENSHOT NEVER COSTS THE REPORT. Losing the picture is a note in the
//      confirmation; losing the words is not acceptable at all.

const submitFeedback = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  submitFeedback,
}));

const CONTEXT = { discordUserId: 'discord-1', guildId: 'g1' };

type Modal = { type: number; data: { custom_id: string; title: string; components: Row[] } };
type Row = { type: number; components: { custom_id: string; style: number; [k: string]: unknown }[] };

async function open(
  name: 'bug' | 'feedback',
  options: { name: string; value: unknown }[] = [],
  context: Record<string, unknown> = CONTEXT
) {
  const { dispatch } = await import('../commands.js');
  return (await dispatch(name, options, context as never)) as unknown as Modal;
}

/** The typed-in values, in the nested shape Discord actually sends. */
function filled(title: string, details: string) {
  return [
    { type: 1, components: [{ type: 4, custom_id: 'title', value: title }] },
    { type: 1, components: [{ type: 4, custom_id: 'details', value: details }] },
  ];
}

async function submit(
  customId: string,
  title = 'Ladder spins forever',
  details = 'It is broken'
) {
  const { handleReportModal } = await import('../commands.js');
  return (await handleReportModal(customId, filled(title, details), CONTEXT)) as {
    type: number;
    data: { content?: string; flags?: number };
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  submitFeedback.mockResolvedValue({ ok: true, linked: true });
  const { __clearPendingImages } = await import('../commands.js');
  __clearPendingImages();
});

describe('the command opens a modal', () => {
  it('answers with a modal rather than filing anything', async () => {
    const res = await open('bug');

    // 9 is MODAL. Anything else here means the boxes never appear.
    expect(res.type).toBe(9);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it('asks for a title and a body, in that order and in those styles', async () => {
    // THE POINT OF THE MODAL. A one-line option gets one sentence; a paragraph
    // box gets a reproduction. Style 1 is SHORT, style 2 is PARAGRAPH.
    const rows = (await open('bug')).data.components;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.components[0]?.custom_id).toBe('title');
    expect(rows[0]?.components[0]?.style).toBe(1);
    expect(rows[1]?.components[0]?.custom_id).toBe('details');
    expect(rows[1]?.components[0]?.style).toBe(2);
  });

  it('keeps the title box under the column its value lands in', async () => {
    // 00173 CHECKs 120. A modal that let somebody type more would lose the
    // whole report to a constraint violation, not just the overflow.
    const title = (await open('bug')).data.components[0]?.components[0] as {
      max_length?: number;
    };
    expect(title.max_length).toBeLessThanOrEqual(120);
  });

  it('fits inside Discord own limit on a modal title', async () => {
    for (const name of ['bug', 'feedback'] as const) {
      expect((await open(name)).data.title.length).toBeLessThanOrEqual(45);
    }
  });

  it('carries the kind in the custom_id, because nothing else survives', async () => {
    expect((await open('bug')).data.custom_id).toMatch(/^report:bug:/);
    expect((await open('feedback')).data.custom_id).toMatch(/^report:feedback:/);
  });

  it.each(['tournament_feedback', 'other'])('carries about:%s through', async (k) => {
    const res = await open('feedback', [{ name: 'about', value: k }]);
    expect(res.data.custom_id).toMatch(new RegExp(`^report:${k}:`));
  });

  it('gives every modal its own nonce', async () => {
    // Shared nonces would let one report claim another's screenshot.
    const a = (await open('bug')).data.custom_id;
    const b = (await open('bug')).data.custom_id;
    expect(a).not.toBe(b);
  });
});

describe('the modal submit files the report', () => {
  it('files the title and the body under the right kind', async () => {
    await submit('report:bug:abc123', 'Ladder spins', 'It never loads');

    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', title: 'Ladder spins', body: 'It never loads' })
    );
  });

  it('sends the caller so the report is attributable and the limit is per person', async () => {
    await submit('report:bug:abc123');

    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ discordUserId: 'discord-1', guildId: 'g1' })
    );
  });

  it('replies ephemerally', async () => {
    // 64 is the ephemeral flag. Without it a bug report lands in the channel.
    expect((await submit('report:bug:abc123')).data.flags).toBe(64);
  });

  it('falls back to feedback rather than trusting an unknown kind', async () => {
    // Discord only ever sends back a custom_id this module wrote, so this is a
    // caller that is not Discord. 'feedback' is the harmless landing spot; the
    // alternative is failing 00172's CHECK and losing the whole report.
    await submit('report:bug; DROP TABLE:abc123');
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'feedback' }));
  });

  it('reads the values out of the action rows they are nested in', async () => {
    // A flat find matches nothing and reads as an empty box the client would
    // never have allowed.
    const { handleReportModal } = await import('../commands.js');
    await handleReportModal(
      'report:bug:abc123',
      [{ type: 1, components: [{ type: 4, custom_id: 'details', value: 'nested' }] }],
      CONTEXT
    );
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ body: 'nested' }));
  });

  it('refuses an empty report rather than filing a blank row', async () => {
    // A blank row looks like a report the club ignored.
    const res = await submit('report:bug:abc123', 'A title', '   ');

    expect(submitFeedback).not.toHaveBeenCalled();
    expect(res.data.flags).toBe(64);
  });

  it('says so when the reporter has not linked, without implying the report was lost', async () => {
    submitFeedback.mockResolvedValue({ ok: true, linked: false });
    const res = await submit('report:bug:abc123');

    expect(res.data.content).toContain('/link');
    expect(res.data.content).toMatch(/filed/i);
  });

  it('does not nag a linked reporter about linking', async () => {
    expect((await submit('report:bug:abc123')).data.content).not.toContain('/link');
  });

  it('explains a rate limit instead of blaming the app', async () => {
    const { RateLimitedError } = await import('../api.js');
    submitFeedback.mockRejectedValue(new RateLimitedError('rate-limited'));
    const res = await submit('report:bug:abc123');

    expect(res.data.content).not.toMatch(/couldn't reach/i);
    expect(res.data.content).toMatch(/hour|short space/i);
  });

  it('lets a genuine app failure out, so index.ts can say nothing was filed', async () => {
    // NOT swallowed here, unlike dispatch(): the caller has to be able to tell
    // the reporter their words did not land.
    const { AppApiError } = await import('../api.js');
    submitFeedback.mockRejectedValue(new AppApiError('POST /api/discord/feedback -> 503'));

    await expect(submit('report:bug:abc123')).rejects.toBeInstanceOf(AppApiError);
  });
});

describe('the screenshot', () => {
  const IMAGE = {
    url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
    filename: 'shot.png',
    content_type: 'image/png',
    size: 1024,
  };

  async function openWithFile(file: Record<string, unknown>) {
    return open('bug', [{ name: 'screenshot', value: 'att-1' }], {
      ...CONTEXT,
      attachments: { 'att-1': file },
    });
  }

  it('carries the picked file across to the submit', async () => {
    // THE WHOLE REASON THE NONCE EXISTS. The file is picked on the command
    // interaction and needed on the modal submit, and Discord echoes back
    // nothing from the first except the custom_id.
    const modal = await openWithFile(IMAGE);
    await submit(modal.data.custom_id);

    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: IMAGE.url }));
  });

  it('claims the file once, so a replayed submit cannot re-attach it', async () => {
    const modal = await openWithFile(IMAGE);
    await submit(modal.data.custom_id);
    await submit(modal.data.custom_id);

    expect(submitFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ imageUrl: null }));
  });

  it('files the words anyway when the nonce is gone', async () => {
    // A restart, or a second replica taking the submit. Costs the picture,
    // never the report.
    const res = await submit('report:bug:nonexistent');

    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: null }));
    expect(res.data.content).toMatch(/filed/i);
  });

  it.each([
    [{ ...IMAGE, content_type: 'application/pdf' }, /not an image/i],
    [{ ...IMAGE, size: 20 * 1024 * 1024 }, /8MB/i],
  ])('rejects an unusable file and says why', async (file, expected) => {
    const modal = await openWithFile(file);
    const res = await submit(modal.data.custom_id);

    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: null }));
    // SAID OUT LOUD. A screenshot that silently does not appear reads as the
    // whole report having failed.
    expect(res.data.content).toMatch(expected);
    expect(res.data.content).toMatch(/filed/i);
  });

  it('says nothing about screenshots when none was offered', async () => {
    const modal = await open('bug');
    const res = await submit(modal.data.custom_id);
    expect(res.data.content).not.toMatch(/screenshot/i);
  });
});

describe('command definitions', () => {
  it('leaves /bug and /feedback open to every member', async () => {
    // THE GATE TEST. EXEC_ONLY is '0' — "nobody, until an exec is granted it
    // explicitly" — and it is one copy-paste away in this file. On these two it
    // would hide the commands from exactly the people who need them.
    const { COMMAND_DEFINITIONS } = await import('../commands.js');
    const open = COMMAND_DEFINITIONS.filter((c) => c.name === 'bug' || c.name === 'feedback');

    expect(open).toHaveLength(2);
    for (const cmd of open) {
      expect(cmd).not.toHaveProperty('default_member_permissions');
    }
  });

  it('takes the screenshot as a command option, because a modal cannot', async () => {
    // Type 11 is ATTACHMENT, and it has to live here: a modal accepts text
    // inputs and nothing else. If this ever moves into the modal it will look
    // accepted and upload nothing.
    const { COMMAND_DEFINITIONS } = await import('../commands.js');
    for (const name of ['bug', 'feedback']) {
      const options = COMMAND_DEFINITIONS.find((c) => c.name === name)?.options ?? [];
      const shot = options.find((o) => o.name === 'screenshot') as
        | { type?: number; required?: boolean }
        | undefined;

      expect(shot?.type).toBe(11);
      expect(shot?.required).toBe(false);
      // The words moved into the modal. A leftover `details` option would mean
      // two places to type the same thing.
      expect(options.find((o) => o.name === 'details')).toBeUndefined();
    }
  });
});

describe('isReportModal', () => {
  it('claims this module modals and nothing else', async () => {
    const { isReportModal } = await import('../commands.js');

    expect(isReportModal('report:bug:abc')).toBe(true);
    expect(isReportModal('selfrole:123')).toBe(false);
    expect(isReportModal(undefined)).toBe(false);
  });
});
