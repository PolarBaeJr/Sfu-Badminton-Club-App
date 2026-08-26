import { NextResponse } from 'next/server';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  getClientIp,
  rateLimit,
  wallClockToUtc,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Which tournaments owe Discord a scheduled event, and what to do about each.
//
// THE APP DECIDES, THE BOT CALLS DISCORD. Same split as the session pings: the
// bot holds the token and nothing else, so "what counts as public" is settled
// in one place and cannot drift between the website and the server.
//
// A TOURNAMENT GOES PUBLIC WHEN IT GOES ACTIVE. `tournaments` has no "posted"
// flag — status is draft | active | completed | archived — and draft is where
// an exec assembles one before anybody is meant to see it. RLS on the table is
// USING (TRUE), so a member technically CAN read a draft on the website today,
// but announcing one in Discord is a different act from it being fetchable:
// this is the thing that pings the Events tab. Draft stays private here.
//
// THE THREE FIELDS DISCORD NEEDS THAT THE SCHEMA HAS NOT GOT. An EXTERNAL
// scheduled event requires a start instant, an end instant and a location.
// `tournaments` stores start_date and end_date as DATE and has no location
// column at all — 00109 dropped the columns that only pretended to carry this
// sort of thing. So they come from discord_settings, where the club can see
// and change them, rather than from a constant buried in here.

interface TournamentRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  status: string;
  suspended_at: string | null;
  tournament_events: { event_type: string }[] | null;
}

interface MappingRow {
  tournament_id: string;
  discord_event_id: string;
  synced_name: string;
  synced_starts_at: string;
  synced_ends_at: string;
}

const DEFAULT_START_TIME = '09:00';
const DEFAULT_END_TIME = '18:00';

// Discord truncates a scheduled-event description at 1000 characters and
// rejects anything longer outright, so the description is built to fit rather
// than sent hopefully.
const MAX_DESCRIPTION = 1000;

// A start time Discord will accept has to be in the future, and "in the future"
// is evaluated at Discord's clock, not ours. Two minutes of slack covers the
// round trip and any drift without pushing the event visibly late.
const CLAMP_SLACK_MS = 2 * 60_000;

function parseClubTime(value: string | undefined, fallback: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  const source = match ? value!.trim() : fallback;
  const [h, m] = source.split(':').map(Number) as [number, number];
  // A malformed setting falls back rather than throwing: one bad row must not
  // stop every tournament being announced, and the fallback is visible in the
  // migration's owner notes.
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) {
    const [fh, fm] = fallback.split(':').map(Number) as [number, number];
    return [fh, fm];
  }
  return [h, m];
}

function clubDateAt(date: string, [h, m]: [number, number]): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  // wallClockToUtc rather than Intl, for the reason the session-reminder job
  // documents: BC stops changing its clocks on 2026-11-01 (tzdata 2026b) and a
  // Node predating that release answers an hour out for every date past it.
  // Tournaments are scheduled a season ahead, so that is not hypothetical.
  return wallClockToUtc(y, mo, d, h, m);
}

