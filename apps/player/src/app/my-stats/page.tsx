import { createServerSupabaseClient, getViewer, getActiveSeason } from '@/lib/supabase-server';
import { getWinRate, getStreakDisplay, getPointDifferential, clubDate, formatRelativeTime, clubToday, formatMemberCode, TOURNAMENT_EVENT_TYPE_LABELS, selectInChunks } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Atomic, AvatarChip, PageHeader } from '@badminton/ui';
import { buildRatingSeries, buildOverallFormFlags, deriveAttendance, deriveSessionCadence, type RatingSourceRow, type FormSourceRow } from '@/lib/stats-charts';
import { RatingCard } from '@/components/my-stats/rating-card';
import { FormCard } from '@/components/my-stats/form-card';
import { AttendanceGrid } from '@/components/my-stats/attendance-grid';
import { SeasonPick } from '@/components/my-stats/season-pick';
import { seasonPickerOptions, summarizeSeason, type HistorySeason } from '@/lib/season-history';
import {
  deriveSeasonHeadToHead,
  deriveSeasonPartners,
  memberSeasonIds,
  previousPublishedSeason,
  seasonMatchCountQuery,
  seasonMatchesQuery,
  seasonsToProbe,
  type OwnSeasonMatch,
  type SeasonParticipantRow,
} from '@/lib/my-stats-season';
import { PastSeasonStats } from './past-season';
import { LiveRating } from '@/components/live-rating';
import { LiveMyStats } from '@/components/live-matches';

// The rating line, the form strip, the history table, head-to-head and best
// partners all read one window: the member's matches in the ACTIVE season and
// no other. 200 is well past a heavy term, so the cap should never bite; it is
// there so a data-entry accident cannot make one page fetch a career.
const MATCH_WINDOW = 200;

// How many of those get a row in the table. The table is a recent-results
// panel, not an archive.
const HISTORY_ROWS = 20;

// The wide layout is two columns; the phone is one. Both are laid out by the
// SAME markup — .me-col-* is `display: contents` under 1024px, which dissolves
// the two column wrappers so every card becomes a direct child of one flexbox
// and these numbers decide the phone's reading order. Above 1024px the wrappers
// become real columns and the same numbers order each column independently,
// which is why they ascend within a column as well as across the page.
//
// Read on a phone: the chart, then the form it produced, then attendance, then
// the tables that back all three up. That is the order the page had before it
// gained a second column, and it is the order it has to keep — this app is used
// standing up in a gym, and the desktop is the variant.
const ORDER = {
  rating: 1,
  form: 2,
  attendance: 3,
  matches: 4,
  headToHead: 5,
  divisionMix: 6,
  partners: 7,
  reliability: 8,
} as const;

/** A row of get_leaderboard(), narrowed to what a ladder position needs. */
type LadderRow = { id: string; singles_elo: number | null };

/** A row of seasonMatchesQuery(), as the page reads it. */
type SeasonMatch = {
  id: string;
  season_id: string | null;
  played_at: string | null;
  match_type: string | null;
  rated_flag: boolean | null;
  completed_flag: boolean | null;
  result_status: string | null;
  walkover_type: string | null;
  score_summary: string | null;
  participants: unknown;
};

/**
 * /my-stats is two screens behind one address.
 *
 * The bare path is this term. `?season=<id>` is a term that is over, which is a
 * different screen with different sources (see past-season.tsx): the live one
 * has an attendance rate, computed against the member's status TODAY, and a
 * current rating that a finished term does not.
 *
 * Every match-derived figure on BOTH screens is the chosen season's alone. The
 * live screen used to read the last 200 matches of a career and draw its match
 * table, form, rating line, head-to-head and partners from that, so a finished
 * term's matches sat under this term's name. Only the elo and the ladder
 * position are carried across seasons, because a rating is, by design.
 *
 * Dispatching at the top rather than branching inside means the live screen pays
 * nothing for the feature: it runs exactly the query set it always has, in one
 * round trip, with the season control added to its header.
 */
/**
 * A win rate needs games behind it.
 *
 * `getWinRate` answers '0%' for an empty record, which is the right answer
 * arithmetically and the wrong one on this page. Everywhere else that figure is
 * printed beside the W-L it came from, so '0-0 (0%)' reads as "nothing yet".
 * The two rating readouts below print the percentage ALONE, and a member who
 * has never played a rated match opened their own stats to be told they win 0%
 * of the time. That is a verdict, not a record.
 *
 * Local to this page on purpose: the shared helper keeps its arithmetic, and
 * the call sites that do show a W-L keep reading '0%' correctly.
 */
function winRateLine(wins: number, losses: number): string {
  return wins + losses > 0 ? getWinRate(wins, losses) : 'No games yet';
}

