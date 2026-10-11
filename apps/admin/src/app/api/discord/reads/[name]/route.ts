import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  CLUB_EVENT_KIND_LABELS,
  clubToday,
  formatClubEventTime,
  formatDate,
  formatTime,
  utcToClubWallClock,
  type ClubEventInput,
  type ClubEventKind,
} from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { discordActorStore, resolveDiscordActor } from '@/lib/discord-actor';
import { isAuthorizedDiscordService, discordServiceUnauthorized } from '@/lib/discord-service-auth';
import type { Capability } from '@/lib/permissions';

// CONSOLE COMMANDS ON DISCORD: the reads behind the lists, the pickers and the
// edit merges.
//
// Same door as the actions route: the service secret, then the linked exec in
// discordActorStore. Each read asks requireCapability for the capability the
// console page it mirrors asks for, so somebody who cannot open Sessions in
// the console cannot list them from Discord either; the query itself then
// runs with the service role, as the console's own pages do.
//
// The rows are turned into what the bot needs HERE, where it is type-checked:
// labels already formatted in club time, and for the edit paths the exact
// input the console action takes. updateSession reads a missing field as
// "clear it" and updateClubEvent takes wall-clock strings and dollars, so a
// merge assembled in the bot from raw rows would blank or shift columns.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHOICES_MAX = 25;

type AdminClient = ReturnType<typeof createAdminClient>;
type ReadResult = { ok: true; data: unknown } | { unavailable: true };

function reply(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

function failed(step: string, error: { message: string }): ReadResult {
  Sentry.captureException(new Error(`Discord console read ${step} failed: ${error.message}`));
  return { unavailable: true };
}

type SessionRow = {
  id: string;
  name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string | null;
  track: 'competitive' | 'recreational' | 'all';
  status: string;
};

const SESSION_COLUMNS = 'id, name, date, start_time, end_time, location, notes, track, status';

function sessionLabel(s: SessionRow): string {
  const when = [formatDate(s.date), s.start_time ? formatTime(s.start_time) : null].filter(Boolean).join(' ');
  return [when, s.name ?? 'Practice Session', s.location].filter(Boolean).join(' · ');
}

function sessionView(s: SessionRow) {
  return {
    id: s.id,
    label: sessionLabel(s),
    status: s.status,
    track: s.track,
    // The input updateSession takes, field for field, so the bot only overlays
    // what the exec changed. Times are trimmed to HH:MM because that is the
    // shape the console's form posts.
    editInput: {
      name: s.name ?? 'Practice Session',
      date: s.date,
      ...(s.start_time ? { time: s.start_time.slice(0, 5) } : {}),
      ...(s.end_time ? { end_time: s.end_time.slice(0, 5) } : {}),
      location: s.location ?? '',
      ...(s.notes ? { notes: s.notes } : {}),
      track: s.track,
    },
  };
}

async function readSessions(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id');
  if (id) {
    if (!UUID.test(id)) return { ok: true, data: { sessions: [] } };
    const { data, error } = await adminClient.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle();
    if (error) return failed('sessions', error);
    return { ok: true, data: { sessions: data ? [sessionView(data as SessionRow)] : [] } };
  }

  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const { data, error } = await adminClient
    .from('sessions')
    .select(SESSION_COLUMNS)
    .eq('status', 'open')
    .gte('date', clubToday())
    .order('date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: false })
    .limit(60);
  if (error) return failed('sessions', error);
  const rows = ((data ?? []) as SessionRow[]).filter(
    (s) => !q || sessionLabel(s).toLowerCase().includes(q),
  );
  return { ok: true, data: { sessions: rows.slice(0, CHOICES_MAX).map(sessionView) } };
}

async function readSessionAttendance(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id') ?? '';
  if (!UUID.test(id)) return { ok: true, data: { session: null } };

  const [sessionRes, rsvpRes, attendanceRes] = await Promise.all([
    adminClient.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle(),
    adminClient
      .from('session_rsvp')
      .select('player_id', { count: 'exact', head: true })
      .eq('session_id', id)
      .eq('intent', 'going'),
    adminClient
      .from('session_attendance')
      .select('status, checked_in_at, players!session_attendance_player_id_fkey(full_name)')
      .eq('session_id', id)
      .in('status', ['checked_in', 'present'])
      .order('checked_in_at', { ascending: true }),
  ]);
  if (sessionRes.error) return failed('session-attendance', sessionRes.error);
  if (rsvpRes.error) return failed('session-attendance', rsvpRes.error);
  if (attendanceRes.error) return failed('session-attendance', attendanceRes.error);
  if (!sessionRes.data) return { ok: true, data: { session: null } };

  type AttendanceRow = { players: { full_name: string | null } | { full_name: string | null }[] | null };
  const names = ((attendanceRes.data ?? []) as AttendanceRow[]).map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return player?.full_name ?? 'A member';
  });
  return {
    ok: true,
    data: {
      session: { id, label: sessionLabel(sessionRes.data as SessionRow) },
      going: rsvpRes.count ?? 0,
      checkedIn: names,
    },
  };
}

async function readLocations(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  const { data, error } = await adminClient
    .from('sessions')
    .select('location')
    .order('date', { ascending: false })
    .limit(200);
  if (error) return failed('locations', error);
  const seen = new Set<string>();
  const locations: string[] = [];
  for (const row of (data ?? []) as { location: string | null }[]) {
    const label = row.location?.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    if (q && !label.toLowerCase().includes(q)) continue;
    locations.push(label.slice(0, 100));
    if (locations.length >= CHOICES_MAX) break;
  }
  return { ok: true, data: { locations } };
}

