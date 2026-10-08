import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// The messages the console has asked the bot to post, and the record of what
// happened to each.
//
// THE APP DECIDES, THE BOT POSTS, one more time. The console writes a row
// (00222); the bot drains it on the announcements tick and comes back here to
// say what Discord did.
//
// GET IS A CLAIM, NOT A READ, and it has to be. The bot runs at N replicas and
// the tick lands on whichever one the proxy picks, so two overlapping ticks are
// two different processes reading the same table. A plain SELECT would hand the
// same message to both and post it twice, in a channel every member reads.
//
// The claim is one UPDATE ... RETURNING, which is atomic per row: a second
// claimant blocks on the row lock, then re-evaluates the predicate against the
// committed value under READ COMMITTED, finds claimed_at set, and takes
// nothing. No advisory lock, no queue table, no second round trip.

/** How long a claim is honoured before the row is offered again. */
const CLAIM_MINUTES = 10;

/**
 * Three tries, then it stops.
 *
 * A message Discord keeps refusing — a channel the bot was removed from, a
 * permission taken away — must not be retried every five minutes forever. The
 * console shows the last error, which is the only thing that will actually get
 * it fixed.
 */
const MAX_ATTEMPTS = 3;

/** Never more than this per tick, so one burst cannot hold the tick open. */
const MAX_PER_TICK = 10;

interface OutboxRow {
  id: string;
  channel_id: string;
  content: string | null;
  embed_title: string | null;
  embed_body: string | null;
  embed_type: string | null;
  ping: boolean;
  attempts: number;
  requested_by: string | null;
  /**
   * The message this row already became in Discord, when it has been posted.
   *
   * IT IS WHAT TURNS A POST INTO AN EDIT. The console re-queues a sent row with
   * new text and leaves this alone, so a claimed row carrying an id is a
   * correction to a message members can already read, and the bot PATCHes it
   * instead of posting a second copy underneath the first.
   */
  discord_message_id: string | null;
  /** The NAME of a button set the bot knows (00227), never a Discord payload. */
  button_set: string | null;
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const now = new Date();
  const staleClaim = new Date(now.getTime() - CLAIM_MINUTES * 60_000).toISOString();

