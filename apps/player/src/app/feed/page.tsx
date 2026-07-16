import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { MATCH_FORMAT_LABELS, formatRelativeTime, getWinRate, pickOne, unwrap } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, ChevronRight, Crosshair, Filter } from 'lucide-react';
import { PageHeader, Section, AvatarChip, StatBlock } from '@badminton/ui';

type Person = { id: string; full_name: string | null };
type ParticipantRow = {
  team_side: 'a' | 'b';
  win_flag: boolean | null;
  player: Person | Person[] | null;
};
type MatchRow = {
  id: string;
  played_at: string | null;
  match_type: string;
  format: string;
  score_summary: string | null;
  result_status: string;
  match_participants: ParticipantRow[] | null;
};

function weekNumber(d: Date) {
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = (d.getTime() - start.getTime()) / 86_400_000;
  return Math.ceil((diff + start.getDay() + 1) / 7);
}

export default async function FeedPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const r = pickOne(player.ratings);

  const [
    pendingChallengesRes,
    matchParticipationsRes,
    topRatingsRes,
  ] = await Promise.all([
    supabase
      .from('challenge_participants')
      .select('*, challenge:challenges(*, creator:players!challenges_created_by_fkey(full_name))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
    supabase
      .from('match_participants')
      .select(`
        match:matches(
          id, score_summary, played_at, match_type, format, result_status,
          participants:match_participants(team_side, win_flag, player:players(id, full_name))
        )
      `)
      .eq('player_id', player.id)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(5),
    supabase
      .from('ratings')
      .select('singles_elo, player:players(id, full_name, hide_from_leaderboard)')
      .order('singles_elo', { ascending: false })
      .limit(20),
  ]);

  const pendingChallenges = unwrap(pendingChallengesRes);
  const matchParticipations = unwrap(matchParticipationsRes);
  const topRatings = unwrap(topRatingsRes);

  const singlesWinRate = r ? getWinRate(r.singles_wins, r.singles_losses) : '—';
  const singlesStreak = (r as Record<string, unknown> | null | undefined)?.current_singles_streak as number | undefined;
  const streakLabel =
    typeof singlesStreak === 'number' && singlesStreak !== 0
      ? `${singlesStreak > 0 ? 'W' : 'L'}${Math.abs(singlesStreak)}`
      : '—';

  const recentMatches: MatchRow[] = (matchParticipations || [])
    .map((mp) => {
      const m = mp.match as unknown as MatchRow | null;
      return m;
    })
    .filter((m): m is MatchRow => Boolean(m));

  const top = (topRatings || [])
    .map((row) => {
      const raw = row.player as unknown as (Person & { hide_from_leaderboard?: boolean }) | (Person & { hide_from_leaderboard?: boolean })[] | null;
      const person = pickOne(raw);
      if (!person || person.hide_from_leaderboard) return null;
      return { person, elo: row.singles_elo as number };
    })
    .filter((row): row is { person: Person; elo: number } => Boolean(row))
    .slice(0, 5);

  const now = new Date();
  const wk = weekNumber(now);
  const dateStr = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  const greeting = (() => {
    const h = now.getHours();
    if (h < 5) return 'Up late';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Up late';
  })();
  const firstName = player.full_name.split(' ')[0];

  const subBits: string[] = [];
  if (pendingChallenges && pendingChallenges.length > 0) {
    subBits.push(`${pendingChallenges.length} ${pendingChallenges.length === 1 ? 'challenge needs' : 'challenges need'} your response`);
  }
  if (recentMatches.length > 0 && r) {
    subBits.push(`Singles ELO ${r.singles_elo} · ${singlesWinRate} win rate`);
  } else {
    subBits.push('Issue your first challenge to start climbing.');
  }
  const subLine = subBits.join(' · ');

  return (
    <div data-screen-label="Feed">
      <PageHeader
        eyebrow={`WEEK ${wk} · ${dateStr}`}
        title={`${greeting}, ${firstName}.`}
        sub={subLine}
        actions={
          <>
            <Link href="/leaderboard" className="btn btn-ghost">
              <Filter size={14} /> Browse
            </Link>
            <Link href="/challenges/new" className="btn btn-primary">
              <Plus size={14} /> Issue Challenge
            </Link>
          </>
        }
      />


      {r && (
        <div className="hero-banner" style={{ marginBottom: 24 }}>
          <div style={{ position: 'relative', zIndex: 2 }}>
            <div className="eyebrow">Ladder · Your Standing</div>
            <h2>
              {r.singles_provisional
                ? `Play ${Math.max(0, 8 - (r.singles_matches_played ?? 0))} more singles to lock in your rank.`
                : `Singles ELO ${r.singles_elo}. ${singlesWinRate} win rate over ${(r.singles_wins ?? 0) + (r.singles_losses ?? 0)} matches.`}
            </h2>

            {(() => {
              const singlesPlayed = (r.singles_wins ?? 0) + (r.singles_losses ?? 0);
              const doublesPlayed = (r.doubles_wins ?? 0) + (r.doubles_losses ?? 0);
              const singlesLeft = Math.max(0, 8 - singlesPlayed);
              const doublesLeft = Math.max(0, 8 - doublesPlayed);

              const StatusRow = ({
                label,
                provisional,
                left,
              }: { label: string; provisional: boolean; left: number }) => (
                <div
                  className="row"
                  style={{
                    gap: 12,
                    fontSize: 13,
                    fontFamily: 'var(--mono)',
                    color: 'color-mix(in oklab, var(--bg) 78%, transparent)',
                    letterSpacing: '.02em',
                  }}
                >
                  <span
                    style={{
                      width: 64,
                      fontSize: 11,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      color: 'color-mix(in oklab, var(--bg) 55%, transparent)',
                    }}
                  >
                    {label}
                  </span>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: provisional
                        ? 'color-mix(in oklab, var(--gold) 25%, transparent)'
                        : 'color-mix(in oklab, var(--win) 22%, transparent)',
                      color: provisional ? 'var(--gold)' : 'var(--win)',
                      fontSize: 11,
                      fontWeight: 500,
                    }}
                  >
                    {provisional ? 'PROVISIONAL' : 'ESTABLISHED'}
                  </span>
                  {provisional && (
                    <span style={{ color: 'color-mix(in oklab, var(--bg) 65%, transparent)' }}>
                      {left} match{left === 1 ? '' : 'es'} to lock in
                    </span>
                  )}
                </div>
              );

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20, maxWidth: '46ch' }}>
                  <StatusRow label="Singles" provisional={!!r.singles_provisional} left={singlesLeft} />
                  <StatusRow label="Doubles" provisional={!!r.doubles_provisional} left={doublesLeft} />
                </div>
              );
            })()}

            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Link href="/challenges/new" className="btn btn-primary">
                <Crosshair size={14} /> Find an opponent
              </Link>
              <Link
                href="/leaderboard"
                className="btn btn-ghost"
                style={{ borderColor: 'rgba(255,255,255,.25)', color: '#fff' }}
              >
                See leaderboard
              </Link>
            </div>
          </div>
          <div className="hero-stats">
            <div className="stat">
              <div className="stat-label">Singles ELO</div>
              <div className="stat-value">{r.singles_elo}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Doubles ELO</div>
              <div className="stat-value">{r.doubles_elo}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Win Rate</div>
              <div className="stat-value">{singlesWinRate}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Streak</div>
              <div className="stat-value">{streakLabel}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-12">
        <div style={{ gridColumn: 'span 8' }} className="feed-col">
          {pendingChallenges && pendingChallenges.length > 0 && (
            <div className="card-base">
              <div className="card-head">
                <div>
                  <h3 className="card-title">Pending challenges</h3>
                  <div className="card-sub">Respond to keep your reliability up.</div>
                </div>
                <span className="tag tag-red">{pendingChallenges.length} waiting</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pendingChallenges.map((pc) => {
                  const c = pc.challenge as Record<string, unknown> | null;
                  if (!c) return null;
                  const creator = c.creator as Record<string, unknown> | null;
                  const creatorName = (creator?.full_name as string) || 'Someone';
                  return (
                    <Link
                      key={pc.id}
                      href={`/challenges/${c.id}`}
                      className="row press"
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid var(--line)',
                        background: 'var(--surface)',
                      }}
                    >
                      <AvatarChip name={creatorName} id={(creator?.id as string) ?? creatorName} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{creatorName} challenged you</div>
                        <div className="mono muted" style={{ fontSize: 11 }}>
                          {(c.type as string) || ''} · {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS] || (c.format as string)}
                        </div>
                      </div>
                      <span className="tag">Respond</span>
                      <ChevronRight size={16} className="text-[var(--mute)]" />
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          <div className="card-head" style={{ marginBottom: 0 }}>
            <div>
              <h3 className="card-title" style={{ fontSize: 22 }}>Recent matches</h3>
              <div className="card-sub">Your latest results.</div>
            </div>
            <Link href="/my-stats" className="btn btn-ghost btn-sm">
              All stats <ChevronRight size={12} />
            </Link>
          </div>

          {recentMatches.length === 0 ? (
            <div className="card-base">
              <div className="empty">No matches yet. Issue a challenge to get rolling.</div>
            </div>
          ) : (
            recentMatches.map((m) => {
              const participants = m.match_participants ?? [];
              const me = participants.find((p) => {
                const person = pickOne(p.player);
                return person?.id === player.id;
              });
              const opponents = participants.filter((p) => {
                const person = pickOne(p.player);
                return person?.id !== player.id && p.team_side !== me?.team_side;
              });
              const partner = participants.find((p) => {
                const person = pickOne(p.player);
                return person?.id !== player.id && p.team_side === me?.team_side;
              });
              const opponent = pickOne(opponents[0]?.player ?? null);
              const opponentPartner = pickOne(opponents[1]?.player ?? null);
              const partnerPerson = pickOne(partner?.player ?? null);

              const formatLabel = MATCH_FORMAT_LABELS[m.format as keyof typeof MATCH_FORMAT_LABELS] || m.format;
              const isWin = me?.win_flag === true;
              const isLoss = me?.win_flag === false;

              const games = (m.score_summary || '')
                .split(',')
                .map((g) => g.trim())
                .filter(Boolean)
                .map((g) => g.split('-').map((s) => Number(s)));
              const myTotal = games.reduce((s, g) => s + ((me?.team_side === 'a' ? g[0] : g[1]) || 0), 0);
              const oppTotal = games.reduce((s, g) => s + ((me?.team_side === 'a' ? g[1] : g[0]) || 0), 0);

              return (
                <div key={m.id} className="card-base">
                  <div className="row" style={{ marginBottom: 14, fontSize: 12 }}>
                    <span className="tag tag-red">{formatLabel}</span>
                    <span className="mono muted">
                      {m.played_at ? formatRelativeTime(m.played_at) : ''}
                    </span>
                    <div className="right mono" style={{ color: isWin ? 'var(--win)' : isLoss ? 'var(--loss)' : 'var(--mute)' }}>
                      {isWin ? 'WIN' : isLoss ? 'LOSS' : 'PENDING'}
                    </div>
                  </div>
                  <div className="feed-match">
                    <div className="side">
                      <AvatarChip name={player.full_name} id={player.id} size="md" />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>You</div>
                        {partnerPerson && (
                          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                            + {partnerPerson.full_name}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div className="score">
                        <span style={{ opacity: isWin ? 1 : 0.4 }}>{myTotal}</span>
                        <span className="muted" style={{ margin: '0 8px', fontWeight: 400 }}>:</span>
                        <span style={{ opacity: !isWin ? 1 : 0.4 }}>{oppTotal}</span>
                      </div>
                      {games.length > 0 && (
                        <div className="score-mini">
                          {games.map(([a, b], i) => {
                            const mine = me?.team_side === 'a' ? a : b;
                            const theirs = me?.team_side === 'a' ? b : a;
                            return <span key={i}>{mine}–{theirs}</span>;
                          })}
                        </div>
                      )}
                    </div>
                    <div className="side right">
                      <AvatarChip name={opponent?.full_name ?? '?'} id={opponent?.id ?? ''} size="md" />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>
                          {opponent?.full_name ?? 'Opponent'}
                        </div>
                        {opponentPartner && (
                          <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                            + {opponentPartner.full_name}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div style={{ gridColumn: 'span 4' }} className="feed-col">
          <div className="card-base">
            <div className="card-head">
              <h3 className="card-title">Top of the ladder</h3>
              <span className="tag">Open S.</span>
            </div>
            {top.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}>No leaderboard data yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {top.map((row, i) => (
                  <Link
                    key={row.person.id}
                    href={`/leaderboard`}
                    className="row press"
                    style={{ padding: '10px 8px', borderRadius: 8, width: '100%', textAlign: 'left' }}
                  >
                    <div
                      className="mono"
                      style={{ width: 26, color: i < 3 ? 'var(--red)' : 'var(--mute)', fontSize: 13, fontWeight: 600 }}
                    >
                      #{i + 1}
                    </div>
                    <AvatarChip name={row.person.full_name ?? '?'} id={row.person.id} size="sm" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{row.person.full_name}</div>
                    </div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{row.elo}</div>
                  </Link>
                ))}
              </div>
            )}
            <div className="sep" />
            <Link href="/leaderboard" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
              View full leaderboard <ChevronRight size={12} />
            </Link>
          </div>

          <div className="card-base">
            <div className="card-head">
              <h3 className="card-title">Quick actions</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Link href="/challenges/new" className="btn btn-dark" style={{ width: '100%', justifyContent: 'center' }}>
                <Crosshair size={14} /> Issue a challenge
              </Link>
              <Link href="/sessions" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
                Browse sessions
              </Link>
              <Link href="/tournaments" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
                Tournament bracket
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
