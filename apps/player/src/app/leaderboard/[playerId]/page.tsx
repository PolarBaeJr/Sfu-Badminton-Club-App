import { createServerSupabaseClient } from '@/lib/supabase-server';
import { PLAYER_STATUS_LABELS, getWinRate, getStreakDisplay, getPointDifferential, formatDate } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft, Crosshair, Trophy } from 'lucide-react';
import Link from 'next/link';
import { AvatarChip } from '@badminton/ui';

export default async function PlayerProfilePage({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  const supabase = await createServerSupabaseClient();

  const [
    { data: player },
    { data: rating },
    { data: recentMatchesRaw },
    { data: h2hStats },
  ] = await Promise.all([
    supabase.from('players').select('*').eq('id', playerId).single(),
    supabase.from('ratings').select('*').eq('player_id', playerId).single(),
    supabase
      .from('match_participants')
      .select('*, match:matches(score_summary, played_at, match_type, format, result_status, winner_side)')
      .eq('player_id', playerId)
      .limit(60),
    supabase
      .from('head_to_head_stats')
      .select('*')
      .or(`player_a_id.eq.${playerId},player_b_id.eq.${playerId}`)
      .order('total_matches', { ascending: false })
      .limit(5),
  ]);

  if (!player) notFound();
  const r = rating;

  // match_participants has no timestamp; ordering by the embedded to-one match
  // is a PostgREST no-op. Sort by the match's played_at (ISO sorts chrono) here.
  const recentMatches = [...(recentMatchesRaw ?? [])]
    .sort((a, b) => {
      const pa = (a.match as { played_at?: string } | null)?.played_at ?? '';
      const pb = (b.match as { played_at?: string } | null)?.played_at ?? '';
      return pb.localeCompare(pa);
    })
    .slice(0, 10);

  return (
    <div data-screen-label="Player Profile" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header" style={{ marginBottom: 18 }}>
        <Link href="/leaderboard" className="row press" style={{ gap: 8, fontSize: 13, color: 'var(--mute)' }}>
          <ArrowLeft size={16} />
          Back to leaderboard
        </Link>
      </div>

      <div className="card-base" style={{ padding: 24, marginBottom: 16 }}>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="xl" ring />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontFamily: 'var(--display)',
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: '-.02em',
                margin: 0,
              }}
            >
              {player.full_name}
            </h1>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <span className={'pill ' + (player.status === 'competitive' ? 'pill-red' : 'pill-out')}>
                {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]?.toUpperCase()}
              </span>
              {r?.singles_provisional && <span className="pill pill-out">PROVISIONAL</span>}
            </div>
            {player.bio && (
              <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.55, color: 'var(--ink-2)', maxWidth: '56ch' }}>
                {player.bio}
              </p>
            )}
          </div>
          <Link href={`/challenges/new?opponent=${playerId}`} className="btn btn-primary">
            <Crosshair size={14} /> Challenge
          </Link>
        </div>
      </div>

      {r && (
        <>
          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div className="card-base">
              <div className="stat-label">SINGLES ELO</div>
              <div className="stat-value">{r.singles_elo}</div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
                {r.singles_provisional ? 'Provisional' : `K=${r.singles_k_factor}`} · {r.singles_wins}W–{r.singles_losses}L · {getWinRate(r.singles_wins, r.singles_losses)}
              </div>
            </div>
            <div className="card-base">
              <div className="stat-label">DOUBLES ELO</div>
              <div className="stat-value">{r.doubles_elo}</div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
                {r.doubles_provisional ? 'Provisional' : `K=${r.doubles_k_factor}`} · {r.doubles_wins}W–{r.doubles_losses}L · {getWinRate(r.doubles_wins, r.doubles_losses)}
              </div>
            </div>
          </div>

          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div className="card-base">
              <div className="stat-label">SINGLES STREAK</div>
              <div className="stat-value">{getStreakDisplay(r.current_singles_streak)}</div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
                Pt diff {getPointDifferential(r.singles_points_scored, r.singles_points_allowed)}
              </div>
            </div>
            <div className="card-base">
              <div className="stat-label">DOUBLES STREAK</div>
              <div className="stat-value">{getStreakDisplay(r.current_doubles_streak)}</div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
                Pt diff {getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed)}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="card-base" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div className="row" style={{ gap: 8 }}>
            <Trophy size={14} className="text-[var(--gold)]" />
            <h3 className="card-title">Recent matches</h3>
          </div>
        </div>
        {(!recentMatches || recentMatches.length === 0) ? (
          <div className="empty">No matches yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentMatches.map((mp) => {
              const m = mp.match as Record<string, unknown> | null;
              if (!m) return null;
              const isWin = mp.win_flag === true;
              const isLoss = mp.win_flag === false;
              const delta = mp.rating_delta as number | null;
              return (
                <div
                  key={mp.id}
                  className="row"
                  style={{
                    padding: '12px 14px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    background: 'var(--surface)',
                    gap: 12,
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 700,
                      fontSize: 12,
                      background: isWin ? 'var(--win-wash)' : isLoss ? 'var(--red-wash)' : 'var(--surface-2)',
                      color: isWin ? 'var(--win)' : isLoss ? 'var(--red)' : 'var(--mute)',
                    }}
                  >
                    {isWin ? 'W' : isLoss ? 'L' : '·'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                      {(m.score_summary as string) || '—'}
                    </div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      <span className="tag" style={{ fontSize: 10 }}>{(m.match_type as string)?.toUpperCase()}</span>{' '}
                      {m.played_at ? formatDate(m.played_at as string).toUpperCase() : ''}
                    </div>
                  </div>
                  {typeof delta === 'number' && (
                    <span
                      className="mono"
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        color: delta >= 0 ? 'var(--win)' : 'var(--loss)',
                      }}
                    >
                      {delta >= 0 ? '+' : ''}{delta}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {h2hStats && h2hStats.length > 0 && (
        <div className="card-base">
          <div className="card-head">
            <h3 className="card-title">Head-to-head</h3>
            <span className="tag">{h2hStats.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {h2hStats.map((h) => {
              const isA = h.player_a_id === playerId;
              const wins = isA ? h.player_a_wins : h.player_b_wins;
              const losses = isA ? h.player_b_wins : h.player_a_wins;
              return (
                <div
                  key={h.id}
                  className="row"
                  style={{
                    padding: '10px 14px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    background: 'var(--surface)',
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500, textTransform: 'capitalize' }}>{h.match_type}</span>
                  <span className="mono muted" style={{ fontSize: 11, marginLeft: 8 }}>{h.total_matches} matches</span>
                  <span className="mono" style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 13 }}>
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
  );
}
