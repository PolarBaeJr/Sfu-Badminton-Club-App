import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { getWinRate, getOverallRecord, getStreakDisplay, getPointDifferential, formatDate } from '@badminton/shared';
import { redirect } from 'next/navigation';
import { AvatarChip, PageHeader } from '@badminton/ui';

export default async function MyStatsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;

  const [reliabilityRes, recentMatchesRes, h2hRes, partnersRes] = await Promise.all([
    supabase
      .from('reliability_metrics')
      .select('no_shows, late_withdrawals, challenges_issued, matches_completed')
      .eq('player_id', player.id)
      .maybeSingle(),
    supabase
      .from('match_participants')
      .select('id, win_flag, rating_delta, team_side, match:matches(score_summary, played_at, match_type, format)')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(20),
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
  ]);

  const reliability = reliabilityRes.data;
  const recentMatches = recentMatchesRes.data ?? [];
  const h2h = h2hRes.data ?? [];
  const partners = partnersRes.data ?? [];

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
        eyebrow="PLAYER PROFILE · SEASON 26"
        title="My stats"
        sub="Your complete ledger across singles and doubles. Match history, head-to-head records, partnerships, and reliability."
      />

      <div className="card-base" style={{ padding: 28, marginBottom: 24 }}>
        <div
          className="grid"
          style={{ gridTemplateColumns: 'auto 1fr', gap: 32, alignItems: 'center' }}
        >
          <div className="row" style={{ gap: 20 }}>
            <AvatarChip name={player.full_name} id={player.id} size="xl" ring />
            <div>
              <div
                style={{
                  fontFamily: 'var(--display)',
                  fontSize: 32,
                  fontWeight: 700,
                  letterSpacing: '-.02em',
                  lineHeight: 1,
                }}
              >
                {player.full_name}
              </div>
              <div className="mono muted" style={{ fontSize: 12, marginTop: 6 }}>
                {player.email}
              </div>
              {joined && (
                <div className="mono muted" style={{ fontSize: 12 }}>
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
        <div className="grid grid-3" style={{ marginBottom: 24 }}>
          <div className="card-base">
            <div className="stat-label">SINGLES STREAK</div>
            <div className="stat-value">{getStreakDisplay(r.current_singles_streak)}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Best W{r.best_singles_streak ?? 0}
            </div>
          </div>
          <div className="card-base">
            <div className="stat-label">DOUBLES STREAK</div>
            <div className="stat-value">{getStreakDisplay(r.current_doubles_streak)}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Best W{r.best_doubles_streak ?? 0}
            </div>
          </div>
          <div className="card-base">
            <div className="stat-label">RELIABILITY</div>
            <div className="stat-value">{reliability?.no_shows ?? 0}</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              No-shows · {reliability?.late_withdrawals ?? 0} late w/d
            </div>
          </div>
          <div className="card-base">
            <div className="stat-label">SINGLES POINT DIFF</div>
            <div className="stat-value">
              {getPointDifferential(r.singles_points_scored, r.singles_points_allowed)}
            </div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Games {r.singles_games_won}–{r.singles_games_lost}
            </div>
          </div>
          <div className="card-base">
            <div className="stat-label">DOUBLES POINT DIFF</div>
            <div className="stat-value">
              {getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed)}
            </div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
              Games {r.doubles_games_won}–{r.doubles_games_lost}
            </div>
          </div>
          <div className="card-base">
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
                    <div
                      key={h.id}
                      className="row"
                      style={{
                        padding: '10px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        gap: 12,
                      }}
                    >
                      <AvatarChip name={opponent.full_name} id={opponent.id} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{opponent.full_name}</div>
                        <div className="mono muted" style={{ fontSize: 11 }}>{(h.match_type as string)?.toUpperCase()}</div>
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
                    <div
                      key={p.id}
                      className="row"
                      style={{
                        padding: '10px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        gap: 12,
                      }}
                    >
                      <AvatarChip name={partner.full_name} id={partner.id} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{partner.full_name}</div>
                        <div className="mono muted" style={{ fontSize: 11 }}>
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
        </div>
      </div>
    </div>
  );
}
