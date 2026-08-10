export const dynamic = 'force-dynamic';
import { scopeToActiveSeason } from '@badminton/shared';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge, PageHeader } from '@badminton/ui';
import { formatDate, formatTime, type AttendanceStatus } from '@badminton/shared';
import { CreateSessionForm, SessionCardMenu, AttendanceDialog, CheckinQrDialog } from './actions';
import { Calendar, MapPin, FileText } from 'lucide-react';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import QRCode from 'qrcode';

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
  const supabase = createAdminClient();

  // The schedule belongs to the season it is part of. Without this, activating a
  // new term left last term's sessions on the page alongside this term's, with
  // nothing to tell them apart but the date.
  //
  // Sessions with NO season are included deliberately: they are unassigned, not
  // "in another season", and filtering them out would strand them somewhere with
  // no page that lists them. When no season is active at all, the filter is
  // skipped entirely — hiding the whole schedule because nobody pressed
  // "activate" is worse than showing too much.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } =
    resolveSeasonScope(allSeasons, seasonParam);

  const { data: sessions } = await scopeToActiveSeason(
    supabase.from('sessions').select('*'),
    scopedSeason?.id,
  ).order('date', { ascending: false });

  const { data: attendanceRows } = await supabase
    .from('session_attendance')
    .select('session_id, player_id, checked_in_at, status, marked_by, marked_at, players(full_name)');

  const { data: rsvpRows } = await supabase
    .from('session_rsvp')
    .select('session_id, intent, players(full_name)');

  const { data: activePlayers } = await supabase
    .from('players')
    .select('id, full_name, avatar_url')
    .eq('active_flag', true)
    .order('full_name');

  // QR check-in tokens (00024). RLS denies everyone, so this read only works
  // because createAdminClient() is the service-role client.
  const { data: checkinTokens } = await supabase
    .from('session_checkin_tokens')
    .select('session_id, token');

  // Group attendance records by session_id
  type AttendeeEntry = {
    player_id: string;
    full_name: string;
    checked_in_at: string;
    status: AttendanceStatus;
    marked_by: string | null;
    marked_at: string | null;
  };
  const attendanceMap: Record<string, AttendeeEntry[]> = {};
  for (const row of attendanceRows ?? []) {
    const name =
      Array.isArray(row.players)
        ? (row.players[0]?.full_name ?? 'Unknown')
        : ((row.players as { full_name: string } | null)?.full_name ?? 'Unknown');
    const sid = row.session_id as string;
    if (!attendanceMap[sid]) attendanceMap[sid] = [];
    attendanceMap[sid].push({
      player_id: row.player_id as string,
      full_name: name,
      checked_in_at: row.checked_in_at as string,
      status: row.status as AttendanceStatus,
      marked_by: row.marked_by as string | null,
      marked_at: row.marked_at as string | null,
    });
  }

  // Group RSVP records by session_id, splitting on intent.
  const rsvpMap: Record<string, { going: string[]; declined: string[] }> = {};
  for (const row of rsvpRows ?? []) {
    const name = Array.isArray(row.players)
      ? (row.players[0]?.full_name ?? 'Unknown')
      : ((row.players as { full_name: string } | null)?.full_name ?? 'Unknown');
    const sid = row.session_id as string;
    (rsvpMap[sid] ??= { going: [], declined: [] })[row.intent as 'going' | 'declined'].push(name);
  }

  // QR images are built here, server-side, so the qrcode library never reaches
  // the client bundle. Only open sessions get one — nothing else can be
  // checked into, so rendering a code for them would just be noise.
  const playerBaseUrl = process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000';
  const openSessionIds = new Set(
    (sessions ?? []).filter((s) => s.status === 'open').map((s) => s.id as string)
  );
  const qrEntries = await Promise.all(
    (checkinTokens ?? [])
      .filter((row) => openSessionIds.has(row.session_id as string))
      .map(async (row): Promise<[string, { url: string; svg: string }]> => {
        const url = `${playerBaseUrl}/checkin/${row.token}`;
        return [
          row.session_id as string,
          { url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, width: 320 }) },
        ];
      })
  );
  const qrBySession = Object.fromEntries(qrEntries);

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <PageHeader
        title="Sessions"
        sub="Schedule and manage club practice sessions"
        watermark="S"
        actions={<CreateSessionForm />}
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/sessions" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* Sessions List */}
      {sessions && sessions.length > 0 ? (
        <div className="space-y-3">
          {sessions.map((session) => {
            const rsvp = rsvpMap[session.id];
            const qr = qrBySession[session.id];
            return (
            <Card key={session.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2">
                  {/* Name + Status */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-base font-semibold text-[var(--text-primary)]">
                      {session.name || 'Untitled Session'}
                    </h2>
                    <Badge variant={session.status === 'open' ? 'success' : 'neutral'}>
                      {session.status === 'open' ? 'Open' : 'Closed'}
                    </Badge>
                    <Badge variant={session.track === 'competitive' ? 'info' : session.track === 'recreational' ? 'warning' : 'neutral'}>
                      {session.track === 'competitive' ? 'Competitive' : session.track === 'recreational' ? 'Recreational' : 'All'}
                    </Badge>
                  </div>

                  {/* Date + Location */}
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                      <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      {formatDate(session.date)}
                      {session.start_time && ` · ${formatTime(session.start_time)}`}
                      {session.start_time && session.end_time && ` – ${formatTime(session.end_time)}`}
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                      <MapPin className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      {session.location}
                    </div>
                  </div>

                  {/* Notes preview */}
                  {session.notes && (
                    <div className="flex items-start gap-1.5 text-sm text-[var(--text-muted)]">
                      <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <span className="line-clamp-1">{session.notes}</span>
                    </div>
                  )}

                  {/* Attendance count + view dialog, and the self check-in QR */}
                  <div className="flex items-center gap-4 flex-wrap">
                    <AttendanceDialog
                      sessionId={session.id}
                      attendees={attendanceMap[session.id] ?? []}
                      players={activePlayers ?? []}
                    />
                    {session.status === 'open' && (
                      <CheckinQrDialog
                        sessionId={session.id}
                        url={qr?.url ?? null}
                        svg={qr?.svg ?? null}
                      />
                    )}
                  </div>

                  {/* RSVP intents (read-only) */}
                  {rsvp && (rsvp.going.length > 0 || rsvp.declined.length > 0) && (
                    <div className="space-y-0.5">
                      {rsvp.going.length > 0 && (
                        <div className="text-xs text-[var(--text-secondary)]">
                          Going ({rsvp.going.length}): {rsvp.going.join(', ')}
                        </div>
                      )}
                      {rsvp.declined.length > 0 && (
                        <div className="text-xs text-[var(--text-muted)]">
                          Can&apos;t make it ({rsvp.declined.length}): {rsvp.declined.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Three-dot menu */}
                <div className="flex-shrink-0">
                  <SessionCardMenu session={session} />
                </div>
              </div>
            </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--bg-surface)] mb-4">
              <Calendar className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-primary)] font-medium mb-1">No sessions yet</p>
            <p className="text-sm text-[var(--text-muted)]">
              Create your first session to get started
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
