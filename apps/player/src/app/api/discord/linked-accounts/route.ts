import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordOfficer } from '@/lib/discord-officer';

export const dynamic = 'force-dynamic';

// The picker behind /forceunlink and /forceupdate: connected Discord accounts,
// by member name.
//
// ---- WHY NEITHER EXISTING ROUTE COULD SERVE IT ----
//
// /api/discord/handles reads get_leaderboard(), and its header makes that
// equivalence load-bearing: the set it suggests is exactly the set /profile
// could already find. It therefore excludes pending, suspended and hidden
// members, and it carries no discord_user_id at all. /api/discord/members
// carries the snowflakes but deliberately no names, and it is the nightly
// sweep's hot path. The officer commands need precisely what neither has: a
// name beside a snowflake, for every connected account including the ones the
// ladder hides, because a member who has LEFT the server with their link row
// intact is the single most likely reason an officer reaches for /forceunlink.
//
// ---- WHICH IS EXACTLY WHY IT CARRIES THE SAME CAPABILITY CHECK ----
//
// AN UNGATED LIST OF EVERY LINKED MEMBER IS AN ORACLE. It would name hidden and
// suspended members, with their Discord accounts beside them, to anybody who
// can reach the route with the service secret. The force-link route refuses to
// build that oracle in the other direction, where the capability check sits
// above the handle lookup for the same reason. The check here is not tidiness
// on top of a harmless read: the read is the disclosure.
//
// The bot's handler answers a refusal with an EMPTY list rather than an error,
// which is the other half of the same argument: an error would itself confirm
// that rows exist.
//
// ---- THE WHOLE TABLE, THEN FILTERED HERE ----
//
// Not a PostgREST filter on the embedded players row. The sweep already reads
// this entire table on every pass (members/route.ts), so the cost is known and
// small, and a filter that has to reach through an embedding to match a name
// case-insensitively is the kind of query that silently returns nothing when
// the embedding shape changes. Matching in JavaScript keeps the ranking, the
// snowflake match and the cap in one readable place.

/** Why the app declined. A closed set; the bot matches it and never prints it. */
type Refusal = 'not_linked' | 'not_permitted';

// Discord refuses an autocomplete response carrying more than this: the WHOLE
// response, not the surplus rows. It is also the reason a raw snowflake has to
// stay acceptable downstream, because past 25 the picker cannot offer everybody.
const MAX_CHOICES = 25;

/** A 200 carrying a code, for the reason the force-unlink route's header gives. */
function refuse(refusal: Refusal) {
  return NextResponse.json({ ok: false, refusal });
}

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : '');

  // The CALLER, as everywhere else on this surface. There is no target here:
  // the target is what the officer is about to choose.
  const discordUserId = str('discordUserId').trim();
  if (!discordUserId) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const supabase = createServiceRoleClient();

  const officer = await resolveDiscordOfficer(supabase, discordUserId);
  if (!officer.ok) {
    if (officer.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return refuse(officer.refusal);
  }

  const { data, error } = await supabase
    .from('player_discord_links')
    .select('discord_user_id, players!inner(full_name, status)');

  if (error) {
    console.error('[discord] linked-accounts read failed:', error.message);
    return NextResponse.json({ error: 'accounts_unavailable' }, { status: 503 });
  }

  const rows = (data ?? []) as unknown as {
    discord_user_id: string;
    players?: { full_name: string | null; status: string | null } | null;
  }[];

  const query = str('query').trim().toLowerCase();
  // A QUERY THAT IS ALL DIGITS IS MATCHED AGAINST THE SNOWFLAKE TOO, so an
  // officer who pasted an id out of Discord finds its row rather than an empty
  // picker. Names are never all digits, so this costs the name match nothing.
  const numeric = query.length > 0 && /^\d+$/.test(query);

  const matches = rows.filter((row) => {
    if (!query) return true;
    if (numeric && row.discord_user_id.includes(query)) return true;
    return (row.players?.full_name ?? '').toLowerCase().includes(query);
  });

  return NextResponse.json({
    ok: true,
    choices: matches.slice(0, MAX_CHOICES).map((row) => ({
      // THE VALUE IS THE SNOWFLAKE, which is what both consumers already want:
      // the force-unlink delete keys on discord_user_id and the bot's resync
      // takes snowflakes. The picker hands over exactly that, so nothing
      // downstream has to translate a choice back into an id.
      value: row.discord_user_id,
      // The status and the snowflake are the disambiguator: two members can
      // share a name, and an officer about to disconnect somebody should be
      // able to see which account they picked. Truncated because Discord
      // refuses a choice name over 100 characters, and refusing it takes the
      // whole response down rather than that one row.
      name: `${row.players?.full_name ?? 'Unnamed member'} (${
        row.players?.status ?? 'unknown'
      }) ${row.discord_user_id}`.slice(0, 100),
    })),
  });
}
