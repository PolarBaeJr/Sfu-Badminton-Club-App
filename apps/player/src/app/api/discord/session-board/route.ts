import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Where the self-updating session board is, and what the bot last did to it.
//
// A SECOND WRITE PATH INTO discord_settings, bypassing the settings route's
// whitelist, and that is why it is held to the same standard: the whitelist over
// there is the security boundary of that route, and an endpoint that let a
// holder of the service secret write arbitrary config would be an
// arbitrary-config-write primitive dressed up as a settings form. This one
// touches exactly ONE key, validates every field of it, and refuses anything it
// does not recognise.
//
// The channel the board lives in is NOT written here. That is
// session_board_channel_id, an ordinary channel setting an exec sets with
// /config channels, and it is read here only so the tick can compare it with
// where the message it already posted actually is.

const CHANNEL_KEY = 'session_board_channel_id';
const STATE_KEY = 'session_board_state';

const SNOWFLAKE = /^\d{17,20}$/;
// The bot's fingerprint is a truncated sha256, so hex and nothing else. Bounded
// on both ends rather than merely "looks hex": an empty string would compare
// unequal to every render and make the board edit itself on every tick.
const FINGERPRINT = /^[0-9a-f]{8,64}$/;

/**
 * WHAT THE BOARD MAY REMEMBER, WHICH IS THE POINT OF THIS ROUTE.
 *
 * The public board is always page 1 and its totals are recomputed on every tick,
 * so there is no page, no filter and no search to store. That is a structural
 * property rather than a convention because of `unknown_field` below: a later
 * change cannot smuggle a `page` in here without this route refusing it, and
 * without per-message page state there is nothing for the tick to fight with
 * when a reader is part way through their own private copy.
 */
interface BoardState {
  /** Where the message actually is, which is not always the configured channel. */
  channelId: string;
  messageId: string | null;
  /** A post was started and not confirmed. The tick refuses to post again. */
  pending: boolean;
  fingerprint: string | null;
  postedAt: string | null;
  reposts: number;
  repostWindowStart: string | null;
}

const FIELDS = [
  'channelId',
  'messageId',
  'pending',
  'fingerprint',
  'postedAt',
  'reposts',
  'repostWindowStart',
] as const;

function timestampProblem(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return `${field}: not a timestamp`;
  }
  return null;
}

/**
 * Field by field, and every key checked against the list.
 *
 * Returns the problem rather than throwing so both callers can use it: the POST
 * turns it into a 400, and the GET turns it into a 503 rather than answering
 * with a state it cannot vouch for.
 */
function stateProblem(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return 'not an object';
  }
  const state = input as Record<string, unknown>;

  for (const key of Object.keys(state)) {
    if (!(FIELDS as readonly string[]).includes(key)) return `unknown field ${key}`;
  }

  if (typeof state.channelId !== 'string' || !SNOWFLAKE.test(state.channelId)) {
    return 'channelId: not a channel id';
  }
  if (
    state.messageId !== null &&
    (typeof state.messageId !== 'string' || !SNOWFLAKE.test(state.messageId))
  ) {
    return 'messageId: not a message id';
  }
  if (typeof state.pending !== 'boolean') return 'pending: not a boolean';
  if (
    state.fingerprint !== null &&
    (typeof state.fingerprint !== 'string' || !FINGERPRINT.test(state.fingerprint))
  ) {
    return 'fingerprint: not a fingerprint';
  }
  if (!Number.isInteger(state.reposts) || (state.reposts as number) < 0) {
    return 'reposts: not a count';
  }

  const postedAt = timestampProblem('postedAt', state.postedAt);
  if (postedAt) return postedAt;
  return timestampProblem('repostWindowStart', state.repostWindowStart);
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from('discord_settings')
    .select('key, value')
    .in('key', [CHANNEL_KEY, STATE_KEY]);

  // NAMED, NEVER DEGRADED TO AN EMPTY ANSWER, and here that rule has teeth
  // beyond the usual diagnosability argument. A failed PostgREST read arrives as
  // data:null with an error rather than throwing, and { channelId: null } reads
  // to the tick as "the club took the board down", which is the branch that
  // deletes the message and forgets the state. A read fault must never be able
  // to retract a working board.
  if (error) {
    console.error('[discord] session board read failed:', error.message);
    return NextResponse.json(
      { error: 'session_board_unavailable', detail: error.message },
      { status: 503 }
    );
  }

  const rows = (data ?? []) as { key: string; value: string | null }[];
  const channelId = rows.find((r) => r.key === CHANNEL_KEY)?.value ?? null;
  const raw = rows.find((r) => r.key === STATE_KEY)?.value ?? null;

  let state: BoardState | null = null;
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Same hazard as the read error above, so the same answer: a row that
      // cannot be parsed is not the same thing as no row, and treating it as one
      // would take down the board it describes. Recovery is /config clear.
      console.error('[discord] session board state is not JSON');
      return NextResponse.json({ error: 'session_board_state_unreadable' }, { status: 503 });
    }
    const problem = stateProblem(parsed);
    if (problem) {
      console.error('[discord] session board state is malformed:', problem);
      return NextResponse.json(
        { error: 'session_board_state_unreadable', detail: problem },
        { status: 503 }
      );
    }
    state = parsed as BoardState;
  }

  return NextResponse.json({ channelId, state });
}

// ONE KEY, ONE ROW, ONE WRITE. The whole state goes in as a single JSON string
// so it can never be half applied: the tick's correctness rests on `pending` and
// `messageId` being written together, and a shape that spread them over several
// rows would have a window in which a crash left a board it could not see.
//
// `{ state: null }` deletes the row, matching the settings route's convention
// that a null value is the only form every reader agrees means "not configured".
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || !('state' in body)) {
    return NextResponse.json({ error: 'invalid_state' }, { status: 400 });
  }

  const { state } = body as { state: unknown };
  const supabase = createServiceRoleClient();

  if (state === null) {
    const { error } = await supabase.from('discord_settings').delete().eq('key', STATE_KEY);
    if (error) {
      console.error('[discord] session board clear failed:', error.message);
      return NextResponse.json({ error: 'write_failed', detail: error.message }, { status: 503 });
    }
    return NextResponse.json({ ok: true, cleared: true });
  }

  const problem = stateProblem(state);
  if (problem) {
    // `unknown_field` is deliberately its own code rather than a generic
    // rejection: it is the answer a change that tried to store a page would get,
    // and naming it is how the next reader finds this comment.
    const code = problem.startsWith('unknown field') ? 'unknown_field' : 'invalid_state';
    return NextResponse.json({ error: code, detail: problem }, { status: 400 });
  }

  const { error } = await supabase
    .from('discord_settings')
    .upsert({ key: STATE_KEY, value: JSON.stringify(state) }, { onConflict: 'key' });

  if (error) {
    console.error('[discord] session board write failed:', error.message);
    return NextResponse.json({ error: 'write_failed', detail: error.message }, { status: 503 });
  }

  return NextResponse.json({ ok: true, cleared: false });
}
