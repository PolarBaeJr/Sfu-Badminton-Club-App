import { NextResponse } from 'next/server';
import { CLUB_TIMEZONE, getClientIp, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Upcoming tournaments, for /tournaments in Discord.
//
// WHY THIS IS NOT THE SAME PROBLEM AS /sessions, even though both are lists.
//
// /sessions had a real leak: `sessions.track` narrows what the website shows a
// member, and the bot was not applying it, so a recreational member saw
// competitive nights the site would never have shown them. Tournaments have no
// equivalent. `scope` — the column that looked like eligibility — was DROPPED
// in 00109 precisely because it "renders a badge and gates NOTHING", and the
// website's tournament list applies no per-member filter at all. Filtering here
// would make Discord show LESS than the site, which is its own kind of wrong.
//
// WHAT IS REAL is `allowed_memberships`: the player registration path reads it
// and refuses entry. That is an ENTRY rule, not a visibility rule — an external
// member should still see that the internal-only tournament exists, the same as
// on the website — so it is reported as a note rather than used to hide rows.
// Telling somebody why they cannot enter beats them finding out at the click.
//
// DRAFTS ARE EXCLUDED. RLS on tournaments is USING (TRUE) so a draft is
// technically readable, but draft is where an exec assembles one before anyone
// is meant to see it, and "active" is what the club means by public.
//
// The reply is ephemeral on the bot side as well. Neither half is sufficient:
// annotating a message the whole channel reads tells the channel who is
// ineligible, which is nobody's business.

const MAX_TOURNAMENTS = 10;

interface Row {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  allowed_memberships: string[] | null;
  tournament_events: { event_type: string; status: string }[] | null;
}

function clubLocalToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:tournaments:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  // Who is asking. A HEADER rather than a query param, for the reason the
  // sessions route spells out: the kong access log records query strings, and a
  // Discord user id there is a per-person identifier in a log nobody thinks of
  // as personal data. Absent is a real answer, not a missing one.
  const discordUserId = request.headers.get('x-discord-user-id');
  let membership: string | null = null;
  let linked = false;

  if (discordUserId) {
    const { data, error: linkError } = await supabase
      .from('player_discord_links')
      .select('players!inner(membership_type)')
      .eq('discord_user_id', discordUserId)
      .maybeSingle();

    if (linkError) {
      // NOT degraded to "unlinked". Treating a failed lookup as "no account"
      // would quietly drop the eligibility note for a member who has one, and
      // the list would look right while being less useful than it should be.
      console.error('[discord] tournaments link lookup failed:', linkError.message);
      return NextResponse.json({ error: 'link_lookup_failed' }, { status: 503 });
    }

    const player = data?.players as { membership_type?: string } | undefined;
    if (player) {
      linked = true;
      membership = player.membership_type ?? null;
    }
  }

  // Anything not finished yet: a multi-day tournament running right now is
  // still upcoming as far as a member is concerned, so the filter is on the
  // LAST day rather than the first. end_date is nullable, and a null one means
  // a single-day event, which coalesce handles at the database rather than by
  // pulling the whole table back to sort it out here.
  const today = clubLocalToday();
  const { data, error } = await supabase
    .from('tournaments')
    .select(
      'id, name, start_date, end_date, allowed_memberships, tournament_events(event_type, status)'
    )
    .eq('status', 'active')
    .is('suspended_at', null)
    .or(`end_date.gte.${today},and(end_date.is.null,start_date.gte.${today})`)
    .order('start_date', { ascending: true })
    .limit(MAX_TOURNAMENTS);

  if (error) {
    console.error('[discord] tournaments read failed:', error.message);
    return NextResponse.json({ error: 'tournaments_unavailable' }, { status: 503 });
  }

  const tournaments = ((data ?? []) as Row[]).map((t) => {
    const allowed = t.allowed_memberships ?? [];
    return {
      id: t.id,
      name: t.name,
      startDate: t.start_date,
      endDate: t.end_date,
      events: (t.tournament_events ?? []).map((e) => e.event_type),
      // Registration is open somewhere in this tournament. Reported rather than
      // used to filter: a member wants to know the thing exists even once the
      // draws are locked.
      registrationOpen: (t.tournament_events ?? []).some((e) => e.status === 'registration'),
      // null for an unlinked caller — "we do not know", which is a different
      // thing from "not eligible" and the bot renders it differently.
      eligible: membership ? allowed.length === 0 || allowed.includes(membership) : null,
    };
  });

  return NextResponse.json({ tournaments, linked });
}
