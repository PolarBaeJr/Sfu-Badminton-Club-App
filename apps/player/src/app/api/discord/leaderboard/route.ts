import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

// Which column ranks each ladder. `points` is the tournament column and is a
// third ladder, not a blend of the other two — singles and doubles Elo are not
// comparable, so there is deliberately no "overall".
const LADDERS = {
  singles: 'singles_elo',
  doubles: 'doubles_elo',
  points: 'tournament_points',
} as const;

type Ladder = keyof typeof LADDERS;

// Doubles is the default because it is the ladder most club play feeds.
const DEFAULT_LADDER: Ladder = 'doubles';

// Club ladder for the Discord bot.
//
// FILTERING IS THE DATABASE'S JOB AND IS ALREADY DONE. get_leaderboard() ends
// with `active_flag = TRUE AND hide_from_leaderboard = FALSE AND status NOT IN
// ('pending_approval','suspended')`. Re-filtering here would put the club's
// visibility rules in a second place, where they would drift — the exact failure
// this whole API pattern exists to avoid. If a player should be hidden from the
// bot, hide them from the function.
//
// What the function does NOT do is order or paginate: it takes no arguments and
// returns every eligible player in one shot. That is fine for the website, which
// renders the whole table, and is why the slice has to happen here rather than in
// the bot — a bot that fetched the whole club and sliced locally would ship the
// full roster over the wire to render ten rows.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const url = new URL(request.url);
  const requested = url.searchParams.get('ladder');
  const ladder: Ladder =
    requested && requested in LADDERS ? (requested as Ladder) : DEFAULT_LADDER;

  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('get_leaderboard');

  if (error) {
    Sentry.captureException(error, { extra: { route: 'discord/leaderboard', ladder } });
    return NextResponse.json({ error: 'leaderboard_unavailable' }, { status: 502 });
  }

  const column = LADDERS[ladder];
  const rows = [...(data ?? [])].sort(
    (a, b) => (b[column] as number) - (a[column] as number)
  );

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;

  // Rank is computed BEFORE slicing so page 2 starts at 11, not 1.
  const entries = rows.slice(start, start + PAGE_SIZE).map((row, i) => ({
    rank: start + i + 1,
    name: row.name,
    handle: row.handle,
    rating: row[column] as number,
    // The bot must render this. A rating shown without it reads as settled when
    // it is not, and on a leaderboard posted into a channel that misreading
    // outlives the message.
    provisional:
      ladder === 'points'
        ? false
        : ladder === 'singles'
          ? row.singles_provisional
          : row.doubles_provisional,
    wins: ladder === 'singles' ? row.singles_wins : row.doubles_wins,
    losses: ladder === 'singles' ? row.singles_losses : row.doubles_losses,
    streak:
      ladder === 'singles' ? row.current_singles_streak : row.current_doubles_streak,
  }));

  return NextResponse.json({
    ladder,
    page,
    totalPages,
    totalPlayers: rows.length,
    entries,
  });
}
