import { createServerSupabaseClient, getCurrentPlayer, getActiveSeason } from '@/lib/supabase-server';
import { getWinRate, getOverallRecord, getStreakDisplay, getPointDifferential, formatDate, TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { AvatarChip, PageHeader } from '@badminton/ui';

export default async function MyStatsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const activeSeason = await getActiveSeason();
  const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;

  const [reliabilityRes, recentMatchesRes, h2hRes, partnersRes, walkoverEventsRes, tournamentNoShowsRes] = await Promise.all([
    supabase
      .from('reliability_metrics')
      .select('no_shows, late_cancellations, early_withdrawals, walkovers_received, matches_completed, walkover_flag')
      .eq('player_id', player.id)
      .maybeSingle(),
    supabase
      .from('match_participants')
      .select('id, win_flag, rating_delta, team_side, match:matches(score_summary, played_at, match_type, format)')
      .eq('player_id', player.id)
      .limit(60),
    supabase
      .from('head_to_head_stats')
      .select('id, player_a_id, player_b_id, player_a_wins, player_b_wins, total_matches, match_type, a:players!head_to_head_stats_player_a_id_fkey(id, full_name), b:players!head_to_head_stats_player_b_id_fkey(id, full_name)')
      .or(`player_a_id.eq.${player.id},player_b_id.eq.${player.id}`)
      .order('total_matches', { ascending: false })
      .limit(10),
    supabase
      .from('partnership_stats')
      .select('id, wins, losses, win_rate, total_matches, partner:players!partnership_stats_partner_id_fkey(id, full_name)')
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
  ]);

  const reliability = reliabilityRes.data;
  // match_participants has no timestamp, so recency is derived from the embedded
  // match (ISO played_at sorts chronologically) and capped to the display count.
  const playedAtOf = (mp: { match: unknown }): string => {
    const raw = mp.match;
    const m = (Array.isArray(raw) ? raw[0] : raw) as { played_at?: string } | null;
    return m?.played_at ?? '';
  };
  const recentMatches = [...(recentMatchesRes.data ?? [])]
    .sort((a, b) => playedAtOf(b).localeCompare(playedAtOf(a)))
    .slice(0, 20);
  const h2h = h2hRes.data ?? [];
  const partners = partnersRes.data ?? [];
  const walkoverEvents = walkoverEventsRes.data ?? [];
  const tournamentNoShows = tournamentNoShowsRes.data ?? [];

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
            <AvatarChip name={player.full_name} id={player.id} size="xl" ring />
            <div>
              <div
                style={{
                  fontFamily: 'var(--display)',
                  fontSize: 'clamp(24px, 4vw, 32px)',
                  fontWeight: 700,
                  letterSpacing: '-.02em',
                  lineHeight: 1,
                  overflowWrap: 'anywhere',
                }}
              >
                {player.full_name}
              </div>
              {joined && (
                <div className="mono muted" style={{ fontSize: 12, marginTop: 6 }}>
                  JOINED {joined}
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

          {r && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 20,
                borderLeft: '1px solid var(--line)',
                paddingLeft: 32,
              }}
            >
              <div className="stat">
                <div className="stat-label">SINGLES ELO</div>
                <div className="stat-value">{r.singles_elo}</div>
                <div className="mono muted" style={{ fontSize: 11 }}>
                  {r.singles_provisional ? 'Provisional' : `K=${r.singles_k_factor}`} · {getWinRate(r.singles_wins, r.singles_losses)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">DOUBLES ELO</div>
                <div className="stat-value">{r.doubles_elo}</div>
                <div className="mono muted" style={{ fontSize: 11 }}>
                  {r.doubles_provisional ? 'Provisional' : `K=${r.doubles_k_factor}`} · {getWinRate(r.doubles_wins, r.doubles_losses)}
                </div>
              </div>
            </div>
          )}
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

      <div className="grid grid-12">
        <div style={{ gridColumn: 'span 8' }} className="feed-col">
          <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="card-head"
              style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0 }}
            >
              <h3 className="card-title">Match history</h3>
            </div>
            {recentMatches.length === 0 ? (
              <div className="empty">No matches yet. Issue a challenge to get started.</div>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table className="data-table" style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Format</th>
                      <th className="num" style={{ textAlign: 'right' }}>Score</th>
                      <th>Result</th>
                      <th className="num" style={{ textAlign: 'right' }}>ELO Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentMatches.map((mp) => {
                      const matchRaw = mp.match as unknown;
                      const m = (Array.isArray(matchRaw) ? matchRaw[0] : matchRaw) as Record<string, unknown> | null;
                      if (!m) return null;
                      const isWin = mp.win_flag === true;
                      const isLoss = mp.win_flag === false;
                      const delta = mp.rating_delta as number | null | undefined;
                      const deltaStr = typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${delta}` : '—';
                      return (
                        <tr key={mp.id}>
                          <td className="mono muted">
                            {m.played_at ? formatDate(m.played_at as string) : '—'}
                          </td>
                          <td>
                            <span className="tag">{(m.match_type as string)?.toUpperCase()}</span>
                          </td>
                          <td className="num" style={{ textAlign: 'right' }}>
                            {(m.score_summary as string) || '—'}
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {h2h.length > 0 && (
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Head-to-head</h3>
                <span className="tag">{h2h.length} opponents</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {h2h.map((h) => {
                  const isA = h.player_a_id === player.id;
                  const opponentRaw = isA ? h.b : h.a;
                  const opponent = (Array.isArray(opponentRaw) ? opponentRaw[0] : opponentRaw) as { id: string; full_name: string } | null;
                  if (!opponent) return null;
                  const wins = isA ? h.player_a_wins : h.player_b_wins;
                  const losses = isA ? h.player_b_wins : h.player_a_wins;
                  return (
                    <div key={h.id} className="list-row">
                      <AvatarChip name={opponent.full_name} id={opponent.id} size="sm" />
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

        <div style={{ gridColumn: 'span 4' }} className="feed-col">
          {totalPlayed > 0 && (
            <div className="card-base">
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
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Best partners</h3>
                <span className="tag tag-gold">DOUBLES</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {partners.map((p) => {
                  const partnerRaw = p.partner as unknown;
                  const partner = (Array.isArray(partnerRaw) ? partnerRaw[0] : partnerRaw) as { id: string; full_name: string } | null;
                  if (!partner) return null;
                  return (
                    <div key={p.id} className="list-row">
                      <AvatarChip name={partner.full_name} id={partner.id} size="sm" />
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
            <div className="card-base">
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
