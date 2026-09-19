import { redirect } from 'next/navigation';
import { CLUB_TIMEZONE } from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import { clubDayKey } from '@/lib/feed-activity';
import { formatDayKey, formatSeasonRange, seasonPickerOptions, type HistorySeason } from '@/lib/season-history';
import { pastLeaderboardEntries, type SnapshotRow } from '@/lib/past-leaderboard';
import LeaderboardClient, { type LeaderboardEntry, type LeaderboardRow } from './leaderboard-client';

// A season id arriving from the URL is checked against this before it is used in
// a filter. Postgres rejects a malformed uuid with an ERROR rather than an empty
// result, and there is no reason to send it one. Same constant, same reason, as
// my-stats/past-season.tsx:32.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How many archived rows one past season may draw. Set explicitly because
// PostgREST applies its OWN default max-rows otherwise, and a silently truncated
// ladder is not a slow page: it is a standings table that is wrong, with the
// bottom of the club missing and nothing on screen to say so. A club of a
// thousand members over one term is nowhere near this.
const PAST_SEASON_ROW_CAP = 2000;

// Public page (middleware allows /leaderboard for anon); get_leaderboard is
// anon-safe, so logged-out visitors see rankings with no "you" highlight.
//
// `?season=<uuid>` is a term that is over: the final standings the club archived
// when it rolled over, and a different set of sources rather than this page with
// a filter on it. See PastSeasonLadder below.
export default async function LeaderboardPage({
  searchParams,
}: {
  // Next 15 hands search params over as a promise.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const raw = params.season;
  const seasonParam = (typeof raw === 'string' ? raw : '').trim();
  if (seasonParam) return <PastSeasonLadder seasonId={seasonParam} />;
  return <CurrentLadder />;
}

async function CurrentLadder() {
  const { player } = await getViewer();
  const meId = player?.id ?? null;

  const supabase = await createServerSupabaseClient();

  // One anon-safe RPC returns every leaderboard-eligible player with ratings
  // and tournament points. We fetch once and let the client filter/sort each
  // tab in memory (fast) instead of re-querying per tab.
  //
  // The season list beside it is for the picker, and it goes through the SERVICE
  // ROLE for the same reason the past-season read does: 00128 revoked anon's
  // grants on `seasons`, so under the anon key this read comes back empty for
  // every logged-out visitor with no error at all, and the control that reaches
  // a finished season would simply not render on a public page.
  const admin = createServiceRoleClient();
  const [{ data }, seasonsRes] = await Promise.all([
    supabase.rpc('get_leaderboard'),
    admin
      .from('seasons')
      .select('id, name, start_date, end_date, active_flag, hidden_flag')
      .order('start_date', { ascending: false })
      .limit(40),
  ]);

  const entries: LeaderboardEntry[] = ((data ?? []) as LeaderboardRow[]).map((row) => ({
    id: row.id,
    full_name: row.name,
    handle: row.handle,
    avatar_url: row.avatar_url,
    status: row.status,
    ratings: {
      singles_elo: row.singles_elo,
      doubles_elo: row.doubles_elo,
      singles_wins: row.singles_wins,
      singles_losses: row.singles_losses,
      doubles_wins: row.doubles_wins,
      doubles_losses: row.doubles_losses,
      singles_provisional: row.singles_provisional,
      doubles_provisional: row.doubles_provisional,
      current_singles_streak: row.current_singles_streak,
      current_doubles_streak: row.current_doubles_streak,
    },
    _tournamentPoints: row.tournament_points,
  }));

  const seasons = (seasonsRes.data ?? []) as HistorySeason[];

  return (
    <LeaderboardClient
      key="current"
      initialPlayers={entries}
      meId={meId}
      pastSeason={null}
      seasonOptions={seasonPickerOptions(seasons, finishedSeasonIds(seasons), null)}
    />
  );
}

/**
 * The club's final standings for a term that is over.
 *
 * READ UNDER THE SERVICE ROLE, and it has to be. 00128 revoked ALL privileges on
 * `players`, `seasons` and `season_final_ratings` from PUBLIC and anon, so the
 * anon key cannot see any of the three. The live ladder gets around that by
 * calling get_leaderboard(), which is SECURITY DEFINER; there is no such function
 * for the archive. Reading this as the signed-in member instead would leave every
 * logged-out visitor with a blank ladder on a page middleware deliberately makes
 * public, and PostgREST reports a refused read as an EMPTY LIST rather than an
 * error, so nothing would be logged.
 *
 * The price of the service role is that it bypasses RLS and is not the function's
 * WHERE clause: the three visibility predicates get_leaderboard() applies are
 * restated in the query below and re-applied in lib/past-leaderboard.ts, because
 * nothing in the database is behind this read to catch a missing one.
 */
async function PastSeasonLadder({ seasonId }: { seasonId: string }) {
  if (!UUID.test(seasonId)) redirect('/leaderboard');

  const { player } = await getViewer();
  const meId = player?.id ?? null;

  const admin = createServiceRoleClient();

  const [seasonsRes, snapshotRes] = await Promise.all([
    admin
      .from('seasons')
      .select('id, name, start_date, end_date, active_flag, hidden_flag')
      .order('start_date', { ascending: false })
      .limit(40),
    // THE QUERY IS DRIVEN FROM THE ARCHIVE AND MUST NEVER BE INVERTED.
    //
    // Selecting from `players` and embedding the snapshot is a left join from
    // today's roster, which lists every present-day member with a null or zero
    // rating for a season they were never in. That is the backfill the owner
    // rejected: a member who joined last week would appear in the final standings
    // of a term that finished before they had heard of the club.
    // `season_final_ratings` IS the roster of record for that season, so it is
    // the parent, and `players` is the embed.
    //
    // `!inner` plus alias-path filters is the verified pattern here (see
    // my-stats/past-season.tsx:119-130). Two `.neq` calls rather than one
    // `not(..., 'in', ...)` string, which would put the app in charge of
    // PostgREST's quoting rules for no gain.
    admin
      .from('season_final_ratings')
      .select(
        'singles_elo, doubles_elo, archived_at, player:players!inner(id, full_name, handle, avatar_url, status, active_flag, hide_from_leaderboard)'
      )
      .eq('season_id', seasonId)
      .eq('player.active_flag', true)
      .eq('player.hide_from_leaderboard', false)
      .neq('player.status', 'pending_approval')
      .neq('player.status', 'suspended')
      .limit(PAST_SEASON_ROW_CAP),
  ]);

  const seasons = (seasonsRes.data ?? []) as HistorySeason[];
  const season = seasons.find((s) => s.id === seasonId) ?? null;

  // Not a season, or the one being played right now. The bare path is the
  // canonical address for "now" and there is no second version of it.
  //
  // AND A HIDDEN SEASON, which is the half that is easy to leave out. Taking a
  // season out of the picker only removes the link to it: the address stays
  // guessable and, worse, stays in the browser history and the shared messages
  // of anyone who opened it before it was hidden. The flag has to be enforced
  // where the page is SERVED, and the picker filter is then only a courtesy.
  // `=== true` for the same reason finishedSeasonIds uses it: a row with no
  // such key must not read as hidden.
  if (!season || season.active_flag || season.hidden_flag === true) {
    redirect('/leaderboard');
  }

  const rows = (snapshotRes.data ?? []) as SnapshotRow[];
  const entries = pastLeaderboardEntries(rows);

  // Taken from the RAW rows rather than from `entries`, so the label survives a
  // term whose whole ladder is hidden today. Labelled ARCHIVED and not "as of":
  // 00084_past_season_corrections_stay_in_the_past.sql:141 edits these rows when
  // an old match is corrected, so the timestamp is when the club wrote the
  // archive and not a promise about what has happened to it since.
  //
  // archived_at is a TIMESTAMPTZ while the season's own columns are DATEs, so it
  // goes through the club's clock before it is formatted: a rollover run at 5pm
  // in Vancouver is already tomorrow in UTC.
  const archivedIso = rows[0]?.archived_at ?? null;

  return (
    <LeaderboardClient
      // NOT COSMETIC, AND NOT AN OPTIMISATION. `activeTab`, `sortBy`,
      // `searchQuery` and `shown` are useState, and a query-string navigation
      // does not remount a client component, so a reader who had "Win %"
      // selected and then picked a finished season would carry that comparator
      // onto a ladder whose records are deliberately not loaded, and get the
      // archive in arbitrary order under a chip that still read Win %.
      key={seasonId}
      initialPlayers={entries}
      meId={meId}
      pastSeason={{
        id: season.id,
        name: season.name,
        range: formatSeasonRange(season),
        archivedAt: archivedIso ? formatDayKey(clubDayKey(archivedIso, CLUB_TIMEZONE)) : null,
      }}
      seasonOptions={seasonPickerOptions(seasons, finishedSeasonIds(seasons), seasonId)}
    />
  );
}

/**
 * Every finished season, for the picker.
 *
 * THE LEADERBOARD'S PICKER IS CLUB-WIDE, where /my-stats offers only the terms
 * the reader has an archived row of their own in. This is the club's ladder and
 * not anybody's history, so every season that is not the active one is offered,
 * including one that was created and never rolled over. That season's ladder is
 * empty, and the empty state says which of those two things happened.
 */
function finishedSeasonIds(seasons: HistorySeason[]): Set<string> {
  // `hidden_flag === true` rather than a truthy test, so a row that arrived
  // without the key (see HistorySeason) stays offered rather than vanishing.
  // The direct-URL guard in PastSeasonLadder repeats this: dropping a season
  // from the picker hides the door, not the room, and the two have to agree.
  return new Set(
    seasons.filter((s) => !s.active_flag && s.hidden_flag !== true).map((s) => s.id)
  );
}
