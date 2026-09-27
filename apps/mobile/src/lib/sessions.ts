import { activeSeasonOrFilter } from '@badminton/shared/src/utils/active-season';
import { visibleTracksFor } from '@badminton/shared/src/utils/session-track';
import { clubToday } from '@badminton/shared/src/utils/session-window';
import type { MobileClient } from './supabase/client';

export interface UpcomingSession {
  id: string;
  name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string;
  track: string;
}

/**
 * Open sessions from today on, in the active season (and season-less ones),
 * on the member's tracks. The same scope as the web's schedule
 * (apps/player/src/lib/home-schedule-queries.ts), with "today" taken on the
 * club's clock rather than the phone's.
 */
export async function loadUpcomingSessions(
  supabase: MobileClient,
  playerStatus: string | null,
): Promise<UpcomingSession[]> {
  const season = await supabase.rpc('get_active_season');
  if (season.error) throw new Error(`Could not read the season: ${season.error.message}`);
  const seasonFilter = activeSeasonOrFilter(season.data?.[0]?.id);

  let query = supabase
    .from('sessions')
    .select('id, name, date, start_time, end_time, location, track')
    .eq('status', 'open')
    .in('track', visibleTracksFor(playerStatus))
    .gte('date', clubToday());
  if (seasonFilter) query = query.or(seasonFilter);
  const { data, error } = await query
    .order('date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Could not read sessions: ${error.message}`);
  return data ?? [];
}
