import { createServerSupabaseClient, getCurrentPlayer, getActiveSeason } from '@/lib/supabase-server';
import { getWinRate, getOverallRecord, getStreakDisplay, getPointDifferential, formatDate, formatRelativeTime, clubToday, TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { Atomic, AvatarChip, PageHeader } from '@badminton/ui';
import { buildRatingSeries, buildOverallFormFlags, deriveAttendance, deriveSessionCadence, type RatingSourceRow, type FormSourceRow } from '@/lib/stats-charts';
import { formatMemberIdentifier } from '@/lib/member-identifier';
import { RatingCard } from '@/components/my-stats/rating-card';
import { FormCard } from '@/components/my-stats/form-card';
import { AttendanceGrid } from '@/components/my-stats/attendance-grid';

// The rating line, the form strip and the history table all read one window of
// the member's matches. 200 is a season and a half of heavy play — deep enough
// that the season divider has old-season matches to sit after, and bounded so
// somebody four years in does not pull their whole career over the wire to draw
// forty points.
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

export default async function MyStatsPage() {
  const player = await getCurrentPlayer();
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

  const [reliabilityRes, matchRowsRes, h2hRes, partnersRes, walkoverEventsRes, tournamentNoShowsRes, seasonsRes, attendanceRes, sessionsRes, ladderRes] = await Promise.all([
    supabase
      .from('reliability_metrics')
      .select('no_shows, late_cancellations, early_withdrawals, walkovers_received, matches_completed, walkover_flag')
      .eq('player_id', player.id)
      .maybeSingle(),
    // Based on `matches` rather than on `match_participants`, so ORDER BY
    // played_at is a real ordering. PostgREST cannot order parent rows by a
    // column of a to-one embed, so the participant-first version of this query
    // takes an arbitrary N rows and calls them recent — correct for a member
    // with fifty matches, silently wrong for one with three hundred.
    //
    // `!inner` plus the filter on the embedded resource drops matches this
    // player was not in. It is also supposed to narrow the embedded array to
    // their own participant row — but ownParticipant() below does not rely on
    // that, and `player_id` is in the select so it does not have to.
    supabase
      .from('matches')
      .select('id, played_at, match_type, format, rated_flag, completed_flag, result_status, score_summary, participants:match_participants!inner(id, player_id, win_flag, rating_delta, post_rating, team_side)')
      .eq('participants.player_id', player.id)
      .not('played_at', 'is', null)
      .order('played_at', { ascending: false })
      .limit(MATCH_WINDOW),
    supabase
      .from('head_to_head_stats')
      .select('id, player_a_id, player_b_id, player_a_wins, player_b_wins, total_matches, match_type, a:players!head_to_head_stats_player_a_id_fkey(id, full_name, avatar_url), b:players!head_to_head_stats_player_b_id_fkey(id, full_name, avatar_url)')
      .or(`player_a_id.eq.${player.id},player_b_id.eq.${player.id}`)
      .order('total_matches', { ascending: false })
      .limit(10),
    supabase
      .from('partnership_stats')
      .select('id, wins, losses, win_rate, total_matches, partner:players!partnership_stats_partner_id_fkey(id, full_name, avatar_url)')
      .eq('player_id', player.id)
      .gte('total_matches', 3)
      .order('win_rate', { ascending: false })
      .limit(5),
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
    supabase
      .from('seasons')
      .select('id, name, start_date')
      .order('start_date', { ascending: false })
      .limit(8),
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
  ]);

  const reliability = reliabilityRes.data;
  const matchRows = matchRowsRes.data ?? [];
  const h2h = h2hRes.data ?? [];
  const partners = partnersRes.data ?? [];
  const walkoverEvents = walkoverEventsRes.data ?? [];
  const tournamentNoShows = tournamentNoShowsRes.data ?? [];
  const seasons = (seasonsRes.data ?? []) as { id: string; name: string; start_date: string }[];
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

  const activeSeasonRow = activeSeason ? seasons.find((s) => s.id === activeSeason.id) ?? null : null;
  // The season before the active one, by start date. `seasons` came back newest
  // first, so it is simply the next entry — and null in the club's first
  // season, which is the case the prior-season rule is skipped for.
  const activeIndex = activeSeasonRow ? seasons.findIndex((s) => s.id === activeSeasonRow.id) : -1;
  const priorSeason = activeIndex >= 0 ? seasons[activeIndex + 1] ?? null : null;

  // season_final_ratings is only written when the NEXT season is activated
  // (00067), so the row to draw is the PREVIOUS season's: the active season has
  // no archived rating until it ends, and reading its id back would return
  // nothing and silently drop the context line.
  const priorRatingsRes = priorSeason
    ? await supabase
        .from('season_final_ratings')
        .select('singles_elo, doubles_elo')
        .eq('season_id', priorSeason.id)
        .eq('player_id', player.id)
        .maybeSingle()
    : null;
  const priorRatings = priorRatingsRes?.data as { singles_elo: number; doubles_elo: number } | null | undefined;

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

  const singlesPlayed = (r?.singles_wins ?? 0) + (r?.singles_losses ?? 0);
  const doublesPlayed = (r?.doubles_wins ?? 0) + (r?.doubles_losses ?? 0);
  const { played: totalPlayed } = getOverallRecord({
    singles_wins: r?.singles_wins ?? 0,
    singles_losses: r?.singles_losses ?? 0,
    doubles_wins: r?.doubles_wins ?? 0,
    doubles_losses: r?.doubles_losses ?? 0,
  });
  const singlesPct = totalPlayed > 0 ? Math.round((singlesPlayed / totalPlayed) * 100) : 0;
  const doublesPct = totalPlayed > 0 ? 100 - singlesPct : 0;

  const created = (player.created_at as string | undefined) || '';
  const joined = created ? new Date(created).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase() : '';

  // `@kiera · MEMBER #0042 · JOINED SEP 2025`, and whichever parts exist when
  // some do not. The handle is genuinely absent for anyone who has not chosen
  // one, and a member awaiting approval has no identifier yet.
  //
  // The identifier goes through formatMemberIdentifier and NOT through the
  // column, because its shape is mid-change — see lib/member-identifier.ts for
  // the seam and why it takes `unknown`.
  const handle = (player.handle as string | null | undefined) || null;
  const memberIdentifier = formatMemberIdentifier(player.member_number);
  const identity = [
    handle ? `@${handle}` : null,
    memberIdentifier ? `MEMBER ${memberIdentifier}` : null,
    joined ? `JOINED ${joined}` : null,
  ].filter(Boolean).join(' · ');

  // Already newest-first from the query, so the table is a slice rather than
  // another sort.
  const recentMatches = matchRows.slice(0, HISTORY_ROWS);

  // Who each of those was against.
  //
  // The main query filters the embedded participants down to this member, which
  // is what makes ORDER BY played_at honest — so it cannot also carry the other
  // side. One extra read, scoped to the twenty match ids the table actually
  // draws, rather than widening the 200-row window to pull every participant of
  // every match a member has ever played.
  //
  // Opponents are picked by TEAM SIDE, not by "everyone who is not me": in
  // doubles the other two rows are opponents but the third is a PARTNER, and
  // naming a partner as the person you beat is a wrong answer that looks
  // completely plausible. Where NO row on the match carries a team_side (older
  // data) it falls back to every other participant — which in doubles can still
  // put a partner in the lead slot, so it is a legacy path and not a safe one;
  // it is preferred only to showing an em dash for every historic match.
  const historyIds = recentMatches.map((m) => m.id as string);
  const opponentRowsRes = historyIds.length
    ? await supabase
        .from('match_participants')
        .select('match_id, player_id, team_side, player:players(id, full_name, avatar_url)')
        .in('match_id', historyIds)
    : null;
  type OpponentRow = {
    match_id: string;
    player_id: string;
    team_side: string | null;
    player: unknown;
  };
  type OtherPlayer = { id: string; full_name: string; avatar_url?: string | null; team_side: string | null };
  const othersByMatch = new Map<string, OtherPlayer[]>();
  for (const row of (opponentRowsRes?.data ?? []) as OpponentRow[]) {
    if (row.player_id === player.id) continue;
    const raw = row.player;
    const p = (Array.isArray(raw) ? raw[0] : raw) as { id: string; full_name: string; avatar_url?: string | null } | null;
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

  return (
    <div data-screen-label="My Stats">
      <PageHeader
        title="My stats"
        sub={activeSeason ? activeSeason.name : undefined}
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
                {r?.current_singles_streak && r.current_singles_streak > 0 && (
                  <span className="pill pill-out">W{r.current_singles_streak} singles</span>
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
                {r ? `${r.singles_provisional ? 'Provisional · ' : ''}${getWinRate(r.singles_wins, r.singles_losses)}` : 'Unrated'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">DOUBLES</div>
              <div className="stat-value">{r ? r.doubles_elo : '—'}</div>
              <div className="mono muted" style={{ fontSize: 11 }}>
                {r ? `${r.doubles_provisional ? 'Provisional · ' : ''}${getWinRate(r.doubles_wins, r.doubles_losses)}` : 'Unrated'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {r && (
        <div className="stat-strip reveal reveal-2" style={{ marginBottom: 24 }}>
          <div>
            <div className="stat-label">SINGLES STREAK</div>
            <div className="stat-value">{getStreakDisplay(r.current_singles_streak)}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Best W{r.best_singles_streak ?? 0}
            </div>
          </div>
          <div>
            <div className="stat-label">DOUBLES STREAK</div>
            <div className="stat-value">{getStreakDisplay(r.current_doubles_streak)}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Best W{r.best_doubles_streak ?? 0}
            </div>
          </div>
          <div>
            <div className="stat-label">RELIABILITY</div>
            <div className="stat-value">{reliability?.no_shows ?? 0}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              No-shows · {reliability?.late_cancellations ?? 0} late w/d
            </div>
          </div>
          <div>
            <div className="stat-label">SINGLES POINT DIFF</div>
            <div className="stat-value">
              {getPointDifferential(r.singles_points_scored, r.singles_points_allowed)}
            </div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Games {r.singles_games_won}–{r.singles_games_lost}
            </div>
          </div>
          <div>
            <div className="stat-label">DOUBLES POINT DIFF</div>
            <div className="stat-value">
              {getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed)}
            </div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Games {r.doubles_games_won}–{r.doubles_games_lost}
            </div>
          </div>
          <div>
            <div className="stat-label">TOTAL MATCHES</div>
            <div className="stat-value">{totalPlayed}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              {(r.singles_matches_played ?? 0)} singles · {(r.doubles_matches_played ?? 0)} doubles
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
                  wins: r.singles_wins ?? 0,
                  losses: r.singles_losses ?? 0,
                  points: buildRatingSeries(ratingRows, 'singles'),
                  priorRating: priorRatings?.singles_elo ?? null,
                }}
                doubles={{
                  elo: r.doubles_elo,
                  provisional: r.doubles_provisional === true,
                  wins: r.doubles_wins ?? 0,
                  losses: r.doubles_losses ?? 0,
                  points: buildRatingSeries(ratingRows, 'doubles'),
                  priorRating: priorRatings?.doubles_elo ?? null,
                }}
                priorSeasonName={priorSeason?.name ?? null}
                seasonStart={activeSeasonRow?.start_date ?? null}
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
                <div className="empty-title">No matches yet</div>
                <div className="empty-hint">
                  Issue a challenge, or turn up to a session and play one. Every confirmed
                  result lands here with the rating it moved.
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

          {h2h.length > 0 && (
            <div className="card-base" style={{ order: ORDER.headToHead }}>
              <div className="card-head">
                <h3 className="card-title">Head-to-head</h3>
                <span className="tag">{h2h.length} opponents</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {h2h.map((h) => {
                  const isA = h.player_a_id === player.id;
                  const opponentRaw = isA ? h.b : h.a;
                  const opponent = (Array.isArray(opponentRaw) ? opponentRaw[0] : opponentRaw) as { id: string; full_name: string; avatar_url?: string | null } | null;
                  if (!opponent) return null;
                  const wins = isA ? h.player_a_wins : h.player_b_wins;
                  const losses = isA ? h.player_b_wins : h.player_a_wins;
                  return (
                    <div key={h.id} className="list-row">
                      <AvatarChip name={opponent.full_name} id={opponent.id} src={opponent.avatar_url} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div className="row-title">{opponent.full_name}</div>
                        <div className="row-sub">{(h.match_type as string)?.toUpperCase()}</div>
                      </div>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        <span style={{ color: 'var(--win)' }}>{wins}W</span>
                        <span className="muted" style={{ margin: '0 4px' }}>·</span>
                        <span style={{ color: 'var(--loss)' }}>{losses}L</span>
                      </span>
                    </div>
                  );
                })}
              </div>
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
            <FormCard winFlags={buildOverallFormFlags(formRows)} />
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
                { label: 'Singles', pct: singlesPct, w: r?.singles_wins ?? 0, l: r?.singles_losses ?? 0, color: 'var(--red)' },
                { label: 'Doubles', pct: doublesPct, w: r?.doubles_wins ?? 0, l: r?.doubles_losses ?? 0, color: 'var(--ink)' },
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

          {partners.length > 0 && (
            <div className="card-base" style={{ order: ORDER.partners }}>
              <div className="card-head">
                <h3 className="card-title">Best partners</h3>
                <span className="tag tag-gold">DOUBLES</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {partners.map((p) => {
                  const partnerRaw = p.partner as unknown;
                  const partner = (Array.isArray(partnerRaw) ? partnerRaw[0] : partnerRaw) as { id: string; full_name: string; avatar_url?: string | null } | null;
                  if (!partner) return null;
                  return (
                    <div key={p.id} className="list-row">
                      <AvatarChip name={partner.full_name} id={partner.id} src={partner.avatar_url} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div className="row-title">{partner.full_name}</div>
                        <div className="row-sub">
                          {p.wins}W–{p.losses}L
                        </div>
                      </div>
                      <span className="tag tag-gold">{Math.round((p.win_rate ?? 0) * 100)}%</span>
                    </div>
                  );
                })}
              </div>
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
                          <div className="row-sub">{formatDate(w.reported_at)}</div>
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
