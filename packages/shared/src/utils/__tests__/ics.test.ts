import { describe, it, expect } from 'vitest';
import {
  escapeICSText,
  foldICSLine,
  formatICSDates,
  sessionToVEvent,
  buildICSCalendar,
  type ICSSessionFields,
} from '../ics';
import { SESSION_DEFAULT_DURATION_MINUTES } from '../constants';

// All expected instants below are UTC equivalents of America/Vancouver
// wall-clock times: PDT = UTC-7 (summer), PST = UTC-8 (winter).

function makeSession(overrides: Partial<ICSSessionFields> = {}): ICSSessionFields {
  return {
    id: 'abc-123',
    name: 'Ladder Night',
    date: '2026-07-15',
    start_time: '18:30:00',
    end_time: '21:00:00',
    location: 'SFU Gym',
    notes: null,
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('escapeICSText', () => {
  it('escapes backslash, semicolon, comma, and newlines', () => {
    expect(escapeICSText('a\\b')).toBe('a\\\\b');
    expect(escapeICSText('a;b')).toBe('a\\;b');
    expect(escapeICSText('a,b')).toBe('a\\,b');
    expect(escapeICSText('a\nb\r\nc')).toBe('a\\nb\\nc');
  });

  it('escapes backslashes before adding new ones', () => {
    expect(escapeICSText('\\;')).toBe('\\\\\\;');
  });
});

describe('foldICSLine', () => {
  it('leaves short lines alone', () => {
    expect(foldICSLine('SUMMARY:Practice')).toBe('SUMMARY:Practice');
  });

  it('folds long lines at 75 octets with CRLF + space continuation', () => {
    const line = 'DESCRIPTION:' + 'x'.repeat(200);
    const folded = foldICSLine(line);
    for (const chunk of folded.split('\r\n')) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(75);
    }
    // Continuation lines start with exactly one space; unfolding restores the original.
    expect(folded.split('\r\n').slice(1).every((c) => c.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('never splits a multi-byte character across the fold', () => {
    const line = 'SUMMARY:' + '羽'.repeat(50); // 3 octets each
    const folded = foldICSLine(line);
    for (const chunk of folded.split('\r\n')) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});

describe('sessionToVEvent', () => {
  it('emits UTC stamps for a summer (PDT, UTC-7) timed session', () => {
    const lines = sessionToVEvent(makeSession());
    expect(lines).toContain('DTSTART:20260716T013000Z'); // 18:30 PDT
    expect(lines).toContain('DTEND:20260716T040000Z'); // 21:00 PDT
  });

  it('emits UTC stamps for a winter (PST, UTC-8) timed session', () => {
    const lines = sessionToVEvent(makeSession({ date: '2026-01-15' }));
    expect(lines).toContain('DTSTART:20260116T023000Z'); // 18:30 PST
    expect(lines).toContain('DTEND:20260116T050000Z'); // 21:00 PST
  });

  it('defaults a missing end_time to start + the configured default duration', () => {
    const lines = sessionToVEvent(makeSession({ end_time: null }));
    expect(lines).toContain('DTSTART:20260716T013000Z'); // 18:30 PDT
    // Derived, not hardcoded: default_duration_minutes is admin-editable in
    // platform_settings, so a literal DTEND here rots when prod is retuned.
    const start = Date.parse('2026-07-16T01:30:00.000Z');
    const end = new Date(start + SESSION_DEFAULT_DURATION_MINUTES * 60_000);
    const stamp = end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(lines).toContain(`DTEND:${stamp}`);
  });

  it('emits an all-day event with exclusive next-day DTEND when untimed', () => {
    const lines = sessionToVEvent(makeSession({ start_time: null, end_time: null }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20260715');
    expect(lines).toContain('DTEND;VALUE=DATE:20260716');
  });

  it('rolls the all-day DTEND across month boundaries', () => {
    const { end, allDay } = formatICSDates({ date: '2026-07-31', start_time: null, end_time: null });
    expect(allDay).toBe(true);
    expect(end).toBe('20260801');
  });

  it('has a stable UID and an updated_at-derived SEQUENCE', () => {
    const session = makeSession();
    const lines = sessionToVEvent(session);
    expect(lines).toContain('UID:abc-123@sfu-badminton');
    const seq = Math.floor(Date.parse(session.updated_at) / 1000);
    expect(lines).toContain(`SEQUENCE:${seq}`);
    // Same input -> identical output (feed refreshes must not churn events).
    expect(sessionToVEvent(session)).toEqual(lines);
  });

  it('falls back to "Practice Session" and escapes text fields', () => {
    const lines = sessionToVEvent(
      makeSession({ name: null, location: 'Gym; Court 1', notes: 'Bring shuttles,\nplease' })
    );
    expect(lines).toContain('SUMMARY:Practice Session');
    expect(lines).toContain('LOCATION:Gym\\; Court 1');
    expect(lines).toContain('DESCRIPTION:Bring shuttles\\,\\nplease');
  });

  it('emits a URL line pointing at the session when a baseUrl is given', () => {
    const lines = sessionToVEvent(makeSession(), 'https://x.test');
    expect(lines).toContain('URL:https://x.test/sessions?s=abc-123');
  });

  it('omits the URL line when no baseUrl is given', () => {
    const lines = sessionToVEvent(makeSession());
    expect(lines.some((l) => l.startsWith('URL:'))).toBe(false);
  });
});

describe('buildICSCalendar', () => {
  it('wraps events in a VCALENDAR with CRLF endings and feed metadata', () => {
    const ics = buildICSCalendar([makeSession()]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:SFU Badminton\r\n');
    expect(ics).toContain('X-WR-TIMEZONE:America/Vancouver\r\n');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n');
    expect(ics).toContain('BEGIN:VEVENT\r\n');
    // No bare LF anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('threads a baseUrl through to each event when provided', () => {
    const ics = buildICSCalendar([makeSession()], { baseUrl: 'https://x.test' });
    expect(ics).toContain('URL:https://x.test/sessions?s=abc-123\r\n');
  });
});
