// Pure ICS (RFC 5545) generation for the per-player calendar feed and the
// per-session "Add to Calendar" download. No I/O here — callers fetch the
// sessions and serve/download the output. Session wall-clock times are
// club-local (CLUB_TIMEZONE); timed events are emitted as UTC instants so
// every calendar client renders them correctly regardless of device timezone.
import { CLUB_TIMEZONE, SESSION_DEFAULT_DURATION_MINUTES } from './constants';
import { wallClockToUtc } from './session-window';

export interface ICSSessionFields {
  id: string;
  name: string | null;
  date: string; // YYYY-MM-DD
  start_time: string | null; // HH:MM[:SS]
  end_time: string | null; // HH:MM[:SS]
  location: string;
  notes: string | null;
  updated_at: string;
}

// Escape TEXT property values (RFC 5545 §3.3.11). Backslash first so the
// escapes added for the other characters aren't themselves escaped.
export function escapeICSText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Fold a content line to 75 octets max (RFC 5545 §3.1): continuation lines
// are CRLF + a single space, and that space counts toward the 75. Folding is
// measured in UTF-8 octets, not characters, and never splits a code point.
export function foldICSLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const chunks: string[] = [];
  let current = '';
  let currentOctets = 0;
  for (const ch of line) {
    const chOctets = encoder.encode(ch).length;
    if (currentOctets + chOctets > 75) {
      chunks.push(current);
      current = ' ';
      currentOctets = 1;
    }
    current += ch;
    currentOctets += chOctets;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

// "2026-07-16T01:30:00.000Z" -> "20260716T013000Z"
function formatUtcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h), minute: Number(m ?? '0') };
}

// DTSTART/DTEND values for a session. Timed sessions get UTC ...Z stamps
// (end = end_time, else start + default duration); untimed sessions are
// all-day (VALUE=DATE), whose DTEND is exclusive per RFC 5545 — the next day.
export function formatICSDates(session: Pick<ICSSessionFields, 'date' | 'start_time' | 'end_time'>): {
  start: string;
  end: string;
  allDay: boolean;
} {
  const [y, mo, d] = session.date.split('-').map(Number) as [number, number, number];

  if (session.start_time) {
    const start = parseTime(session.start_time);
    const startAt = wallClockToUtc(y, mo, d, start.hour, start.minute);
    let endAt: Date;
    if (session.end_time) {
      const end = parseTime(session.end_time);
      endAt = wallClockToUtc(y, mo, d, end.hour, end.minute);
    } else {
      endAt = new Date(startAt.getTime() + SESSION_DEFAULT_DURATION_MINUTES * 60_000);
    }
    return { start: formatUtcStamp(startAt), end: formatUtcStamp(endAt), allDay: false };
  }

  // Date.UTC normalizes day overflow, so d + 1 rolls month/year correctly.
  const nextDay = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return {
    start: session.date.replace(/-/g, ''),
    end: nextDay.replace(/-/g, ''),
    allDay: true,
  };
}

// One session -> unfolded VEVENT content lines. Callers fold and join
// (buildICSCalendar does both). UID is stable per session so calendar clients
// update events in place; SEQUENCE bumps whenever the row is touched.
export function sessionToVEvent(session: ICSSessionFields, baseUrl?: string): string[] {
  const { start, end, allDay } = formatICSDates(session);
  const updated = new Date(session.updated_at);
  const stamp = formatUtcStamp(updated);

  const lines = [
    'BEGIN:VEVENT',
    `UID:${session.id}@sfu-badminton`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${Math.floor(updated.getTime() / 1000)}`,
    allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`,
    allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`,
    `SUMMARY:${escapeICSText(session.name ?? 'Practice Session')}`,
    `LOCATION:${escapeICSText(session.location)}`,
  ];
  if (session.notes) lines.push(`DESCRIPTION:${escapeICSText(session.notes)}`);
  // URL is a URI value, not TEXT, so it is not run through escapeICSText —
  // both baseUrl (env var) and session.id (uuid) are already URI-safe.
  if (baseUrl) lines.push(`URL:${baseUrl}/sessions?s=${session.id}`);
  lines.push('END:VEVENT');
  return lines;
}

// Full VCALENDAR document, CRLF line endings, lines folded to 75 octets.
export function buildICSCalendar(sessions: ICSSessionFields[], opts?: { baseUrl?: string }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SFU Badminton//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:SFU Badminton',
    `X-WR-TIMEZONE:${CLUB_TIMEZONE}`,
    // Both spellings of "refresh hourly": REFRESH-INTERVAL is RFC 7986,
    // X-PUBLISHED-TTL is the legacy Apple/Outlook equivalent.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...sessions.flatMap((s) => sessionToVEvent(s, opts?.baseUrl)),
    'END:VCALENDAR',
  ];
  return lines.map(foldICSLine).join('\r\n') + '\r\n';
}
