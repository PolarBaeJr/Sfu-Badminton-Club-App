import { redirect } from 'next/navigation';
import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Atomic, AvatarChip, PageHeader } from '@badminton/ui';
import { CLUB_TIMEZONE, selectInChunks } from '@badminton/shared';
import { clubDayKey } from '@/lib/feed-activity';
import { buildRatingSeries, formatSigned, type RatingSourceRow } from '@/lib/stats-charts';
import {
  formatDayKey,
  formatSeasonRange,
  joinedAfterSeason,
  nextSeasonAfter,
  seasonEmptyReason,
  seasonPickerOptions,
  settledOutcome,
  summarizeSeason,
  type HistorySeason,
  type SeasonMatchRow,
} from '@/lib/season-history';
import { SeasonPick } from '@/components/my-stats/season-pick';
import { PastRatingCard } from '@/components/my-stats/past-rating-card';

// How many of a term's matches are pulled. A keen member plays four or five a
// session across a fifteen-week term, so 200 is well past a full season and this
// cap should never bite; it is here so that a data-entry accident cannot make
// one page fetch a career.
const SEASON_MATCH_CAP = 200;

// A season id arriving from the URL is checked against this before it is used
// in a filter. Postgres rejects a malformed uuid with an error rather than an
// empty result, and there is no reason to send it one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `session_attendance.status` values that mean the member was there. */
const PRESENT_STATUSES = new Set(['checked_in', 'present']);

/**
 * A TIMESTAMPTZ as the club's own day, e.g. `18 APR 2027`.
 *
 * NOT `formatDate` from the shared helpers. That one is
 * `new Date(iso).toLocaleDateString('en-US', …)` with no time zone, which means
 * the RUNTIME's zone — UTC in the container this app is served from, and the
 * viewer's browser after hydration. A match played at 22:00 in Vancouver is
 * 05:00Z the next morning, so the server renders one date, the browser renders
 * another, and the one the member is shown first is a day late. Every date on
 * this screen is a claim about a term that is over and has to be the club's.
 */
function clubDate(iso: string): string {
  return formatDayKey(clubDayKey(iso, CLUB_TIMEZONE));
}

type MatchRow = {
  id: string;
  played_at: string | null;
  match_type: string | null;
  rated_flag: boolean | null;
  completed_flag: boolean | null;
  result_status: string | null;
  score_summary: string | null;
  participants: unknown;
};

type OwnParticipant = {
  player_id: string;
  win_flag: boolean | null;
  rating_delta: number | null;
  post_rating: number | null;
  team_side: string | null;
  points_scored: number | null;
  points_allowed: number | null;
};

type OtherPlayer = { id: string; full_name: string; avatar_url?: string | null; team_side: string | null };

/**
 * A member's own record of a term that is over.
 *
 * Reached at /my-stats?season=<id>. Everything on it comes from rows written at
 * the time — the season's own matches, and the ladder the club archived when it
 * moved on. Two things a screen like this is expected to carry are deliberately
 * absent because nothing recorded them:
 *
 *   - RANK. See season-history.ts: nothing writes season_snapshots, and the
 *     archived ladder cannot be re-ranked into the list the member actually saw.
 *   - AN ATTENDANCE RATE. The live screen can compute one because it knows which
 *     sessions a member was eligible for TODAY. Eligibility is a session's track
 *     against the member's CURRENT status, and status is a column rather than a
 *     history — so for a term two years ago the denominator is a guess. The
 *     count of sessions they turned up to is a fact and is all that is shown.
 */
