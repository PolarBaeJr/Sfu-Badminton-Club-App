import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { clubToday } from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { onPublicTracks, onVisibleTracks } from '@/lib/session-track-filter';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// YYYY-MM-DD in club time. en-CA formats as ISO, which is what `date` stores.
function clubLocalToday(): string {
  // clubToday rather than asking Intl here: from 2026-11-01 BC is UTC-7
  // year-round (tzdata 2026b) and production Node predates that release, so
  // the answer would be an hour off — enough to cross midnight — for every
  // date past the cutover. One implementation, pinned.
  return clubToday();
}

// PINNED AT 10 by the Discord side rather than chosen here: /sessionpost and the
// self-updating session board both render page 1 of this into a public channel,
// so another value silently changes the size of that post. The pager reaches the
// rest.
const PAGE_SIZE = 10;

// The window every total is computed from. The count below is exact up to this
// many rows and undercounts past it, which is what `windowCapReached` exists to
// report: the fix for a club that outgrows the window is to raise it, not to
// paper over a short last page.
const FETCH_CAP = 60;

/**
 * A short, stable id for one location.
 *
 * THE ROUTE OWNS THIS and the bot only ever echoes back an id it was handed.
 * `location` is unbounded TEXT and may contain the separator the bot's button id
 * grammar splits on, so the raw value cannot travel in a custom_id; and a hash
 * computed on both sides would be two implementations that must never drift.
 * Grouping is on the trimmed, case-folded value so one gym written two ways does
 * not become two options.
 */
function locationId(location: string): string {
  return createHash('sha256').update(location.trim().toLowerCase()).digest('hex').slice(0, 8);
}