type EventRow = {
  id: string;
  title: string;
  kind: ClubEventKind;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
  capacity: number | null;
  cost_cents: number | null;
  status: string;
};

const EVENT_COLUMNS =
  'id, title, kind, description, location, starts_at, ends_at, signup_opens_at, signup_closes_at, capacity, cost_cents, status';

function eventLabel(e: EventRow): string {
  const status = e.status === 'published' ? null : e.status === 'draft' ? 'Draft' : 'Cancelled';
  return [formatClubEventTime(e.starts_at), e.title, CLUB_EVENT_KIND_LABELS[e.kind] ?? e.kind, status]
    .filter(Boolean)
    .join(' · ');
}

function eventView(e: EventRow) {
  const editInput: ClubEventInput = {
    title: e.title,
    kind: e.kind,
    description: e.description,
    location: e.location,
    starts_at: utcToClubWallClock(e.starts_at),
    ends_at: e.ends_at ? utcToClubWallClock(e.ends_at) : null,
    signup_opens_at: e.signup_opens_at ? utcToClubWallClock(e.signup_opens_at) : null,
    signup_closes_at: e.signup_closes_at ? utcToClubWallClock(e.signup_closes_at) : null,
    capacity: e.capacity,
    cost_dollars: e.cost_cents === null ? null : e.cost_cents / 100,
    publish: e.status === 'published',
  };
  return { id: e.id, label: eventLabel(e), status: e.status, editInput };
}

async function readEvents(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id');
  if (id) {
    if (!UUID.test(id)) return { ok: true, data: { events: [] } };
    const { data, error } = await adminClient.from('club_events').select(EVENT_COLUMNS).eq('id', id).maybeSingle();
    if (error) return failed('events', error);
    return { ok: true, data: { events: data ? [eventView(data as EventRow)] : [] } };
  }

  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  // Drafts and published events that have not started more than a day ago:
  // the ones an exec might still publish, cancel or delete.
  const { data, error } = await adminClient
    .from('club_events')
    .select(EVENT_COLUMNS)
    .in('status', ['draft', 'published'])
    .gte('starts_at', new Date(Date.now() - 86_400_000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(60);
  if (error) return failed('events', error);
  const rows = ((data ?? []) as EventRow[]).filter((e) => !q || eventLabel(e).toLowerCase().includes(q));
  return { ok: true, data: { events: rows.slice(0, CHOICES_MAX).map(eventView) } };
}

async function readEventSignups(adminClient: AdminClient, params: URLSearchParams): Promise<ReadResult> {
  const id = params.get('id') ?? '';
  if (!UUID.test(id)) return { ok: true, data: { event: null } };

  const [eventRes, signupsRes] = await Promise.all([
    adminClient.from('club_events').select(EVENT_COLUMNS).eq('id', id).maybeSingle(),
    adminClient
      .from('club_event_signups')
      .select('player_id, created_at, players(full_name)')
      .eq('event_id', id)
      .order('created_at', { ascending: true }),
  ]);
  if (eventRes.error) return failed('event-signups', eventRes.error);
  if (signupsRes.error) return failed('event-signups', signupsRes.error);
  if (!eventRes.data) return { ok: true, data: { event: null } };

  type SignupRow = { players: { full_name: string | null } | { full_name: string | null }[] | null };
  const names = ((signupsRes.data ?? []) as SignupRow[]).map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return player?.full_name ?? 'A member';
  });
  const event = eventRes.data as EventRow;
  return {
    ok: true,
    data: { event: { id, label: eventLabel(event), capacity: event.capacity }, signups: names },
  };
}

const READS: Record<
  string,
  { capability: Capability; run: (adminClient: AdminClient, params: URLSearchParams) => Promise<ReadResult> }
> = {
  sessions: { capability: 'sessions.page', run: readSessions },
  'session-attendance': { capability: 'sessions.page', run: readSessionAttendance },
  locations: { capability: 'sessions.page', run: readLocations },
  events: { capability: 'events.page', run: readEvents },
  'event-signups': { capability: 'events.signups.read', run: readEventSignups },
};

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const { name } = await params;
  const read = Object.hasOwn(READS, name) ? READS[name] : undefined;
  if (!read) return reply({ error: 'Unknown read' }, 404);

  // A header rather than a query param: ids in a URL end up in access logs.
  const discordUserId = request.headers.get('x-discord-user-id') ?? '';
  if (!/^\d{5,25}$/.test(discordUserId)) return reply({ error: 'Invalid request' }, 400);

  const adminClient = createAdminClient();
  const actor = await resolveDiscordActor(discordUserId, adminClient);
  if (actor === 'unavailable') return reply({ error: 'unavailable' }, 503);
  if (actor === 'not_linked') return reply({ ok: false, refusal: 'not_linked' }, 200);

  const searchParams = new URL(request.url).searchParams;
  return discordActorStore.run({ playerId: actor.playerId, discordUserId }, async () => {
    try {
      await requireCapability(read.capability);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'AUTH-105') return reply({ ok: false, refusal: 'passkey_required' }, 200);
      // A coded refusal (no permission, suspended, pending) is a sentence the
      // console already shows people, so it travels as one.
      if (typeof code === 'string' && err instanceof Error) {
        return reply({ ok: false, error: err.message, code }, 200);
      }
      Sentry.captureException(err);
      return reply({ error: 'unavailable' }, 503);
    }

    const result = await read.run(adminClient, searchParams);
    if ('unavailable' in result) return reply({ error: 'unavailable' }, 503);
    return reply(result, 200);
  });
}
