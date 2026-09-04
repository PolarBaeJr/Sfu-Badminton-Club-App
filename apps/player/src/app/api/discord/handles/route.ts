import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Handles for the /profile picker.
//
// ---- THE PRIVACY INVARIANT, WHICH IS THE WHOLE REASON THIS FILE EXISTS ----
//
// This route reads get_leaderboard(), the SAME source resolveProfile's handle
// lookup reads. That equivalence is the point, not an implementation detail:
// because both sides read it, the set of handles suggested is exactly the set a
// member could already have found by typing one in full. The picker discloses
// nothing the command did not already disclose.
//
// get_leaderboard() ends with `active_flag = TRUE AND hide_from_leaderboard =
// FALSE AND status NOT IN ('pending_approval','suspended')`. Reading
// players.handle directly instead — which would look like a harmless
// simplification, and is strictly faster — would start naming members who asked
// not to be listed, in a dropdown, to anybody in the server. That is precisely
// the disclosure /profile's "no member on the club ladder has that handle" is
// worded to prevent. There is a test asserting this route calls the rpc and
// never touches the players table.
//
// NAMES AND HANDLES ONLY. Ratings, ids and everything else on the ladder row
// stay here; a picker needs enough to choose between two people with similar
// names and nothing more.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('get_leaderboard');

  if (error) {
    Sentry.captureException(error, { extra: { route: 'discord/handles' } });
    return NextResponse.json({ error: 'handles_unavailable' }, { status: 502 });
  }

  // flatMap rather than filter-then-map so the null really is gone from the
  // type: a member with no handle is one nothing can be typed to find.
  const members = [...(data ?? [])].flatMap((row) =>
    row.handle ? [{ handle: row.handle, name: row.name }] : []
  );

  return NextResponse.json({ members });
}
