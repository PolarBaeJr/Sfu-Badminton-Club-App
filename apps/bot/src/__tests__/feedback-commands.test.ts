import { describe, it, expect, vi, beforeEach } from 'vitest';

// /bug and /feedback. Four things have to hold:
//
//   1. THE REPLY IS EPHEMERAL. Filing a complaint is not publishing it, and a
//      member reporting that a feature is broken has not asked the channel to
//      hear about it.
//   2. NEITHER COMMAND IS EXEC-GATED. EXEC_ONLY sits in the same file; copying
//      it here would hide /bug from everybody who would ever report a bug.
//   3. THE CALLER'S DISCORD ID IS SENT. It is the rate-limit key AND the only
//      handle on an unlinked reporter — drop it and every report is anonymous
//      and the whole club shares one bucket.
//   4. A 429 IS NOT RENDERED AS AN OUTAGE. Otherwise members retry a limiter
//      that is working, pushing their next allowed attempt further out.

const submitFeedback = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  submitFeedback,
}));

const CONTEXT = { discordUserId: 'discord-1', guildId: 'g1' };

async function run(
  name: 'bug' | 'feedback',
  options: { name: string; value: unknown }[] = [{ name: 'details', value: 'It is broken' }]
) {
  const { dispatch } = await import('../commands.js');
  return (await dispatch(name, options, CONTEXT)) as {
    type: number;
    data: { content?: string; flags?: number };
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  submitFeedback.mockResolvedValue({ ok: true, linked: true });
});

describe('/bug and /feedback', () => {
  it('files a bug under the bug kind', async () => {
    await run('bug');

    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', body: 'It is broken' })
    );
  });

  it('sends the caller so the report is attributable and the limit is per person', async () => {
    await run('bug');

    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ discordUserId: 'discord-1', guildId: 'g1' })
    );
  });

  it.each([
    ['bug' as const, 'bug'],
    ['feedback' as const, 'feedback'],
  ])('%s replies ephemerally', async (command) => {
    const res = await run(command);

    // 64 is the ephemeral flag. Without it a bug report lands in the channel.
    expect(res.data.flags).toBe(64);
  });

  it('defaults /feedback to general feedback when nothing is chosen', async () => {
    await run('feedback');
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'feedback' }));
  });

  it.each(['tournament_feedback', 'other'])('routes /feedback about:%s to that kind', async (k) => {
    await run('feedback', [
      { name: 'details', value: 'The draw took ages' },
      { name: 'about', value: k },
    ]);
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: k }));
  });

  it('falls back to feedback rather than trusting an unknown choice', async () => {
    // Discord will only ever send one of the declared values, so this is a
    // caller that is not Discord. 'feedback' is the harmless landing spot; the
    // alternative is passing it through to a CHECK that rejects the whole row.
    await run('feedback', [
      { name: 'details', value: 'hello' },
      { name: 'about', value: 'bug; DROP TABLE' },
    ]);
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'feedback' }));
  });

  it('says so when the reporter has not linked, without implying the report was lost', async () => {
    submitFeedback.mockResolvedValue({ ok: true, linked: false });
    const res = await run('bug');

    expect(res.data.content).toContain('/link');
    expect(res.data.content).toMatch(/filed/i);
  });

  it('does not nag a linked reporter about linking', async () => {
    const res = await run('bug');
    expect(res.data.content).not.toContain('/link');
  });

  it('explains a rate limit instead of blaming the app', async () => {
    const { RateLimitedError } = await import('../api.js');
    submitFeedback.mockRejectedValue(new RateLimitedError('rate-limited'));
    const res = await run('bug');

    expect(res.data.content).not.toMatch(/couldn't reach/i);
    expect(res.data.content).toMatch(/hour|short space/i);
  });

  it('still reports a genuine app failure as one', async () => {
    const { AppApiError } = await import('../api.js');
    submitFeedback.mockRejectedValue(new AppApiError('POST /api/discord/feedback -> 503'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run('bug');

    expect(res.data.content).toMatch(/couldn't reach/i);
  });

  it('refuses an empty report rather than filing a blank row', async () => {
    // A blank row looks like a report the club ignored.
    const res = await run('bug', [{ name: 'details', value: '   ' }]);

    expect(submitFeedback).not.toHaveBeenCalled();
    expect(res.data.flags).toBe(64);
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

  it('caps the report length in Discord, before it is ever sent', async () => {
    // The client refuses with the text still in the box. Without it an
    // over-long report is accepted and silently truncated by the route.
    const { COMMAND_DEFINITIONS } = await import('../commands.js');
    for (const name of ['bug', 'feedback']) {
      const details = COMMAND_DEFINITIONS.find((c) => c.name === name)?.options?.find(
        (o) => o.name === 'details'
      ) as { max_length?: number; required?: boolean } | undefined;

      expect(details?.required).toBe(true);
      expect(details?.max_length).toBe(1000);
    }
  });
});