export async function PastSeasonStats({ seasonId }: { seasonId: string }) {
  if (!UUID.test(seasonId)) redirect('/my-stats');

  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [seasonsRes, archivedRes, matchRowsRes, attendanceRes] = await Promise.all([
    supabase
      .from('seasons')
      .select('id, name, start_date, end_date, active_flag')
      .order('start_date', { ascending: false })
      .limit(40),
    // Every season this member has an archived closing ladder for. One row per
    // season at most, so it is both the picker's list of terms they were part of
    // and the source of the closing figure for the one being shown.
    supabase
      .from('season_final_ratings')
      .select('season_id, singles_elo, doubles_elo, archived_at')
      .eq('player_id', player.id),
    // Parent-first, exactly as the live screen's window is, and for the same
    // reason: PostgREST cannot order parent rows by a column of a to-one embed,
    // so a participant-first query takes an arbitrary N rows and calls them the
    // season. `!inner` plus the filter on the embed drops matches this member
    // was not in; `player_id` is selected anyway so nothing here depends on the
    // embed also being narrowed.
    supabase
      .from('matches')
      .select(
        'id, played_at, match_type, rated_flag, completed_flag, result_status, score_summary, participants:match_participants!inner(player_id, win_flag, rating_delta, post_rating, team_side, points_scored, points_allowed)'
      )
      .eq('season_id', seasonId)
      .eq('participants.player_id', player.id)
      .not('played_at', 'is', null)
      .order('played_at', { ascending: false })
      .limit(SEASON_MATCH_CAP),
    supabase
      .from('session_attendance')
      .select('status, session:sessions!inner(id)')
      .eq('player_id', player.id)
      .eq('session.season_id', seasonId),
  ]);

  const seasons = (seasonsRes.data ?? []) as HistorySeason[];
  const season = seasons.find((s) => s.id === seasonId) ?? null;

  // Not a season, or the one being played right now. The live screen is the
  // canonical address for "now" and there is no second version of it.
  if (!season || season.active_flag) redirect('/my-stats');

  const archivedRows = (archivedRes.data ?? []) as {
    season_id: string;
    singles_elo: number;
    doubles_elo: number;
    archived_at: string;
  }[];
  const archivedIds = new Set(archivedRows.map((r) => r.season_id));
  const archived = archivedRows.find((r) => r.season_id === seasonId) ?? null;

  const matchRows = (matchRowsRes.data ?? []) as MatchRow[];

  // Matched on player_id rather than taken as rows[0] — a doubles match whose
  // embed came back unfiltered would otherwise render an OPPONENT's win_flag and
  // rating swing as the member's own, plausibly and silently.
  const ownParticipant = (m: MatchRow): OwnParticipant | null => {
    const raw = m.participants;
    const rows = (Array.isArray(raw) ? raw : raw ? [raw] : []) as OwnParticipant[];
    return rows.find((p) => p.player_id === player.id) ?? null;
  };

  const seasonRows: SeasonMatchRow[] = matchRows.map((m) => {
    const p = ownParticipant(m);
    return {
      match_type: m.match_type,
      result_status: m.result_status,
      win_flag: p?.win_flag ?? null,
      points_scored: p?.points_scored ?? null,
      points_allowed: p?.points_allowed ?? null,
      played_at: m.played_at,
    };
  });
  const record = summarizeSeason(seasonRows);

  // The same reshape the live screen builds its chart from, so the line here and
  // the line there filter identically — a member comparing the two must not find
  // that one of them counted a match the other dropped.
  const ratingRows: RatingSourceRow[] = matchRows.map((m) => {
    const p = ownParticipant(m);
    return {
      post_rating: p?.post_rating ?? null,
      rating_delta: p?.rating_delta ?? null,
      match: {
        played_at: m.played_at,
        match_type: m.match_type,
        rated_flag: m.rated_flag,
        completed_flag: m.completed_flag,
        result_status: m.result_status,
      },
    };
  });

  // `?? []` on its own would turn a failed read into the number 0, and "you
  // turned up to 0 sessions" is a confident lie about somebody's term rather
  // than a gap. A read that did not happen has no answer, so the card is not
  // drawn at all.
  const attended = attendanceRes.error
    ? null
    : ((attendanceRes.data ?? []) as { status: string }[]).filter((a) =>
        PRESENT_STATUSES.has(a.status)
      ).length;

  // Who each match was against. Those ids go into the query string of a GET,
  // so the lookup is chunked against the measured request-line limit — the
  // shared helper, not this file's own constant, since the same defect was live
  // at a dozen other call sites.
  const matchIds = matchRows.map((m) => m.id);
  const { data: opponentRows } = await selectInChunks<{
    match_id: string;
    player_id: string;
    team_side: string | null;
    player: unknown;
  }>(matchIds, (ids) =>
    supabase
      .from('match_participants')
      .select('match_id, player_id, team_side, player:players(id, full_name, avatar_url)')
      .in('match_id', ids) as never
  );
  const othersByMatch = new Map<string, OtherPlayer[]>();
  for (const row of opponentRows ?? []) {
    if (row.player_id === player.id) continue;
    const raw = row.player;
    const p = (Array.isArray(raw) ? raw[0] : raw) as
      | { id: string; full_name: string; avatar_url?: string | null }
      | null;
    if (!p) continue;
    const list = othersByMatch.get(row.match_id);
    const entry: OtherPlayer = { ...p, team_side: row.team_side };
    if (list) list.push(entry);
    else othersByMatch.set(row.match_id, [entry]);
  }
  // Opponents are picked by TEAM SIDE and not by "everyone who is not me": in
  // doubles one of the other three rows is a PARTNER, and naming a partner as
  // the person who beat you is a wrong answer that looks entirely plausible.
  const opponentsOf = (matchId: string, myTeamSide: string | null): OtherPlayer[] => {
    const others = othersByMatch.get(matchId) ?? [];
    if (!myTeamSide) return others;
    const known = others.filter((o) => o.team_side !== null);
    if (known.length === 0) return others;
    return known.filter((o) => o.team_side !== myTeamSide);
  };

  // Club time, both sides. players.created_at is a TIMESTAMPTZ and the season
  // columns are DATEs; comparing them through a Date parses the DATE as UTC
  // midnight and lands on the previous evening in Vancouver, which is how a
  // member who joined on the last day of a term gets told they missed it.
  const joinedDayKey = player.created_at
    ? clubDayKey(player.created_at as string, CLUB_TIMEZONE)
    : null;
  const joinedAfter = joinedAfterSeason(
    joinedDayKey,
    season.end_date,
    nextSeasonAfter(seasons, season.id)?.start_date ?? null
  );
  const emptyReason = seasonEmptyReason({
    matchCount: matchRows.length,
    hasArchivedRating: archived !== null,
    joinedAfter,
  });

  const picker = (
    <SeasonPick options={seasonPickerOptions(seasons, archivedIds, seasonId)} selectedId={seasonId} />
  );

  return (
    <div data-screen-label="My Stats — past season" className="wide-page">
      <PageHeader
        title="My stats"
        sub={`${season.name} · ${formatSeasonRange(season)}`}
        actions={picker}
        className="wide-head"
      />

      <div className="wide-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {emptyReason === 'has-matches' ? (
            <>
              <PastRatingCard
                singles={{
                  points: buildRatingSeries(ratingRows, 'singles'),
                  closingElo: archived?.singles_elo ?? null,
                  wins: record.singles.wins,
                  losses: record.singles.losses,
                }}
                doubles={{
                  points: buildRatingSeries(ratingRows, 'doubles'),
                  closingElo: archived?.doubles_elo ?? null,
                  wins: record.doubles.wins,
                  losses: record.doubles.losses,
                }}
                seasonName={season.name}
              />

              <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
                <div
                  className="card-head"
                  style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0 }}
                >
                  <h3 className="card-title">Every match in {season.name}</h3>
                  <span className="tag">
                    {matchRows.length === SEASON_MATCH_CAP
                      ? `LAST ${SEASON_MATCH_CAP}`
                      : `${matchRows.length} played`}
                  </span>
                </div>
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
                      {matchRows.map((m) => {
                        const p = ownParticipant(m);
                        if (!p) return null;
                        // The SAME predicate the record is counted with, so the
                        // tally in the rail can never disagree with the rows
                        // under it. A voided match keeps its win_flag, so this
                        // is not `p.win_flag === true`.
                        const won = settledOutcome({
                          match_type: m.match_type,
                          result_status: m.result_status,
                          win_flag: p.win_flag,
                          points_scored: p.points_scored,
                          points_allowed: p.points_allowed,
                          played_at: m.played_at,
                        });
                        const delta = p.rating_delta;
                        const deltaStr = typeof delta === 'number' ? formatSigned(delta) : '—';
                        const opponents = opponentsOf(m.id, p.team_side);
                        const lead = opponents[0] ?? null;
                        return (
                          <tr key={m.id}>
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
                              <span className="tag">{m.match_type?.toUpperCase()}</span>
                            </td>
                            <td className="num" style={{ textAlign: 'right' }}>
                              {m.score_summary ? <Atomic separator=",">{m.score_summary}</Atomic> : '—'}
                            </td>
                            <td>
                              {won === true ? (
                                <span className="mono" style={{ color: 'var(--win)', fontWeight: 600 }}>WIN</span>
                              ) : won === false ? (
                                <span className="mono" style={{ color: 'var(--loss)', fontWeight: 600 }}>LOSS</span>
                              ) : (
                                // Named rather than dashed. An old row with no
                                // result is nearly always a match somebody
                                // disputed or an exec struck off, and "VOIDED"
                                // explains why it is not in the record while an
                                // em dash just looks like missing data.
                                <span className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em' }}>
                                  {(m.result_status ?? 'unrecorded').replace(/_/g, ' ').toUpperCase()}
                                </span>
                              )}
                            </td>
                            <td
                              className="num"
                              style={{
                                fontWeight: 600,
                                textAlign: 'right',
                                color:
                                  typeof delta !== 'number'
                                    ? 'var(--mute)'
                                    : delta >= 0
                                      ? 'var(--win)'
                                      : 'var(--loss)',
                              }}
                            >
                              {deltaStr}
                            </td>
                            {/* An absolute date, not "3 months ago". The whole
                                screen is about a term that is over; a relative
                                time on it measures from now, which is exactly
                                the frame the member has stepped out of. */}
                            <td className="num mono muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {m.played_at ? clubDate(m.played_at) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <EmptySeason reason={emptyReason} season={season} joinedDayKey={joinedDayKey} />
          )}
        </div>

        <div className="wide-rail">
          {record.played > 0 && (
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Your record</h3>
                <span className="tag">{season.name}</span>
              </div>
              <div className="row" style={{ gap: 10, alignItems: 'baseline', marginBottom: 16 }}>
                <span
                  className="mono"
                  style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, letterSpacing: '-.02em' }}
                >
                  <span style={{ color: 'var(--win)' }}>{record.wins}</span>
                  <span className="muted" style={{ margin: '0 4px' }}>–</span>
                  <span style={{ color: 'var(--loss)' }}>{record.losses}</span>
                </span>
                <span className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em' }}>
                  {record.played} {record.played === 1 ? 'MATCH' : 'MATCHES'}
                </span>
              </div>
              <div className="season-figures">
                <SeasonFigure label="SINGLES" value={`${record.singles.wins}–${record.singles.losses}`} />
                <SeasonFigure label="DOUBLES" value={`${record.doubles.wins}–${record.doubles.losses}`} />
                <SeasonFigure label="BEST RUN" value={record.bestWinStreak > 0 ? `W${record.bestWinStreak}` : '—'} />
                <SeasonFigure
                  label="POINT DIFF"
                  value={formatSigned(record.pointDiff)}
                  tone={
                    record.pointDiff > 0 ? 'var(--win)' : record.pointDiff < 0 ? 'var(--loss)' : undefined
                  }
                />
              </div>
            </div>
          )}

          {archived ? (
            <div className="card-base">
              <h3 className="card-title" style={{ marginBottom: 4 }}>Where you finished</h3>
              <div className="card-sub" style={{ marginBottom: 18 }}>
                The ladder the club archived when it moved on from {season.name}
              </div>
              <div className="season-figures">
                <SeasonFigure label="SINGLES ELO" value={String(archived.singles_elo)} />
                <SeasonFigure label="DOUBLES ELO" value={String(archived.doubles_elo)} />
              </div>
              <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.1em', marginTop: 14 }}>
                {/* archived_at is a TIMESTAMPTZ, unlike the season's own DATE
                    columns — a rollover run at 5pm in Vancouver is already
                    tomorrow in UTC, so it goes through the club's clock before
                    it is formatted. */}
                ARCHIVED {clubDate(archived.archived_at)}
              </div>
            </div>
          ) : (
            <div className="card-base">
              <h3 className="card-title" style={{ marginBottom: 4 }}>Where you finished</h3>
              <div className="card-sub">
                The club never closed off a ladder for {season.name} while you were on it, so there
                is no archived rating to show. The chart still ends where your last match of the term
                left you.
              </div>
            </div>
          )}

          {attended !== null && (
          <div className="card-base">
            <h3 className="card-title" style={{ marginBottom: 4 }}>Sessions</h3>
            <div className="card-sub" style={{ marginBottom: 18 }}>
              How many times you turned up in {season.name}
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span
                className="mono"
                style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, letterSpacing: '-.02em' }}
              >
                {attended}
              </span>
              <span className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em' }}>
                {attended === 1 ? 'SESSION' : 'SESSIONS'}
              </span>
            </div>
            {/* No percentage. A rate needs to know which sessions this member was
                allowed at, which is their track against their status — and status
                is a column, not a history, so for a finished term the denominator
                would be today's answer to a question about back then. */}
            <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.1em', marginTop: 14 }}>
              ATTENDANCE RATES ARE ONLY KEPT FOR THE CURRENT TERM
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SeasonFigure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="stat-label" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: tone ?? 'var(--ink)' }}>
        {value}
      </div>
    </div>
  );
}