export default async function MyStatsPage({
  searchParams,
}: {
  // Next 15 hands search params over as a promise.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const raw = params.season;
  const seasonParam = (typeof raw === 'string' ? raw : '').trim();
  if (seasonParam) return <PastSeasonStats seasonId={seasonParam} />;
  return <CurrentSeasonStats />;
}

async function CurrentSeasonStats() {
  const { player } = await getViewer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const activeSeason = await getActiveSeason();
  const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;

  // The club's today, not UTC's. `toISOString().slice(0, 10)` is already
  // tomorrow in Vancouver from about 5pm, so from dinner onwards it would pull
  // TOMORROW's session into the attendance denominator — a session nobody has
  // attended yet, which drops every member's rate and breaks their streak every
  // single evening. clubToday() formats in America/Vancouver as YYYY-MM-DD,
  // which is the shape the DATE column compares against.
  const today = clubToday();

  const [reliabilityRes, matchRowsRes, walkoverEventsRes, tournamentNoShowsRes, seasonsRes, attendanceRes, sessionsRes, ladderRes, archivedSeasonsRes] = await Promise.all([
    supabase
      .from('reliability_metrics')
      .select('no_shows, late_cancellations, early_withdrawals, walkovers_received, matches_completed, walkover_flag')
      .eq('player_id', player.id)
      .maybeSingle(),
    // Based on `matches` rather than on `match_participants`, so ORDER BY
    // played_at is a real ordering. PostgREST cannot order parent rows by a
    // column of a to-one embed, so the participant-first version of this query
    // takes an arbitrary N rows and calls them recent.
    //
    // The ACTIVE season only. With no active season there is no term to show,
    // and every section says so rather than falling back to a career.
    activeSeason
      ? seasonMatchesQuery(supabase, player.id, activeSeason.id, MATCH_WINDOW)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('walkovers')
      .select('id, walkover_type, notice_hours, reported_at, status, challenge:challenges(type)')
      .eq('forfeit_player_id', player.id)
      .eq('status', 'confirmed')
      .order('reported_at', { ascending: false }),
    supabase
      .from('tournament_participants')
      .select('id, status, event:tournament_events(event_type, tournament:tournaments(name))')
      .eq('player_id', player.id)
      .eq('status', 'no_show'),
    // get_active_season() returns the name and the fees but not start_date, and
    // the chart needs that date to place the season divider — plus the season
    // BEFORE it, to find the prior-season rule. Both come out of one ordered
    // read rather than two round trips.
    // `end_date` and `active_flag` came along for the season control: a term is
    // past because it is not active, never because of where its dates sit — see
    // season-history.ts. The limit went from 8 to 40 with it, because 8 is a
    // club's fourth year and the control must not quietly stop offering the
    // oldest term a member played — these are five short columns.
    supabase
      .from('seasons')
      .select('id, name, start_date, end_date, active_flag, hidden_flag')
      .order('start_date', { ascending: false })
      .limit(40),
    supabase
      .from('session_attendance')
      .select('session_id, status')
      .eq('player_id', player.id),
    // Only sessions that have already happened. A session still to come is not
    // an absence, and counting it as one would drop every member's attendance
    // rate the moment the term's schedule is published.
    activeSeason
      ? supabase
          .from('sessions')
          .select('id, date, track')
          .eq('season_id', activeSeason.id)
          .lte('date', today)
          .order('date', { ascending: true })
      : Promise.resolve({ data: [] as { id: string; date: string; track: string }[] }),
    // The member's ladder position, for the third readout in the header.
    //
    // The same anon-safe RPC /leaderboard reads, over the same field that
    // page's opening tab ranks (Open Singles, by ELO) — but positioned by
    // RANK() rather than by list index; see where it is counted below.
    //
    // The member simply not appearing in these rows is a real answer and not a
    // zero: get_leaderboard INNER JOINs ratings and excludes pending,
    // suspended, deactivated and hidden members, all of whom have no ladder
    // position at all. 00053 already makes that case fail open rather than
    // read as last place, and so does this.
    supabase.rpc('get_leaderboard'),
    // Which finished terms this member has a place in — a season_final_ratings
    // row means they were on the ladder when the club closed that term off, and
    // that is exactly the set the season control should offer. At most one row
    // per season, so it is a handful of ids however long they have been here.
    supabase
      .from('season_final_ratings')
      .select('season_id')
      .eq('player_id', player.id),
  ]);

  // A refused read resolves with an error and no rows. Drawing that as "no
  // matches this season" would be a confident wrong answer about the member's
  // term, so it goes to the route's error boundary instead.
  if (matchRowsRes.error) {
    throw new Error(`Could not read this season's matches: ${matchRowsRes.error.message}`);
  }
  const reliability = reliabilityRes.data;
  const matchRows = (matchRowsRes.data ?? []) as SeasonMatch[];
  const walkoverEvents = walkoverEventsRes.data ?? [];
  const tournamentNoShows = tournamentNoShowsRes.data ?? [];
  const seasons = (seasonsRes.data ?? []) as HistorySeason[];
  const archivedSeasonIds = new Set(
    ((archivedSeasonsRes.data ?? []) as { season_id: string }[]).map((r) => r.season_id)
  );
  const attendanceRecords = (attendanceRes.data ?? []) as { session_id: string; status: string }[];
  const sessions = (sessionsRes.data ?? []) as { id: string; date: string; track: string }[];

  // 1-based, or null when the member is not on the ladder. Never 0 and never a
  // fallback to last place — see the query.
  //
  // Counted, not indexed. get_leaderboard() has no ORDER BY, so sorting its
  // rows and taking a position is ROW_NUMBER over an arbitrary order: a
  // brand-new member sits at the default rating alongside everyone else who
  // has not played, and their "rank" would then be a different number on every
  // refresh depending on how Postgres happened to return that tied block.
  // Counting how many members are strictly ABOVE them is RANK() — the same
  // definition 00053 uses for ladder position, for the same reason it gives:
  // "three of the club's players sit on 400 and ROW_NUMBER would invent an
  // ordering between them". Tied members therefore share a position here, and
  // this number can differ by a place or two from the one /leaderboard prints
  // beside a tied row, which numbers its list.
  const ladder = (ladderRes.data ?? []) as LadderRow[];
  const myLadderElo: number | null = r ? r.singles_elo : null;
  const ladderPosition =
    myLadderElo !== null && ladder.some((row) => row.id === player.id)
      ? 1 + ladder.filter((row) => (row.singles_elo ?? 0) > myLadderElo).length
      : null;

  // Matched on player_id rather than taken as `rows[0]`.
  //
  // The filter on the embedded resource is SUPPOSED to narrow the array to this
  // player as well as dropping matches they were not in, which would make the
  // first element theirs. If that is ever not true — a PostgREST version that
  // only filters the parent, a doubles match where the join comes back in a
  // different order — `rows[0]` is an OPPONENT, and the page renders their
  // win_flag and rating_delta as the member's own. Every chart on this page
  // would be plausibly wrong and nothing would fail. `player_id` is selected
  // precisely so the answer does not depend on that behaviour.
  const ownParticipant = (m: { participants: unknown }) => {
    const raw = m.participants;
    const rows = (Array.isArray(raw) ? raw : raw ? [raw] : []) as {
      player_id: string;
      win_flag: boolean | null;
      rating_delta: number | null;
      post_rating: number | null;
      team_side: string | null;
      points_scored: number | null;
      points_allowed: number | null;
    }[];
    return rows.find((p) => p.player_id === player.id) ?? null;
  };

  // One reshape feeding both chart builders, so the rating line and the form
  // strip can never disagree about which matches happened.
  const chartRows = matchRows.map((m) => {
    const p = ownParticipant(m as { participants: unknown });
    return {
      win_flag: p?.win_flag ?? null,
      rating_delta: p?.rating_delta ?? null,
      post_rating: p?.post_rating ?? null,
      match: {
        played_at: m.played_at as string | null,
        match_type: m.match_type as string | null,
        rated_flag: m.rated_flag as boolean | null,
        completed_flag: m.completed_flag as boolean | null,
        result_status: m.result_status as string | null,
      },
    };
  });
  const ratingRows: RatingSourceRow[] = chartRows;
  const formRows: FormSourceRow[] = chartRows;

  // THE SEASON'S OWN RECORD, COUNTED, NEVER READ OFF `ratings`.
  //
  // This is the same correction past-season.tsx already made, arriving late on
  // the live screen. Every counter on `ratings` except the elo, the provisional
  // flags and `*_matches_played` survives a rollover untouched: activate_season
  // rebases the ratings and zeroes matches played, and does not go near wins,
  // losses, points, games or streaks. So `r.singles_wins` is a LIFETIME figure,
  // and printing it under a heading that names the current season told a
  // returning member that this term is going exactly as well as every term they
  // have ever played put together.
  //
  // Counted from the season's rows already in hand, so this costs no extra
  // round trip. The one thing it cannot answer is games won and lost, which
  // live in match_games and are not in this query; see the strip below.
  const seasonRecord = summarizeSeason(
    matchRows.map((m) => {
      const p = ownParticipant(m as { participants: unknown });
      return {
        match_type: m.match_type as string | null,
        result_status: m.result_status as string | null,
        win_flag: p?.win_flag ?? null,
        points_scored: p?.points_scored ?? null,
        points_allowed: p?.points_allowed ?? null,
        played_at: m.played_at as string | null,
      };
    })
  );

  const activeSeasonRow = activeSeason ? seasons.find((s) => s.id === activeSeason.id) ?? null : null;
  // The last PUBLISHED season before the active one, and null in the club's
  // first season, which is the case the prior-season rule is skipped for. A
  // hidden season is stepped over: its archived rating is the one thing the
  // flag exists to keep off this page.
  const priorSeason = previousPublishedSeason(seasons, activeSeasonRow?.id ?? null);

  // Which finished terms the member played in without an archived rating for
  // them (see seasonsToProbe). A count each, never the rows.
  const probeIds = seasonsToProbe(seasons, archivedSeasonIds);

  // Every participant of the season's matches, for the table's opponent column
  // and for head-to-head and best partners. The main read keeps only the
  // member's own row, which is what makes its ORDER BY honest, so the other
  // sides come from here. Chunked because the ids go into a GET's query string.
  const seasonMatchIds = matchRows.map((m) => m.id);

  // season_final_ratings is only written when the NEXT season is activated
  // (00067), so the row to draw is the PREVIOUS season's: the active season has
  // no archived rating until it ends, and reading its id back would return
  // nothing and silently drop the context line.
  const [priorRatingsRes, probeResults, participantsRes] = await Promise.all([
    priorSeason
      ? supabase
          .from('season_final_ratings')
          .select('singles_elo, doubles_elo')
          .eq('season_id', priorSeason.id)
          .eq('player_id', player.id)
          .maybeSingle()
      : Promise.resolve(null),
    Promise.all(
      probeIds.map(async (seasonId) => {
        const res = await seasonMatchCountQuery(supabase, player.id, seasonId);
        return { seasonId, count: res.count, failed: Boolean(res.error) };
      })
    ),
    selectInChunks<SeasonParticipantRow & { player: unknown }>(seasonMatchIds, (ids) =>
      supabase
        .from('match_participants')
        .select('match_id, player_id, team_side, player:players(id, full_name, avatar_url)')
        .in('match_id', ids) as never
    ),
  ]);
  const priorRatings = priorRatingsRes?.data as { singles_elo: number; doubles_elo: number } | null | undefined;
  const seasonOptions = seasonPickerOptions(
    seasons,
    memberSeasonIds(archivedSeasonIds, probeResults),
    null
  );

  // Eligibility is judged against the member's CURRENT status, because a
  // status is a column and not a history — there is no record of what somebody
  // was in October. A member who moved from recreational to competitive
  // mid-season therefore has the season's earlier competitive sessions counted
  // against them. Naming it rather than approximating it: the alternative is a
  // guess about a past that is not stored.
  const attendance = deriveAttendance(sessions, attendanceRecords, player.status as string | null);

  // Derived from the sessions this member was ELIGIBLE for, not from every
  // session in the term: the footer sits under their grid and has to describe
  // the same set of squares. Returns null unless the term genuinely runs to a
  // timetable, in which case the line is simply not printed.
  const cadence = deriveSessionCadence(attendance.cells.map((c) => c.date));

  // Reliability card is only rendered when something is on record — players
  // with a clean history never see it.
  const hasReliabilityRecord =
    (reliability?.no_shows ?? 0) > 0 ||
    (reliability?.late_cancellations ?? 0) > 0 ||
    (reliability?.early_withdrawals ?? 0) > 0 ||
    (reliability?.walkovers_received ?? 0) > 0 ||
    reliability?.walkover_flag === true ||
    walkoverEvents.length > 0 ||
    tournamentNoShows.length > 0;

  // The discipline split, off the season record for the same reason as
  // everything else on this screen: read from `ratings` it answered "how have
  // you split your badminton, ever", under a heading naming this term.
  const singlesPlayed = seasonRecord.singles.wins + seasonRecord.singles.losses;
  const doublesPlayed = seasonRecord.doubles.wins + seasonRecord.doubles.losses;
  const totalPlayed = seasonRecord.played;
  const singlesPct = totalPlayed > 0 ? Math.round((singlesPlayed / totalPlayed) * 100) : 0;
  const doublesPct = totalPlayed > 0 ? 100 - singlesPct : 0;

  const created = (player.created_at as string | undefined) || '';
  const joined = created ? new Date(created).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase() : '';

  // `@kiera · MEMBER K3F9TQ2 · JOINED SEP 2025`, and whichever parts exist when
  // some do not. The handle is genuinely absent for anyone who has not chosen
  // one, and a member awaiting approval has no code yet.
  //
  // formatMemberCode rather than the column, so this page, the roster and the
  // admin console cannot drift on casing.
  const handle = (player.handle as string | null | undefined) || null;
  const memberCode = formatMemberCode(player.member_code);
  const identity = [
    handle ? `@${handle}` : null,
    memberCode ? `MEMBER ${memberCode}` : null,
    joined ? `JOINED ${joined}` : null,
  ].filter(Boolean).join(' · ');

  // Already newest-first from the query, so the table is a slice rather than
  // another sort.
  const recentMatches = matchRows.slice(0, HISTORY_ROWS);

  // Who each of those was against, off the season's participant read above.
  //
  // Opponents are picked by TEAM SIDE, not by "everyone who is not me": in
  // doubles the other two rows are opponents but the third is a PARTNER, and
  // naming a partner as the person you beat is a wrong answer that looks
  // completely plausible. Where NO row on the match carries a team_side (older
  // data) it falls back to every other participant — which in doubles can still
  // put a partner in the lead slot, so it is a legacy path and not a safe one;
  // it is preferred only to showing an em dash for every historic match.
  // Embeds can arrive as a one-element array; flattened once for all three
  // consumers.
  const participantRows: SeasonParticipantRow[] = (participantsRes.data ?? []).map((row) => {
    const raw = row.player;
    const p = (Array.isArray(raw) ? raw[0] : raw) as SeasonParticipantRow['player'] | undefined;
    return { match_id: row.match_id, player_id: row.player_id, team_side: row.team_side, player: p ?? null };
  });
  type OtherPlayer = { id: string; full_name: string; avatar_url?: string | null; team_side: string | null };
  const othersByMatch = new Map<string, OtherPlayer[]>();
  for (const row of participantRows) {
    if (row.player_id === player.id) continue;
    const p = row.player;
    if (!p) continue;
    const entry: OtherPlayer = { ...p, team_side: row.team_side };
    const list = othersByMatch.get(row.match_id);
    if (list) list.push(entry);
    else othersByMatch.set(row.match_id, [entry]);
  }
  const opponentsOf = (matchId: string, myTeamSide: string | null): OtherPlayer[] => {
    const others = othersByMatch.get(matchId) ?? [];
    if (!myTeamSide) return others;
    // Only the rows that KNOW they are on the other side. A null team_side on
    // the other row is unclassifiable, and dropping it is the safe direction:
    // an unnamed opponent is a gap, a partner named as an opponent is a lie.
    const known = others.filter((o) => o.team_side !== null);
    if (known.length === 0) return others;
    return known.filter((o) => o.team_side !== myTeamSide);
  };

  // Head-to-head and best partners for this term, from the same rows. Null when
  // the participant read failed: a read that did not happen has no answer, so
  // those two cards are not drawn rather than drawn empty.
  const ownSeasonMatches: OwnSeasonMatch[] = matchRows.map((m) => {
    const p = ownParticipant(m as { participants: unknown });
    return {
      id: m.id,
      match_type: m.match_type,
      result_status: m.result_status,
      walkover_type: m.walkover_type,
      own: p ? { team_side: p.team_side, win_flag: p.win_flag } : null,
    };
  });
  const h2h = participantsRes.error ? null : deriveSeasonHeadToHead(ownSeasonMatches, participantRows, player.id);
  const partners = participantsRes.error ? null : deriveSeasonPartners(ownSeasonMatches, participantRows, player.id);
  const seasonLabel = activeSeason?.name ?? 'this season';

  return (
    <div data-screen-label="My Stats">
      {/* Every figure on this screen hangs off one `ratings` row, and a member
          reads it hardest in the minutes after a match they did not enter the
          result for. Mounted HERE rather than in MyStatsPage above, because
          that wrapper also dispatches to PastSeasonStats for `?season=`, and a
          finished term reads season_final_ratings — an archived row that cannot
          move and has no live version to wait for. */}
      <LiveRating playerId={player.id} />
      {/* LiveRating above covers ONE row — `ratings` — which is the header's
          three readouts and the streak strip. Everything else on this screen
          is derived from the member's matches: the history table, the rating
          chart, the form strip, head-to-head and best partners. None of it
          moved when a match of theirs was confirmed by somebody else.

          Filtered to their own participant rows, which is the only per-member
          key that exists here — `matches` has no player column. Mounted beside
          LiveRating and for the same reason it is: not in MyStatsPage above,
          because that wrapper also dispatches to PastSeasonStats for
          `?season=`, and a finished term reads archived rows that cannot
          move. */}
      <LiveMyStats playerId={player.id} />
      <PageHeader
        title="My stats"
        sub={activeSeason ? activeSeason.name : undefined}
        // Shown even when the current term is the only option, unlike on the
        // club-wide screens: this page is scoped to one season now, and the
        // control is where a member reads which one. undefined only with no
        // active season, where there is nothing to name.
        actions={
          seasonOptions.length > 0 ? (
            <SeasonPick
              options={seasonOptions}
              selectedId={activeSeason?.id ?? null}
              basePath="/my-stats"
              showAlone
            />
          ) : undefined
        }
      />

      <div className="card-base reveal reveal-1" style={{ padding: 28, marginBottom: 24 }}>
        {/* grid-2 so the 980px media query (!important) collapses the inline
            'auto 1fr' columns to a single column on mobile. */}
        <div
          className="grid grid-2"
          style={{ gridTemplateColumns: 'auto 1fr', gap: 32, alignItems: 'center' }}
        >
          <div className="row" style={{ gap: 20 }}>
            <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="xl" ring />
            <div style={{ minWidth: 0 }}>
              <div
                className="me-id-name"
                style={{
                  fontFamily: 'var(--display)',
                  fontWeight: 700,
                  letterSpacing: '-.02em',
                  lineHeight: 1,
                  overflowWrap: 'anywhere',
                }}
              >
                {player.full_name}
              </div>
              {identity && (
                <div className="mono muted" style={{ fontSize: 12, marginTop: 6, overflowWrap: 'anywhere' }}>
                  {identity}
                </div>
              )}
              {!handle && (
                <div className="mono" style={{ fontSize: 12, marginTop: 6 }}>
                  <a href="/settings" style={{ color: 'var(--mute)', textDecoration: 'underline' }}>
                    Choose a handle
                  </a>
                </div>
              )}
              <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <span className={'pill ' + (player.status === 'competitive' ? 'pill-red' : 'pill-out')}>
                  {(player.status as string).replace('_', ' ').toUpperCase()}
                </span>
                {/* (x ?? 0) > 0, NOT `x && x > 0`. The original put the
                    truthiness test FIRST, so a streak of exactly 0 made that
                    first operand falsy and && returned the NUMBER 0, which React
                    renders as a literal "0" floating next to the status pill.
                    The `> 0` guard written immediately after it never ran. Only
                    zero ever leaked, which is why this survived review: a losing
                    streak is negative, negative is truthy, and -3 > 0 is false,
                    which React renders as nothing at all. */}
                {seasonRecord.singles.currentStreak > 0 && (
                  <span className="pill pill-out">W{seasonRecord.singles.currentStreak} singles</span>
                )}
              </div>
            </div>
          </div>

          {/* Three readouts, hairline-separated, pushed to the far end of the
              header. Rendered whether or not a ratings row exists — a member
              awaiting approval has none (00004 writes it when their status
              changes), and dropping the block for them leaves the widest part
              of the header empty on exactly the account that already looks
              emptiest. Missing values read as an em dash. */}
          <div className="me-readouts">
            <div className="stat">
              <div className="stat-label">RANK</div>
              <div className="stat-value" title="Your position on the open singles ladder">
                {ladderPosition === null ? '—' : `#${ladderPosition}`}
              </div>
              <div className="mono muted" style={{ fontSize: 11 }}>
                {ladderPosition === null ? 'Not on the ladder' : `of ${ladder.length}`}
              </div>
            </div>
            {/* The K factor used to be quoted on these two lines. It is a
                platform-wide setting rather than this member's, and printing
                it beside their own rating read as a number chosen for them
                personally. Provisional stays: that one IS about them. */}
            <div className="stat">
              <div className="stat-label">SINGLES</div>
              <div className="stat-value">{r ? r.singles_elo : '—'}</div>
              <div className="mono muted" style={{ fontSize: 11 }}>
                {r ? `${r.singles_provisional ? 'Provisional · ' : ''}${winRateLine(seasonRecord.singles.wins, seasonRecord.singles.losses)}` : 'Unrated'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">DOUBLES</div>
              <div className="stat-value">{r ? r.doubles_elo : '—'}</div>
              <div className="mono muted" style={{ fontSize: 11 }}>
                {r ? `${r.doubles_provisional ? 'Provisional · ' : ''}${winRateLine(seasonRecord.doubles.wins, seasonRecord.doubles.losses)}` : 'Unrated'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {r && (
        <div className="stat-strip reveal reveal-2" style={{ marginBottom: 24 }}>
          {/* THE "Best W0" LINE IS GONE, both of them. It read as a grade
              rather than as a record: a member who has never played saw
              "Best W0" under a streak of zero, which says the same nothing
              twice and says it as though it were a verdict. The streak value
              above is the whole of what this tile knows. */}
          <div>
            <div className="stat-label">SINGLES STREAK</div>
            <div className="stat-value">{getStreakDisplay(seasonRecord.singles.currentStreak)}</div>
          </div>
          <div>
            <div className="stat-label">DOUBLES STREAK</div>
            <div className="stat-value">{getStreakDisplay(seasonRecord.doubles.currentStreak)}</div>
          </div>
          <div>
            <div className="stat-label">RELIABILITY</div>
            <div className="stat-value">{reliability?.no_shows ?? 0}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              No-shows · {reliability?.late_cancellations ?? 0} late w/d
            </div>
          </div>
          {/* THE "Games W-L" SUB-LINES ARE GONE from both point-diff tiles.
              Game counts live only on `ratings`, which never resets them, and
              there is no per-game data in this page's query to count the season
              from: match_games is keyed by match and would be a second round
              trip. A lifetime figure sitting under a season heading is the
              defect this whole block was rewritten to remove, so the line is
              withheld rather than quietly left wrong. It can come back as a
              season figure the day this page reads match_games. */}
          <div>
            <div className="stat-label">SINGLES POINT DIFF</div>
            <div className="stat-value">
              {getPointDifferential(seasonRecord.singles.pointDiff, 0)}
            </div>
          </div>
          <div>
            <div className="stat-label">DOUBLES POINT DIFF</div>
            <div className="stat-value">
              {getPointDifferential(seasonRecord.doubles.pointDiff, 0)}
            </div>
          </div>
          <div>
            <div className="stat-label">TOTAL MATCHES</div>
            <div className="stat-value">{seasonRecord.played}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              {seasonRecord.singles.wins + seasonRecord.singles.losses} singles ·{' '}
              {seasonRecord.doubles.wins + seasonRecord.doubles.losses} doubles
            </div>
          </div>
        </div>
      )}

      {/* Two columns on a wide screen, one on a phone, from one set of markup.
          .me-col-* dissolves under 1024px (display: contents) so every card
          below becomes a direct child of .me-layout's flexbox and ORDER decides
          the reading order; above it the wrappers are the columns. Nothing here
          is duplicated per breakpoint — see ORDER and globals.css. */}
      <div className="me-layout">
        <div className="me-col-main">
          <div style={{ order: ORDER.rating }}>
            {r ? (
              <RatingCard
                singles={{
                  elo: r.singles_elo,
                  provisional: r.singles_provisional === true,
                  // Season-counted, matching the readouts in the header. The
                  // elo beside them is genuinely cumulative and stays as it is:
                  // a rating carries across a rollover by design, a record does
                  // not.
                  wins: seasonRecord.singles.wins,
                  losses: seasonRecord.singles.losses,
                  points: buildRatingSeries(ratingRows, 'singles'),
                  priorRating: priorRatings?.singles_elo ?? null,
                }}
                doubles={{
                  elo: r.doubles_elo,
                  provisional: r.doubles_provisional === true,
                  wins: seasonRecord.doubles.wins,
                  losses: seasonRecord.doubles.losses,
                  points: buildRatingSeries(ratingRows, 'doubles'),
                  priorRating: priorRatings?.doubles_elo ?? null,
                }}
                priorSeasonName={priorSeason?.name ?? null}
                // No divider: every point is this season's now, and season dates
                // are set by hand, so a match stamped with this season but played
                // before its start_date would draw a boundary through the term.
                seasonStart={null}
                seasonName={activeSeason?.name ?? null}
              />
            ) : (
              // No ratings row at all — 00004 writes one when a member is
              // approved, so this is the pending account. The card stays and
              // says why rather than vanishing, which would leave the wide
              // layout's main column empty beside a populated rail.
              <div className="card-base">
                <div className="card-head">
                  <h3 className="card-title">Rating over time</h3>
                </div>
                <div className="empty" style={{ padding: '32px 20px' }}>
                  <div className="empty-title">Your rating starts at approval</div>
                  <div className="empty-hint">
                    An exec has to approve your membership before you can be rated. Your
                    chart begins with your first confirmed match after that.
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="card-base" style={{ padding: 0, overflow: 'hidden', order: ORDER.matches }}>
            <div
              className="card-head"
              style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0 }}
            >
              <h3 className="card-title">Recent matches</h3>
              {recentMatches.length > 0 && (
                <span className="tag">
                  {recentMatches.length === matchRows.length
                    ? `${recentMatches.length} played`
                    : `LAST ${recentMatches.length}`}
                </span>
              )}
            </div>
            {recentMatches.length === 0 ? (
              <div className="empty" style={{ padding: '32px 20px' }}>
                <div className="empty-title">No matches in {seasonLabel} yet</div>
                <div className="empty-hint">
                  Issue a challenge, or turn up to a session and play one. Every confirmed
                  result this season lands here with the rating it moved.
                </div>
              </div>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table className="data-table" style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th>Opponent</th>
                      <th>Format</th>
                      <th className="num" style={{ textAlign: 'right' }}>Score</th>
                      <th>Result</th>
                      <th className="num" style={{ textAlign: 'right' }}>Swing</th>
                      <th className="num" style={{ textAlign: 'right' }}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentMatches.map((m) => {
                      const p = ownParticipant(m as { participants: unknown });
                      if (!p) return null;
                      const isWin = p.win_flag === true;
                      const isLoss = p.win_flag === false;
                      const delta = p.rating_delta;
                      const deltaStr = typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${delta}` : '—';
                      const opponents = opponentsOf(m.id as string, p.team_side);
                      const lead = opponents[0] ?? null;
                      return (
                        <tr key={m.id as string}>
                          <td>
                            {lead ? (
                              <span className="row" style={{ gap: 8 }}>
                                <AvatarChip name={lead.full_name} id={lead.id} src={lead.avatar_url} size="sm" />
                                <span style={{ minWidth: 0 }}>
                                  {lead.full_name}
                                  {opponents.length > 1 && (
                                    <span className="mono muted" style={{ fontSize: 11, marginLeft: 6 }}>
                                      +{opponents.length - 1}
                                    </span>
                                  )}
                                </span>
                              </span>
                            ) : (
                              <span className="mono muted">—</span>
                            )}
                          </td>
                          <td>
                            <span className="tag">{(m.match_type as string)?.toUpperCase()}</span>
                          </td>
                          {/* Atomic keeps `21-17, 21-19` from breaking after a
                              hyphen, which reads as a different scoreline. */}
                          <td className="num" style={{ textAlign: 'right' }}>
                            {m.score_summary ? (
                              <Atomic separator=",">{m.score_summary as string}</Atomic>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            {isWin ? (
                              <span className="mono" style={{ color: 'var(--win)', fontWeight: 600 }}>WIN</span>
                            ) : isLoss ? (
                              <span className="mono" style={{ color: 'var(--loss)', fontWeight: 600 }}>LOSS</span>
                            ) : (
                              <span className="mono muted">—</span>
                            )}
                          </td>
                          <td
                            className="num"
                            style={{
                              fontWeight: 600,
                              textAlign: 'right',
                              color: typeof delta !== 'number' ? 'var(--mute)' : delta >= 0 ? 'var(--win)' : 'var(--loss)',
                            }}
                          >
                            {deltaStr}
                          </td>
                          <td className="num mono muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {m.played_at ? formatRelativeTime(m.played_at as string) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Not drawn when its read failed (h2h is null), rather than
              drawn as an empty record. */}
          {h2h && (
            <div className="card-base" style={{ order: ORDER.headToHead }}>
              <div className="card-head">
                <h3 className="card-title">Head-to-head</h3>
                {h2h.length > 0 && <span className="tag">{h2h.length} opponents</span>}
              </div>
              {h2h.length === 0 ? (
                <div className="empty" style={{ padding: '28px 20px' }}>
                  <div className="empty-title">No opponents in {seasonLabel} yet</div>
                  <div className="empty-hint">
                    Your record against each player you face this season builds up here.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {h2h.map((h) => (
                    <div key={`${h.opponent.id}:${h.match_type}`} className="list-row">
                      <AvatarChip name={h.opponent.full_name} id={h.opponent.id} src={h.opponent.avatar_url} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div className="row-title">{h.opponent.full_name}</div>
                        <div className="row-sub">{h.match_type.toUpperCase()}</div>
                      </div>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        <span style={{ color: 'var(--win)' }}>{h.wins}W</span>
                        <span className="muted" style={{ margin: '0 4px' }}>·</span>
                        <span style={{ color: 'var(--loss)' }}>{h.losses}L</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="me-col-side">
          {/* The two cards the rail exists for. Both render unconditionally —
              a rail that appears only once a member has a history is a rail
              that is missing on the account with the most empty space, which is
              the whole complaint this layout answers. Each says what it will
              show and how to make it show something. */}
          <div style={{ order: ORDER.form }}>
            <FormCard winFlags={buildOverallFormFlags(formRows)} seasonName={seasonLabel} />
          </div>

          <div className="card-base" style={{ order: ORDER.attendance }}>
            <div className="card-head">
              <h3 className="card-title">Attendance</h3>
              {activeSeason && <span className="tag">{activeSeason.name}</span>}
            </div>
            <div className="card-sub" style={{ marginBottom: 18 }}>
              One square per session you could attend — filled when you were there
            </div>
            <AttendanceGrid
              summary={attendance}
              seasonName={activeSeason?.name ?? null}
              cadence={cadence}
            />
          </div>

          {totalPlayed > 0 && (
            <div className="card-base" style={{ order: ORDER.divisionMix }}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>Division mix</h3>
              <div className="card-sub" style={{ marginBottom: 18 }}>How you split your time</div>
              {[
                // THE RECORD AND THE PERCENTAGE HAVE TO COME FROM THE SAME
                // PLACE. These two read `r.singles_wins` while `pct` was
                // already derived from the season, which rendered "0W-0L .
                // 100%" on a member with a 1-1 season: a bar at full width
                // beside a record saying nothing was played. Both halves are
                // the season now, which is what the card's own heading claims.
                { label: 'Singles', pct: singlesPct, w: seasonRecord.singles.wins, l: seasonRecord.singles.losses, color: 'var(--red)' },
                { label: 'Doubles', pct: doublesPct, w: seasonRecord.doubles.wins, l: seasonRecord.doubles.losses, color: 'var(--ink)' },
              ].map((d) => (
                <div key={d.label} style={{ marginBottom: 14 }}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{d.label}</span>
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      {d.w}W–{d.l}L · {d.pct}%
                    </span>
                  </div>
                  <div className="capacity-bar" style={{ height: 6 }}>
                    <div className="fill" style={{ width: `${d.pct}%`, background: d.color }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {partners && (
            <div className="card-base" style={{ order: ORDER.partners }}>
              <div className="card-head">
                <h3 className="card-title">Best partners</h3>
                <span className="tag tag-gold">DOUBLES</span>
              </div>
              {partners.length === 0 ? (
                <div className="empty" style={{ padding: '28px 20px' }}>
                  <div className="empty-title">No regular partner in {seasonLabel} yet</div>
                  <div className="empty-hint">
                    Play three doubles matches with the same partner this season and they show up here.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {partners.map((p) => (
                    <div key={p.partner.id} className="list-row">
                      <AvatarChip name={p.partner.full_name} id={p.partner.id} src={p.partner.avatar_url} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div className="row-title">{p.partner.full_name}</div>
                        <div className="row-sub">
                          {p.wins}W–{p.losses}L
                        </div>
                      </div>
                      <span className="tag tag-gold">{Math.round(p.winRate)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hasReliabilityRecord && (
            <div className="card-base" style={{ order: ORDER.reliability }}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>Reliability</h3>
              <div className="card-sub" style={{ marginBottom: 18 }}>No-shows and withdrawals on record</div>
              {reliability?.walkover_flag && (
                <div
                  style={{
                    border: '1px solid var(--loss)',
                    background: 'var(--red-wash)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    marginBottom: 14,
                  }}
                >
                  <div style={{ fontWeight: 600, color: 'var(--loss)', fontSize: 13 }}>
                    Flagged for repeated no-shows — contact an exec.
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: (walkoverEvents.length > 0 || tournamentNoShows.length > 0) ? 14 : 0 }}>
                {[
                  { label: 'No-shows', value: reliability?.no_shows ?? 0 },
                  { label: 'Late withdrawals (<24h notice)', value: reliability?.late_cancellations ?? 0 },
                  { label: 'Withdrawals', value: reliability?.early_withdrawals ?? 0 },
                  { label: 'Walkovers received', value: reliability?.walkovers_received ?? 0 },
                ].map((row) => (
                  <div key={row.label} className="list-row">
                    <div style={{ flex: 1 }}>
                      <div className="row-title">{row.label}</div>
                    </div>
                    <span className="mono" style={{ fontWeight: 600, color: row.value > 0 ? 'var(--loss)' : 'var(--mute)' }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
              {(walkoverEvents.length > 0 || tournamentNoShows.length > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                  {walkoverEvents.map((w) => {
                    const challengeRaw = w.challenge as unknown;
                    const challenge = (Array.isArray(challengeRaw) ? challengeRaw[0] : challengeRaw) as { type: string } | null;
                    // <24h notice = "late" — same cutoff the walkover flow uses to
                    // increment late_cancellations vs early_withdrawals.
                    const label = w.walkover_type === 'no_show'
                      ? 'No-show'
                      : (w.notice_hours ?? 0) < 24 ? 'Late withdrawal' : 'Withdrawal';
                    return (
                      <div key={w.id} className="list-row">
                        <div style={{ flex: 1 }}>
                          <div className="row-title">{label}</div>
                          <div className="row-sub">{clubDate(w.reported_at)}</div>
                        </div>
                        {challenge && <span className="tag">{challenge.type.toUpperCase()}</span>}
                      </div>
                    );
                  })}
                  {tournamentNoShows.map((tp) => {
                    const eventRaw = tp.event as unknown;
                    const event = (Array.isArray(eventRaw) ? eventRaw[0] : eventRaw) as { event_type: string; tournament: unknown } | null;
                    const tournamentRaw = event?.tournament;
                    const tournament = (Array.isArray(tournamentRaw) ? tournamentRaw[0] : tournamentRaw) as { name: string } | null;
                    const eventLabel = event ? (TOURNAMENT_EVENT_TYPE_LABELS[event.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ?? event.event_type) : '';
                    return (
                      <div key={tp.id} className="list-row">
                        <div style={{ flex: 1 }}>
                          <div className="row-title">Tournament no-show</div>
                          <div className="row-sub">
                            {[tournament?.name, eventLabel].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
