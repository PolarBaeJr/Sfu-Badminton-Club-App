// The reads behind the schedule on /feed, as builders rather than inline in the
// page, so home-schedule-query.test.ts runs this exact code against a recording
// client instead of a copy of it. Select strings are unchecked literals (typed
// clients are off), and a PostgREST read that is refused RESOLVES, so the test
// is the only thing that notices a wrong column before production does.
//
// The season filter is written out on a plain const in each builder rather
// than passed through a generic helper: the feed's river documents tsc giving
// up with "type instantiation is excessively deep" on exactly that.

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopeToActiveSeason } from '@badminton/shared';
import { onVisibleTracks } from './session-track-filter';
import { CLUB_EVENT_CALENDAR_COLUMNS } from './club-event-view';

type Client = Pick<SupabaseClient, 'from'>;

/**
 * Every open session in the active season (and every season-less one), for the
 * agenda cards. `*` because SessionCard needs `track`, `notes` and
 * `require_scan_to_check_in`, and getCheckinWindow prefers the stored
 * `starts_at` / `ends_at`.
 */
export function openSessionsQuery(supabase: Client, seasonId: string | null | undefined, playerStatus: string | null | undefined) {
  const base = supabase.from('sessions').select('*').eq('status', 'open');
  const scoped = seasonId ? base.or(`season_id.eq.${seasonId},season_id.is.null`) : base;
  return onVisibleTracks(scoped, playerStatus)
    .order('date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: false });
}

/**
 * Every session in the same scope, open or closed, for the month grid. No
 * status filter: the session_status enum is ('open','closed') and nothing else.
 * season_id is for the month nav, which tells the active term's nights from
 * season-less ones (calendarMonthKeys).
 */
export function calendarSessionsQuery(supabase: Client, seasonId: string | null | undefined, playerStatus: string | null | undefined) {
  const base = supabase.from('sessions').select('id, name, date, start_time, status, season_id');
  const scoped = seasonId ? base.or(`season_id.eq.${seasonId},season_id.is.null`) : base;
  return onVisibleTracks(scoped, playerStatus)
    .order('date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: false });
}

/**
 * Club events from `lowerBoundIso` on. The status filter repeats what
 * club_events_member_read already enforces, on purpose, so the query says what
 * it returns without the reader having to know the policy.
 */
export function clubEventsCalendarQuery(supabase: Client, lowerBoundIso: string) {
  return supabase
    .from('club_events')
    .select(CLUB_EVENT_CALENDAR_COLUMNS)
    .in('status', ['published', 'cancelled'])
    .gte('starts_at', lowerBoundIso)
    .order('starts_at', { ascending: true })
    .limit(200);
}

/**
 * The season's published tournaments for the calendar. An explicit status
 * list, because tournaments_select is USING (TRUE) and a draft is readable.
 * Every column is on the verified-readable list in feed-tournament-query.test.ts.
 */
export function calendarTournamentsQuery(supabase: Client, seasonId: string | null | undefined) {
  return scopeToActiveSeason(
    supabase
      .from('tournaments')
      .select('id, name, start_date, end_date, status, suspended_at')
      .in('status', ['active', 'completed']),
    seasonId,
  ).order('start_date', { ascending: true });
}

/** The events this member has signed up for; club_event_signups_own_read scopes it too. */
export function mySignupsQuery(supabase: Client, playerId: string) {
  return supabase.from('club_event_signups').select('event_id').eq('player_id', playerId);
}
