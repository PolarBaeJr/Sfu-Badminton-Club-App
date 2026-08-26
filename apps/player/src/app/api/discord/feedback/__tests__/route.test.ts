import { describe, it, expect, vi, beforeEach } from 'vitest';

// The properties that matter on a route whose whole job is to not lose what a
// member typed:
//
//   1. THE RATE LIMIT IS KEYED ON THE REPORTER. Every request here arrives from
//      the bot, so an IP key would be one bucket for the entire club and the
//      first person to file three reports would lock out everybody else.
//   2. A FAILED LINK LOOKUP DOES NOT LOSE THE REPORT. The unlinked and the
//      unresolvable both still get a row.
//   3. A FAILED INSERT IS NEVER REPORTED AS OK. The bot's reply is the only
//      receipt the reporter gets.

const inserts: Record<string, unknown>[] = [];
let links: { player_id: string }[] = [];
let linkError: { message: string } | null = null;
let insertError: { message: string } | null = null;

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'player_discord_links') {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.maybeSingle = () =>
          Promise.resolve({ data: linkError ? null : (links[0] ?? null), error: linkError });
        return builder;
      }
      if (table === 'feedback_reports') {
        return {
          insert: (row: Record<string, unknown>) => {
            if (!insertError) inserts.push(row);
            return Promise.resolve({ error: insertError });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

let userSeq = 0;
/** A fresh Discord id per call, because the limiter is module-level and is not
 *  reset between tests — a shared id would make later tests 429 at random. */
function freshUser() {
  return `discord-user-${(userSeq += 1)}`;
}

async function post(body: unknown, secret = 'test-secret') {
  const { POST } = await import('../route');
  const res = await POST(
    new Request('http://localhost/api/discord/feedback', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function report(over: Record<string, unknown> = {}) {
  return {
    kind: 'bug',
    body: 'The ladder page shows a spinner forever after I log in.',
    discordUserId: freshUser(),
    guildId: 'g1',
    ...over,
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  inserts.length = 0;
  links = [{ player_id: 'player-1' }];
  linkError = null;
  insertError = null;
});

describe('POST /api/discord/feedback', () => {
  it('refuses without the service secret', async () => {
    expect((await post(report(), 'wrong')).status).toBe(401);
  });

  it('files a bug report against the linked player', async () => {
    const { status, body } = await post(report());

    expect(status).toBe(200);
    expect(body.linked).toBe(true);
    expect(inserts[0]).toMatchObject({
      kind: 'bug',
      player_id: 'player-1',
      source: 'discord',
      guild_id: 'g1',
    });
  });

  it.each(['feedback', 'tournament_feedback', 'other'])('accepts the %s kind', async (kind) => {
    await post(report({ kind }));
    expect(inserts[0]?.kind).toBe(kind);
  });

  it('rejects a kind that is not one of the four', async () => {
    // The CHECK in 00172 would reject it anyway; refusing here means the error
    // is a 400 the bot can render, not a 503 that reads as an outage.
    const { status } = await post(report({ kind: 'complaint' }));
    expect(status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  // ---- LOSING A REPORT IS THE FAILURE THAT MATTERS ------------------------

  it('still files the report when the member has never linked', async () => {
    links = [];
    const { status, body } = await post(report());

    expect(status).toBe(200);
    expect(body.linked).toBe(false);
    expect(inserts[0]).toMatchObject({ player_id: null });
    // The only handle left on the reporter. Without it the report is anonymous
    // and nobody can follow up.
    expect(inserts[0]?.discord_user_id).toEqual(expect.any(String));
  });

  it('still files the report when the link lookup itself fails', async () => {
    // A broken lookup is not a reason to throw somebody's words away, and an
    // onboarding bug is exactly the kind that breaks the lookup.
    linkError = { message: 'permission denied for table player_discord_links' };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { status, body } = await post(report());
    expect(status).toBe(200);
    expect(body.linked).toBe(false);
    expect(inserts).toHaveLength(1);
  });

  it('never reports ok when the insert failed', async () => {
    insertError = { message: 'relation "feedback_reports" does not exist' };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { status, body } = await post(report());
    expect(status).toBe(503);
    expect(body.ok).toBeUndefined();
  });

  // ---- THE RATE LIMIT KEY -------------------------------------------------

  it('limits one reporter without touching anybody else', async () => {
    // THE PROPERTY. Key this on the IP instead and the second reporter here is
    // locked out by the first, because every request comes from the one bot.
    const noisy = freshUser();
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push((await post(report({ discordUserId: noisy }))).status);
    }
    expect(results).toContain(429);

    const bystander = await post(report({ discordUserId: freshUser() }));
    expect(bystander.status).toBe(200);
  });

  // ---- WHAT GETS STORED ---------------------------------------------------

  it('keeps the line breaks a reproduction is written in', async () => {
    // Collapsing these would destroy the most useful reports — a numbered list
    // of steps flattened into one line is a wall of text.
    await post(report({ body: '1. Log in\n2. Open the ladder\n3. Spinner forever' }));
    expect(inserts[0]?.body).toBe('1. Log in\n2. Open the ladder\n3. Spinner forever');
  });

  it('strips the control characters that would garble a psql session', async () => {
    // Written as escapes, not literals: a real ESC byte in a source file is
    // invisible in every diff it ever appears in.
    await post(report({ body: 'before\u001b[31m\u0007after' }));
    const stored = String(inserts[0]?.body);

    expect(stored).not.toMatch(/\p{Cc}/u);
    expect(stored).toContain('before');
    expect(stored).toContain('after');
  });

  it('truncates rather than refusing an over-long report', async () => {
    // Discord caps the option at 1000, so reaching this means a caller that is
    // not the slash command. Keeping the first 2000 characters beats a 400 that
    // discards all of them.
    await post(report({ body: 'x'.repeat(9000) }));
    expect(String(inserts[0]?.body)).toHaveLength(2000);
  });

  it('refuses a report that is only whitespace', async () => {
    const { status } = await post(report({ body: '   \n  ' }));
    expect(status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a body that is not valid json', async () => {
    expect((await post('not json')).status).toBe(400);
  });
});
