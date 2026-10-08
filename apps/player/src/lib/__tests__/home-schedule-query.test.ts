// PINNING THE SELECT STRINGS AND FILTERS THE SCHEDULE ON /feed SENDS.
//
// Runs the real builders from lib/home-schedule-queries.ts against a client
// whose fetch records the URL instead of making it, the same technique as
// feed-tournament-query.test.ts. No network and no credentials.

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  calendarSessionsQuery,
  calendarTournamentsQuery,
  clubEventsCalendarQuery,
  mySignupsQuery,
  openSessionsQuery,
} from '@/lib/home-schedule-queries';

const SEASON = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

function recordingClient() {
  const urls: string[] = [];
  const client = createClient('http://pinned.invalid', 'not-a-real-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: ((input: RequestInfo | URL) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return Promise.resolve(
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }) as typeof fetch,
    },
  });
  return { client, urls };
}

function onlyQuery(urls: readonly string[]): URLSearchParams {
  expect(urls).toHaveLength(1);
  const [first] = urls;
  if (first === undefined) throw new Error('no request was recorded');
  return new URL(first).searchParams;
}

describe('the club events read', () => {
  it('names only the calendar columns and only published or cancelled events', async () => {
    const { client, urls } = recordingClient();
    await clubEventsCalendarQuery(client, '2026-09-01T07:00:00.000Z');
    const q = onlyQuery(urls);
    expect(urls[0]).toContain('/rest/v1/club_events');
    expect(q.get('select')).toBe('id,title,kind,location,starts_at,ends_at,status');
    expect(q.get('select')).not.toContain('created_by');
    expect(q.get('select')).not.toContain('*');
    expect(q.get('status')).toBe('in.(published,cancelled)');
    expect(q.get('starts_at')).toBe('gte.2026-09-01T07:00:00.000Z');
  });
});

describe('the tournaments read', () => {
  it('leaves out drafts and names no free-text column', async () => {
    const { client, urls } = recordingClient();
    await calendarTournamentsQuery(client, SEASON);
    const q = onlyQuery(urls);
    const select = q.get('select') ?? '';
    expect(q.get('status')).toBe('in.(active,completed)');
    expect(q.get('or')).toBe(`(season_id.eq.${SEASON},season_id.is.null)`);
    expect(select).not.toContain('*');
    expect(select).not.toContain('notes');
    expect(select).not.toContain('suspension_reason');
    // The columns proved readable by `authenticated` (feed-tournament-query.test.ts).
    const VERIFIED_TOURNAMENTS = ['id', 'name', 'start_date', 'end_date', 'status', 'suspended_at', 'season_id'];
    for (const col of select.split(',')) expect(VERIFIED_TOURNAMENTS, `tournaments.${col}`).toContain(col);
  });
});

describe('the session reads', () => {
  it('selects exactly what the month grid needs', async () => {
    const { client, urls } = recordingClient();
    await calendarSessionsQuery(client, SEASON, 'active');
    const q = onlyQuery(urls);
    expect(q.get('select')).toBe('id,name,date,start_time,status,season_id');
    expect(q.get('or')).toBe(`(season_id.eq.${SEASON},season_id.is.null)`);
    expect(q.has('track')).toBe(true);
    expect(q.has('status')).toBe(false);
  });

  it('reads every column of the open sessions for the cards, season-scoped and track-filtered', async () => {
    const { client, urls } = recordingClient();
    await openSessionsQuery(client, SEASON, 'active');
    const q = onlyQuery(urls);
    expect(q.get('select')).toBe('*');
    expect(q.get('status')).toBe('eq.open');
    expect(q.get('or')).toBe(`(season_id.eq.${SEASON},season_id.is.null)`);
    expect(q.has('track')).toBe(true);
  });

  it('drops the season filter when no season is active', async () => {
    const { client, urls } = recordingClient();
    await openSessionsQuery(client, null, 'active');
    expect(onlyQuery(urls).has('or')).toBe(false);
  });
});

describe('the sign-ups read', () => {
  it('reads only this member\'s own event ids', async () => {
    const { client, urls } = recordingClient();
    await mySignupsQuery(client, PLAYER);
    const q = onlyQuery(urls);
    expect(q.get('select')).toBe('event_id');
    expect(q.get('player_id')).toBe(`eq.${PLAYER}`);
  });
});