function describe(t: TournamentRow, appUrl: string | null): string {
  const events = (t.tournament_events ?? [])
    .map(
      (e) =>
        TOURNAMENT_EVENT_TYPE_LABELS[e.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ??
        e.event_type
    )
    .filter((label, i, all) => all.indexOf(label) === i);

  const lines: string[] = [];
  if (events.length > 0) lines.push(`Events: ${events.join(', ')}`);
  // The link is what makes the Discord event useful rather than decorative —
  // entry, fees and the draw all live on the website, and none of them can be
  // done from the Events tab.
  if (appUrl) lines.push(`Enter and see the draw: ${appUrl}/tournaments/${t.id}`);

  return lines.join('\n\n').slice(0, MAX_DESCRIPTION);
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:tournament-events:${ip}`, 30, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const now = Date.now();

  const [settingsResult, mappedResult] = await Promise.all([
    supabase.from('discord_settings').select('key, value'),
    supabase
      .from('discord_tournament_events')
      .select('tournament_id, discord_event_id, synced_name, synced_starts_at, synced_ends_at')
      .eq('guild_id', guildId),
  ]);

  // BOTH NAMED, never degraded to an empty list. A failed PostgREST read
  // arrives as data:null with an error rather than a throw, and an empty
  // mapping list means "nothing has been announced yet" — which would make the
  // bot create a second Discord event for every tournament that already has
  // one, every tick, until the read recovered.
  if (settingsResult.error || mappedResult.error) {
    const detail = settingsResult.error?.message ?? mappedResult.error?.message ?? 'unknown';
    console.error('[discord] tournament-events config read failed:', detail);
    return NextResponse.json({ error: 'config_unavailable', detail }, { status: 503 });
  }

  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((s) => [s.key, s.value])
  );
  const startTime = parseClubTime(settings.get('tournament_event_start_time'), DEFAULT_START_TIME);
  const endTime = parseClubTime(settings.get('tournament_event_end_time'), DEFAULT_END_TIME);
  const location = settings.get('tournament_event_location')?.trim() || null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? null;

  const mapped = new Map(
    ((mappedResult.data ?? []) as MappingRow[]).map((m) => [m.tournament_id, m])
  );

  const columns =
    'id, name, start_date, end_date, status, suspended_at, tournament_events(event_type)';

  // TWO READS, MERGED. The announceable set is "status = active"; the
  // cancellable set is "already has a Discord event", and a tournament that has
  // just been archived is in the second and not the first. One query cannot
  // express that without an .or() over an id list long enough to blow the URL
  // length, so it is two and a merge.
  const [activeResult, knownResult] = await Promise.all([
    supabase.from('tournaments').select(columns).eq('status', 'active'),
    mapped.size > 0
      ? supabase
          .from('tournaments')
          .select(columns)
          .in('id', [...mapped.keys()])
      : Promise.resolve({ data: [] as unknown, error: null }),
  ]);

  if (activeResult.error || knownResult.error) {
    const detail = activeResult.error?.message ?? knownResult.error?.message ?? 'unknown';
    console.error('[discord] tournament-events read failed:', detail);
    return NextResponse.json({ error: 'tournaments_unavailable', detail }, { status: 503 });
  }

  const byId = new Map<string, TournamentRow>();
  for (const row of [
    ...((activeResult.data ?? []) as TournamentRow[]),
    ...((knownResult.data ?? []) as TournamentRow[]),
  ]) {
    byId.set(row.id, row);
  }

  const actions: {
    kind: 'create' | 'update' | 'cancel';
    tournamentId: string;
    discordEventId: string | null;
    name: string;
    /** What to send Discord. May be clamped forward; see below. */
    startsAt: string;
    endsAt: string;
    /** What the tournament actually says. Recorded, so the diff stays stable. */
    syncedStartsAt: string;
    syncedEndsAt: string;
    /** False once Discord has started the event and will no longer retime it. */
    patchTimes: boolean;
    location: string | null;
    description: string;
  }[] = [];
  const skipped: { tournamentId: string; reason: string }[] = [];

  for (const t of byId.values()) {
    const existing = mapped.get(t.id) ?? null;

    // ACTIVE AND UNSUSPENDED, and every other state loses its Discord event.
    //
    // Suspended counts as unannounced rather than merely paused: a suspended
    // tournament is one the club has told members is off, and leaving a live
    // event with a reminder attached contradicts that in the one place people
    // will be looking.
    //
    // Completed is in here too, which looks harsher than it is — Discord has
    // already ended the event by then, so the delete removes nothing anybody
    // can still see and frees the mapping row. Reverting to draft is the same
    // story: an exec pulling a tournament back to draft has unpublished it.
    const announceable = t.status === 'active' && t.suspended_at === null;

    if (!announceable) {
      if (existing) {
        actions.push({
          kind: 'cancel',
          tournamentId: t.id,
          discordEventId: existing.discord_event_id,
          name: t.name,
          startsAt: existing.synced_starts_at,
          endsAt: existing.synced_ends_at,
          syncedStartsAt: existing.synced_starts_at,
          syncedEndsAt: existing.synced_ends_at,
          patchTimes: false,
          location,
          description: '',
        });
      }
      continue;
    }

    const starts = clubDateAt(t.start_date, startTime);
    const ends = clubDateAt(t.end_date ?? t.start_date, endTime);

    // An end before the start is a data problem, not something to send: a
    // one-day tournament with the end time set earlier than the start time
    // would be rejected by Discord anyway, and silently rescheduling it would
    // hide the misconfiguration.
    if (ends.getTime() <= starts.getTime()) {
      skipped.push({ tournamentId: t.id, reason: 'end_before_start' });
      continue;
    }

    // Already over. Activating a tournament after its last day is a records
    // exercise — backfilling results, usually — and announcing it would put a
    // finished event in the Events tab. Recorded rather than dropped silently,
    // so a run that announces nothing can say why.
    if (ends.getTime() <= now) {
      skipped.push({ tournamentId: t.id, reason: 'already_ended' });
      continue;
    }

    // CLAMPED TO SEND, UNCLAMPED TO RECORD, and the split is deliberate.
    //
    // Discord refuses a scheduled_start_time in the past, which is the routine
    // case rather than the exotic one: drafts sit around, and an exec who
    // activates on the morning of day one has a start time hours gone. Sending
    // now+slack gets the event created. Recording the tournament's OWN value is
    // what stops the next tick seeing a difference between "what we sent" and
    // "what the row says" and PATCHing forever.
    const sendStart = new Date(Math.max(starts.getTime(), now + CLAMP_SLACK_MS));

    if (!existing) {
      actions.push({
        kind: 'create',
        tournamentId: t.id,
        discordEventId: null,
        name: t.name,
        startsAt: sendStart.toISOString(),
        endsAt: ends.toISOString(),
        syncedStartsAt: starts.toISOString(),
        syncedEndsAt: ends.toISOString(),
        patchTimes: true,
        location,
        description: describe(t, appUrl),
      });
      continue;
    }

    const renamed = existing.synced_name !== t.name;
    const retimed =
      Date.parse(existing.synced_starts_at) !== starts.getTime() ||
      Date.parse(existing.synced_ends_at) !== ends.getTime();

    if (!renamed && !retimed) continue;

    // ONCE DISCORD HAS STARTED THE EVENT, ITS TIMES ARE FROZEN — and pretending
    // otherwise is how this route would have burned a call every fifteen
    // minutes for the length of a tournament.
    //
    // Discord refuses to retime an event already in progress. Nothing here
    // needs to go wrong for that to bite: a tournament is mid-run, an exec
    // edits tournament_event_start_time (which flips the comparison above for
    // EVERY mapped tournament at once), the PATCH is refused, nothing is
    // recorded, and the next tick computes the identical diff and tries again.
    // The session pings carry MAX_LATENESS_MINUTES for exactly this shape.
    //
    // So: a started event gets a name-and-description PATCH or nothing at all.
    // A rename still lands — that is the change members would actually notice —
    // and recording the tournament's current times alongside it settles the
    // comparison, leaving Discord holding the times it was created with. Those
    // times describe an event that is already underway, so nobody can act on
    // them anyway.
    //
    // Started is read from the RECORDED start as well as the computed one,
    // because the recorded value is the one Discord was given.
    const started =
      starts.getTime() <= now || Date.parse(existing.synced_starts_at) <= now;

    if (started && !renamed) {
      // A time change nobody can push. Reported rather than dropped in silence,
      // because "the Discord event says the wrong day" is otherwise unanswerable
      // — but emphatically not retried, which is the whole point.
      skipped.push({ tournamentId: t.id, reason: 'started_cannot_retime' });
      continue;
    }

    actions.push({
      kind: 'update',
      tournamentId: t.id,
      discordEventId: existing.discord_event_id,
      name: t.name,
      startsAt: sendStart.toISOString(),
      endsAt: ends.toISOString(),
      syncedStartsAt: starts.toISOString(),
      syncedEndsAt: ends.toISOString(),
      patchTimes: !started,
      location,
      description: describe(t, appUrl),
    });
  }

  return NextResponse.json({ actions, skipped });
}

// Record a Discord event the bot has ALREADY created or modified.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:tournament-events:write:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);
  const tournamentId = str('tournamentId');
  const guildId = str('guildId');
  const discordEventId = str('discordEventId');
  const name = str('name');
  const startsAt = str('syncedStartsAt');
  const endsAt = str('syncedEndsAt');

  if (!tournamentId || !guildId || !discordEventId || !name || !startsAt || !endsAt) {
    return NextResponse.json({ error: 'incomplete_mapping' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_tournament_events')
    .upsert(
      {
        tournament_id: tournamentId,
        guild_id: guildId,
        discord_event_id: discordEventId,
        synced_name: name,
        synced_starts_at: startsAt,
        synced_ends_at: endsAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tournament_id,guild_id' }
    );

  if (error) {
    // Loud. A create that posted but did not record leaves a Discord event with
    // no mapping, and the next tick makes a SECOND one — the duplicate is
    // visible to the whole server, so this must be visible in the log.
    console.error('[discord] tournament-event record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

// Forget a mapping, after the bot has cancelled the Discord event.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:tournament-events:write:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const tournamentId = params.get('tournamentId');
  const guildId = params.get('guildId');
  if (!tournamentId || !guildId) {
    return NextResponse.json({ error: 'tournament_and_guild_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_tournament_events')
    .delete()
    .eq('tournament_id', tournamentId)
    .eq('guild_id', guildId);

  if (error) {
    console.error('[discord] tournament-event delete failed:', error.message);
    return NextResponse.json({ error: 'delete_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