// Upcoming sessions for the Discord bot.
//
// TRACK FILTERING GOES THROUGH onVisibleTracks AND MUST STAY THAT WAY.
// session-track-filter.ts is the only place in this app allowed to name `track`
// in a filter, and session-track-filter.test.ts greps apps/player/src to enforce
// exactly one occurrence. Naming that column in a PostgREST filter here would
// fail that test — which is the point: six call sites had already drifted
// independently before the rule existed. (The grep is deliberately crude enough
// to match a comment, so this one describes the forbidden call rather than
// spelling it out.)
//
// FILTERED PER CALLER, which is what the phase-1 version of this comment said
// would happen once linking landed. It has, so it does.
//
// The caller arrives as `x-discord-user-id` on a request already gated by the
// service secret. A HEADER RATHER THAN A QUERY PARAM on purpose: the kong access
// log records paths and query strings, and a Discord user id in there is a
// per-person identifier sitting in a log nobody thinks of as personal data. The
// page, search and location parameters read below are deliberately NOT held to
// that rule: a page number, a session name and a gym are club data, not a
// person.
//
// Three audiences, not two, which is the part worth reading twice:
//
//   linked + competitive/recreational -> that track plus club-wide. Identical
//       to what the website shows them. This is the reported bug: a rec member
//       was being shown competitive nights the site would never show them.
//   linked + pending_approval/suspended/unknown -> the whole schedule, via
//       visibleTracksFor's untracked default. NOT narrowed. session-track.ts
//       argues that case at length (the frosh-week signup who would otherwise
//       see an empty schedule) and it is still right; they are members.
//   unlinked -> club-wide nights only. See PUBLIC_TRACKS: the reasoning behind
//       the untracked-member default is scoped to `authenticated` viewers who
//       can read every session row anyway, and somebody who joined the Discord
//       without ever making an account is not one.
//
// The bot makes the reply ephemeral as well. Neither half is sufficient alone —
// filtering a message the whole channel can read changes nothing, and hiding an
// unfiltered message just moves the leak.
//
// PAGING, SEARCH AND THE LOCATION FILTER ALL LIVE HERE rather than in the bot,
// because this file is type-checked and the bot's own tests are not. The order
// they are applied in is not a style choice: the caller narrowing decides what
// may be seen at all, the search and the location narrow that further, and the
// page arithmetic has to be computed over whatever is actually displayed. The
// totals travel with the rows because the bot has one app call per interaction
// and cannot discover totalPages any other way.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const supabase = createServiceRoleClient();

  const params = new URL(request.url).searchParams;
  const requestedPage = Number.parseInt(params.get('page') ?? '1', 10);
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const requestedLocation = params.get('location') ?? '';

  // Who is asking. Absent for an unlinked caller, and absent is a real answer
  // here rather than a missing one, so it is not an error.
  const discordUserId = request.headers.get('x-discord-user-id');
  let status: string | null = null;
  let linked = false;

  if (discordUserId) {
    const { data, error: linkError } = await supabase
      .from('player_discord_links')
      .select('players!inner(status)')
      .eq('discord_user_id', discordUserId)
      .maybeSingle();

    if (linkError) {
      // FAIL CLOSED. A failed PostgREST read arrives as data:null with an error
      // rather than a throw, so without this branch a broken read would look
      // exactly like "not linked" — except the consequence of guessing wrong is
      // inverted from the usual one: guessing "not linked" narrows the schedule,
      // which is safe, while a bug in the other direction would widen it. Take
      // the safe reading, and report it so it does not stay invisible.
      Sentry.captureException(linkError, {
        extra: { route: 'discord/sessions', step: 'link-lookup' },
      });
    } else if (data) {
      linked = true;
      // Not generic over Database, so the embedded row is any. Annotated here.
      status = (data as unknown as { players: { status: string } }).players.status;
    }
  }

  const query = supabase
    .from('sessions')
    // count:'exact' because the fetch window means the rows CANNOT answer "how
    // many are there": row 61 is never fetched, so a caller counting what
    // arrived would report the cap. PostgREST counts against the filters and
    // ignores the limit, and the narrowing below is applied to this same
    // builder, so the total is scoped to what this caller may see. That scoping
    // is the point: an unnarrowed count would publish how many private-track
    // nights exist.
    .select('id, name, date, start_time, end_time, starts_at, ends_at, location, status, track', {
      count: 'exact',
    })
    .eq('status', 'open')
    // ends_at is GENERATED and is NULL for exactly one real case (00110): a
    // session with a start time and no end time, which closes at starts_at plus
    // the runtime default_duration_minutes. A bare .gte('ends_at', now) drops
    // every one of those from the schedule silently, which is the sort of
    // absence nobody reports as a bug. Rows that HAVE an end instant are still
    // filtered on it precisely; the rest fall back to the club-local date, the
    // same column the app's own check-in path filters on for the same reason.
    .or(`ends_at.gte.${new Date().toISOString()},and(ends_at.is.null,date.gte.${clubLocalToday()})`)
    .order('starts_at', { ascending: true })
    .limit(FETCH_CAP);

  const { data: sessions, error, count } = await (linked
    ? onVisibleTracks(query, status)
    : onPublicTracks(query));

  if (error) {
    Sentry.captureException(error, { extra: { route: 'discord/sessions' } });
    return NextResponse.json({ error: 'sessions_unavailable' }, { status: 502 });
  }

  const rows = sessions ?? [];
  // `linked` travels with the payload so the bot can tell an unlinked caller WHY
  // their list is short, instead of them seeing a thin schedule and concluding
  // the club has nothing on. The paging fields travel on this branch too: a bot
  // rendering a footer from `undefined` prints "Page 1 of undefined".
  if (rows.length === 0) {
    return NextResponse.json({
      sessions: [],
      linked,
      page: 1,
      totalPages: 1,
      total: 0,
      query: null,
      location: null,
      locations: [],
    });
  }

  // The distinct locations in the WINDOW, not on the page: options built from
  // the page would drop a gym simply because it has nothing on in the next ten.
  const locations: { id: string; label: string }[] = [];
  const seenLocations = new Set<string>();
  for (const row of rows) {
    const label = row.location?.trim();
    if (!label) continue;
    const id = locationId(label);
    if (seenLocations.has(id)) continue;
    seenLocations.add(id);
    // Discord caps a select option label at 100 characters.
    locations.push({ id, label: label.slice(0, 100) });
  }

  // An id that no longer resolves to anything upcoming is dropped rather than
  // honoured, and the echo below is how the bot learns to say so. The unfiltered
  // page is the safe answer here because the caller narrowing has already been
  // applied above: widening past it is not reachable from this line.
  const appliedLocation =
    requestedLocation && seenLocations.has(requestedLocation) ? requestedLocation : null;

  const matched = rows.filter((row) => {
    if (q) {
      // Plain includes, never a regex and never an ilike: no wildcard to escape
      // and nothing for a crafted string to backtrack on.
      const name = (row.name ?? '').toLowerCase();
      const where = (row.location ?? '').toLowerCase();
      if (!name.includes(q) && !where.includes(q)) return false;
    }
    if (appliedLocation) {
      const label = row.location?.trim();
      if (!label || locationId(label) !== appliedLocation) return false;
    }
    return true;
  });

  // A SEARCH ANSWERS WITH THE MATCHES, ON ONE PAGE. Session names repeat weekly,
  // so "Club night" matches rows spread over every page, and jumping to the page
  // holding the first one hides the rest. `total` still reports the full match
  // count, so the reply can say the list was trimmed.
  const total = q || appliedLocation ? matched.length : count ?? rows.length;
  const totalPages = q ? 1 : Math.max(1, Math.ceil(Math.min(total, FETCH_CAP) / PAGE_SIZE));
  // Clamped at BOTH ends, so a button minted against a longer list lands on the
  // last real page rather than on nothing.
  const page = Math.min(
    Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1),
    totalPages
  );
  const pageRows = matched.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE);

  // Attendee counts come from the RPC rather than a join so the bot and the
  // website agree on what "going" counts as. Only the page's rows are rendered,
  // so only the page's counts are asked for, and a filter that matched nothing
  // needs no round trip at all.
  const pageIds = pageRows.map((s) => s.id);
  const { data: counts, error: countError } = pageIds.length
    ? await supabase.rpc('get_session_attendee_counts', { p_session_ids: pageIds })
    : { data: null, error: null };

  if (countError) {
    // A missing count is cosmetic; the schedule is still worth returning. Report
    // it, degrade to null, and let the bot omit the number rather than 502 the
    // whole command over a subtotal.
    Sentry.captureException(countError, { extra: { route: 'discord/sessions' } });
  }

  // createServiceRoleClient() is not generic over Database, so .rpc() is `any`.
  // Annotate at the boundary rather than trusting the shape silently.
  const goingBySession = new Map<string, number>(
    ((counts ?? []) as { session_id: string; attendees: number }[]).map((c) => [
      c.session_id,
      c.attendees,
    ])
  );

  return NextResponse.json({
    linked,
    page,
    totalPages,
    // Exact from the count on an unfiltered read, and the filtered match count
    // otherwise. Falls back to the rows on a null count so the bot degrades to
    // "showing 10" rather than announcing "showing 10 of 0", which is the one
    // wrong number a truncation notice must never print.
    total,
    // ECHOES, and the bot checks them. The two images deploy independently, so a
    // bot asking a player build that predates either filter would otherwise
    // frame an unfiltered page as a search result, which is a wrong answer
    // rather than a cosmetic one.
    query: q || null,
    location: appliedLocation,
    locations,
    // Set only when the window came back full, which is the single condition
    // under which `total` undercounts and the pages stop short of the schedule.
    ...(rows.length >= FETCH_CAP ? { windowCapReached: true } : {}),
    sessions: pageRows.map((s) => ({
      id: s.id,
      name: s.name,
      date: s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      startsAt: s.starts_at,
      location: s.location,
      track: s.track,
      going: goingBySession.get(s.id) ?? null,
    })),
  });
}