/**
 * A term with nothing in it, said three different ways.
 *
 * "No matches" is not one situation. A member who was on the ladder and did not
 * play, one who had not joined yet, and one the club simply has no record for
 * are three different sentences, and printing the same empty box for all three
 * reads as a screen that is broken rather than a term that was quiet.
 */
function EmptySeason({
  reason,
  season,
  joinedDayKey,
}: {
  reason: 'joined-later' | 'no-matches-but-on-ladder' | 'nothing-on-record';
  season: HistorySeason;
  joinedDayKey: string | null;
}) {
  const copy =
    reason === 'joined-later'
      ? {
          title: `You joined after ${season.name}`,
          hint: joinedDayKey
            ? `Your membership starts ${formatDayKey(joinedDayKey)}, and ${season.name} had already finished. There is nothing of yours in it.`
            : `${season.name} had already finished by the time you joined the club.`,
        }
      : reason === 'no-matches-but-on-ladder'
        ? {
            title: `A quiet ${season.name}`,
            hint: `You were on the ladder when the club closed the term off, but no match of yours was recorded in it. Your rating for it is in the rail.`,
          }
        : {
            title: `Nothing on record for ${season.name}`,
            hint: `The club has no matches and no closing rating for you in this term.`,
          };

  return (
    <div className="card-base">
      <div className="empty" style={{ padding: '40px 20px' }}>
        <div className="empty-title">{copy.title}</div>
        <div className="empty-hint">{copy.hint}</div>
      </div>
    </div>
  );
}
