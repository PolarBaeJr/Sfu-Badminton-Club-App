// What the console has lately asked Discord to say, and how to ask again.
//
// ONE QUERY, TWO CALLERS. The announcements page reads these rows on the server
// so the list is on screen at first paint, and `readDiscordOutbox` reads them
// again while somebody watches a queued row turn into a sent one. A second copy
// of the select would drift from the first the day a column is added, and the
// symptom would be a list that says one thing before a poll and another after.
//
// NOTHING HERE IMPORTS THE SERVER CLIENT AT RUNTIME. The client component needs
// `OutboxRow` and `shouldPollOutbox`, and `import type` above is erased at
// compile time, so bundling this file into the browser carries no Supabase key
// and no `next/headers` with it.

import type { createAdminClient } from './supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

/** How many the console shows. The list answers "did it go out", not "what did we say". */
const RECENT_LIMIT = 5;

export interface OutboxRow {
  id: string;
  createdAt: string;
  channelId: string;
  preview: string;
  ping: boolean;
  state: 'queued' | 'sent' | 'failed';
  error: string | null;
  /**
   * The message in Discord, once there is one.
   *
   * IT IS WHAT DECIDES WHETHER A ROW CAN BE EDITED, and `state` is not: saving
   * an edit puts the row back into the queue, so a row somebody is halfway
   * through fixing reads as QUEUED. Gating the Edit button on `sent` would take
   * it away for five minutes from exactly the person who has just noticed a
   * second typo.
   */
  discordMessageId: string | null;
}

/** How often the console asks again while a row is still queued. */
export const OUTBOX_POLL_MS = 4_000;

/**
 * And when it gives up.
 *
 * The bot drains the outbox on the announcements tick, which pg_cron runs every
 * five minutes, so anything longer than that is a row that is stuck rather than
 * waiting. Past this the console stops asking and leaves the last state on
 * screen: a tab left open overnight must not poll until morning.
 */
export const OUTBOX_POLL_LIMIT_MS = 6 * 60_000;

/**
 * Whether there is anything worth asking about.
 *
 * A sent row never changes again and a failed one changes only when somebody
 * acts, so with neither in the list there is nothing a poll could learn. This
 * is the whole condition: no queued row means no timer exists at all, which is
 * the normal state of this page.
 */
export function shouldPollOutbox(rows: OutboxRow[]): boolean {
  return rows.some((row) => row.state === 'queued');
}

/** The five newest rows, in the shape the console renders. */
export async function readOutboxRows(client: AdminClient): Promise<OutboxRow[]> {
  const { data } = await client
    .from('discord_outbox')
    .select(
      'id, created_at, channel_id, content, embed_title, ping, sent_at, failed_at, last_error, discord_message_id',
    )
    .order('created_at', { ascending: false })
    .limit(RECENT_LIMIT);

  return (
    (data ?? []) as {
      id: string;
      created_at: string;
      channel_id: string;
      content: string | null;
      embed_title: string | null;
      ping: boolean;
      sent_at: string | null;
      failed_at: string | null;
      last_error: string | null;
      discord_message_id: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    channelId: r.channel_id,
    // One line, whichever shape it was. The full text is in the audit
    // log; this list exists to answer "did it go out", not to re-read
    // the message.
    //
    // THE HEADLINE WINS OVER THE CONTENT, and that order matters now that a
    // row can have both: the content of an embed row is the ping line, so
    // preferring it would show a raw `<@&1541707430910627880>` where the
    // notice's own words belong.
    preview: (r.embed_title ?? r.content ?? '').slice(0, 140),
    ping: r.ping,
    state: r.sent_at ? ('sent' as const) : r.failed_at ? ('failed' as const) : ('queued' as const),
    error: r.last_error,
    discordMessageId: r.discord_message_id,
  }));
}
