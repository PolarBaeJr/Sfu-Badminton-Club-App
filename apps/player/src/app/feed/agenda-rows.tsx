import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventWallClock,
  formatTime,
  type ClubEventKind,
} from '@badminton/shared';
import { addDaysISO } from '@/lib/schedule';
import type { CalendarClubEventRow, CalendarTournamentRow } from '@/lib/calendar-items';

/**
 * A club event in the agenda. Compact on purpose: signing up needs the event's
 * capacity and sign-up window, which only its own page reads, so this row says
 * what and when and links there.
 */
export function ClubEventAgendaRow({ event, going }: { event: CalendarClubEventRow; going: boolean }) {
  const cancelled = event.status === 'cancelled';
  const { time } = clubEventWallClock(event.starts_at);
  const kind = CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? 'Club event';
  return (
    <Link href={`/events/${event.id}`} className="home-row press">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="tag tag-gold">{kind}</span>
          <span className={`home-row-title${cancelled ? ' is-cancelled' : ''}`}>{event.title}</span>
        </div>
        <div className="home-row-meta">
          {[formatTime(time), event.location].filter(Boolean).join(' · ')}
        </div>
      </div>
      {cancelled ? (
        <span className="tag">Cancelled</span>
      ) : going ? (
        <span className="chip chip-success">Going</span>
      ) : null}
      <ChevronRight size={14} aria-hidden="true" style={{ color: 'var(--mute)', flexShrink: 0 }} />
    </Link>
  );
}

// Counts days by stepping the ISO date, never by subtracting Dates, so the
// 2026-11-01 cutover cannot shift it. Capped so a typo in end_date cannot spin.
function tournamentWhen(t: CalendarTournamentRow, todayISO: string): string {
  const last = t.end_date && t.end_date > t.start_date ? t.end_date : t.start_date;
  let total = 1;
  let day = 1;
  for (let d = t.start_date; d < last && total < 60; d = addDaysISO(d, 1)) {
    total += 1;
    if (d < todayISO) day += 1;
  }
  if (t.start_date > todayISO) return total === 1 ? 'All day' : `${total} days`;
  if (t.start_date === todayISO) return total === 1 ? 'Today' : `Starts today, ${total} days`;
  return `Day ${day} of ${total}`;
}

/** A published tournament that is not yet running as a live banner. */
export function TournamentAgendaRow({ tournament, todayISO }: { tournament: CalendarTournamentRow; todayISO: string }) {
  return (
    <Link href={`/tournaments/${tournament.id}`} className="home-row press">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="tag tag-outline">Tournament</span>
          <span className="home-row-title">{tournament.name}</span>
        </div>
        <div className="home-row-meta">{tournamentWhen(tournament, todayISO)}</div>
      </div>
      <ChevronRight size={14} aria-hidden="true" style={{ color: 'var(--mute)', flexShrink: 0 }} />
    </Link>
  );
}