  // WHY THE ROWS ARE PICKED FIRST AND CLAIMED SECOND. PostgREST has no
  // "UPDATE ... LIMIT", so an unbounded UPDATE would claim every pending
  // message in one go — including ones this tick has no intention of posting,
  // which would then sit claimed for ten minutes doing nothing.
  //
  // The SELECT is therefore a CANDIDATE list and nothing more. It is allowed to
  // be stale: the UPDATE below re-states every condition, so a row another
  // replica claimed between the two statements simply does not come back. The
  // read cannot cause a double post; only the write decides.
  const { data: candidates, error: readError } = await supabase
    .from('discord_outbox')
    .select('id')
    .eq('guild_id', guildId)
    .is('sent_at', null)
    .is('failed_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .or(`claimed_at.is.null,claimed_at.lt.${staleClaim}`)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_TICK);

  if (readError) {
    // NAMED, never degraded to an empty list. A failed PostgREST read comes
    // back as data:null with no throw, and reporting "nothing queued" would
    // make a broken table look like an idle one — which is how this codebase
    // has been bitten three separate times.
    console.error('[discord] outbox read failed:', readError.message);
    return NextResponse.json({ error: 'outbox_unavailable', detail: readError.message }, { status: 503 });
  }

  const ids = ((candidates ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return NextResponse.json({ messages: [] });

  const { data: claimed, error: claimError } = await supabase
    .from('discord_outbox')
    .update({ claimed_at: now.toISOString() })
    .in('id', ids)
    // EVERY CONDITION RESTATED. This is the line that makes the claim safe, and
    // dropping any of it turns the read above from a hint into a race.
    .is('sent_at', null)
    .is('failed_at', null)
    .lt('attempts', MAX_ATTEMPTS)
    .or(`claimed_at.is.null,claimed_at.lt.${staleClaim}`)
    .select(
      'id, channel_id, content, embed_title, embed_body, embed_type, ping, attempts, requested_by, discord_message_id, button_set'
    );

  if (claimError) {
    console.error('[discord] outbox claim failed:', claimError.message);
    return NextResponse.json({ error: 'outbox_unavailable', detail: claimError.message }, { status: 503 });
  }

  const rows = (claimed ?? []) as OutboxRow[];

  // WHO ASKED, resolved here because the bot has no players table and the audit
  // entry it writes has to name somebody. A message posted in the club's voice
  // with no record of who moved its mouth is the thing /say exists not to be,
  // and the console must not be the back door around that.
  //
  // A SECOND READ RATHER THAN AN EMBED on the UPDATE above: the claim is the one
  // statement in this file that must not fail for an avoidable reason, and it is
  // already the least-travelled PostgREST path here. This read runs only when
  // there is something to post.
  //
  // ITS FAILURE IS NOT THIS REQUEST'S FAILURE. The rows are already claimed; a
  // 503 now would strand them for the full CLAIM_MINUTES. A missing name costs
  // an audit entry that says "someone in the console", which is still the entry.
  const requesterIds = [...new Set(rows.map((r) => r.requested_by).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (requesterIds.length > 0) {
    const { data: players, error: nameError } = await supabase
      .from('players')
      .select('id, full_name')
      .in('id', requesterIds);
    if (nameError) {
      console.error('[discord] outbox requester lookup failed:', nameError.message);
    }
    for (const p of (players ?? []) as { id: string; full_name: string | null }[]) {
      if (p.full_name) names.set(p.id, p.full_name);
    }
  }

  return NextResponse.json({
    messages: rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      content: r.content,
      embed: r.embed_title
        ? { title: r.embed_title, body: r.embed_body ?? '', type: r.embed_type ?? 'info' }
        : null,
      ping: r.ping,
      attempts: r.attempts,
      discordMessageId: r.discord_message_id,
      buttonSet: r.button_set,
      requestedBy: (r.requested_by && names.get(r.requested_by)) || null,
    })),
  });
}

// What Discord did with it.
//
// TWO OUTCOMES AND NO THIRD. `sent` closes the row for good; `failed` records
// the reason and returns it to the pool with one attempt spent, so a transient
// refusal is retried and a permanent one stops after MAX_ATTEMPTS with the
// error still readable in the console.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : null;
  const discordMessageId =
    typeof body.discordMessageId === 'string' ? body.discordMessageId : null;
  const error = typeof body.error === 'string' ? body.error : null;
  // A NOTE IS NOT A THIRD OUTCOME. It rides along with `discordMessageId` on a
  // message that DID go out, and says something about it the sender should know:
  // today, that Discord took the words and refused the buttons.
  const note = typeof body.note === 'string' ? body.note : null;

  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 });
  if (!discordMessageId && !error) {
    return NextResponse.json({ error: 'outcome_required' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  if (discordMessageId) {
    const { error: writeError } = await supabase
      .from('discord_outbox')
      .update({
        sent_at: new Date().toISOString(),
        discord_message_id: discordMessageId,
        // THE NOTE OCCUPIES `last_error`, AND THE ROW IS STILL A SENT ONE:
        // `sent_at` and the message id are written and `failed_at` stays null.
        // Bounded like the failure path, because the column has the same CHECK.
        //
        // It reaches the screen for nothing: `readOutboxRows` maps
        // `error: r.last_error` and DiscordRecent renders it in red under any
        // row whatever the badge says. So `error !== null` no longer implies a
        // failure, which is the intended cost.
        last_error: note ? note.slice(0, 500) : null,
      })
      .eq('id', id)
      // ONLY IF IT IS STILL UNSENT. Recording a send twice would be harmless,
      // but this also means a row somebody cancelled cannot be re-opened by a
      // late write-back from a bot that was already mid-post.
      .is('sent_at', null);

    if (writeError) {
      // LOUD. The message is already in the channel; a failed write-back leaves
      // it claimable again in ten minutes, and the next tick posts a SECOND
      // copy of something the club said out loud.
      console.error('[discord] outbox send NOT recorded:', writeError.message);
      return NextResponse.json({ error: 'record_failed' }, { status: 503 });
    }

    return NextResponse.json({ ok: true });
  }

  // A FAILURE SPENDS AN ATTEMPT AND RELEASES THE CLAIM. Read-then-write rather
  // than an atomic increment because PostgREST cannot express `attempts + 1`,
  // and a lost increment here costs one extra retry of a message that is
  // already failing — the mildest possible consequence of a race.
  const { data: current } = await supabase
    .from('discord_outbox')
    .select('attempts')
    .eq('id', id)
    .maybeSingle();

  const attempts = ((current?.attempts as number | null) ?? 0) + 1;

  const { error: writeError } = await supabase
    .from('discord_outbox')
    .update({
      attempts,
      claimed_at: null,
      // Bounded, because this is another service's words and they end up on a
      // page. The column has the same CHECK.
      last_error: error!.slice(0, 500),
      // Out of the pool for good once the budget is spent, with the reason
      // still readable.
      ...(attempts >= MAX_ATTEMPTS ? { failed_at: new Date().toISOString() } : {}),
    })
    .eq('id', id)
    .is('sent_at', null);

  if (writeError) {
    console.error('[discord] outbox failure NOT recorded:', writeError.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
