import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { MATCH_FORMAT_LABELS, formatRelativeTime, getWinRate, pickOne, unwrap, getAccountStanding } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, ChevronRight, Crosshair } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { PasskeyNudge } from '@/components/passkey-nudge';

type Person = { id: string; full_name: string | null; avatar_url?: string | null };
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
      .select('*, challenge:challenges(*, creator:players!challenges_created_by_fkey(id, full_name, avatar_url))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
    supabase
      .from('match_participants')
      .select(`
        match:matches(
          id, score_summary, played_at, match_type, format, result_status,
          match_participants(team_side, win_flag, player:players(id, full_name, avatar_url))
        )
      `)
      .eq('player_id', player.id)
      .limit(60),
    // Use the same source as /leaderboard rather than querying `ratings`
    // directly. The old query had no status filter, so unapproved signups showed
    // on the feed's ladder while being correctly absent from the leaderboard
    // itself. get_leaderboard() already enforces active_flag, excludes
    // pending_approval/suspended, and honours hide_from_leaderboard — reusing it
    // means the two views cannot drift apart again.
    supabase.rpc('get_leaderboard'),
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
    .filter((m): m is MatchRow => Boolean(m))
    // match_participants has no timestamp, so ordering by the embedded match
    // (a to-one relation) is a no-op in PostgREST. Sort by the match's
    // played_at here (ISO strings sort chronologically) and cap to the count.
    .sort((a, b) => (b.played_at ?? '').localeCompare(a.played_at ?? ''))
    .slice(0, 5);

  // get_leaderboard() returns rows already filtered and sorted; it exposes the
  // display name as `name` (display_name falling back to full_name).
  // get_leaderboard() has no ORDER BY — the leaderboard page sorts per tab in
  // memory — so this must sort explicitly. Ranking by rating is the whole point
  // of the widget; without it the list came out in arbitrary table order.
  const top = ((topRatings ?? []) as { id: string; name: string; avatar_url: string | null; singles_elo: number }[])
    .slice()
    .sort((a, b) => (b.singles_elo ?? 0) - (a.singles_elo ?? 0))
    .map((row) => ({
      person: { id: row.id, full_name: row.name, avatar_url: row.avatar_url } as Person,
      elo: row.singles_elo,
    }))
    .slice(0, 5);

  // Every challenge/session/tournament action is rejected server-side by
  // requirePlayer() until an account is in good standing, so the CTAs that
  // lead there are hidden rather than left to fail on click. This used to test
  // status alone, which let a BANNED account (is_banned is its own column and
  // is never mirrored into status) keep every CTA — getAccountStanding is the
  // same three checks requirePlayer makes, in one place.
  const standing = getAccountStanding(player);
  const isApproved = standing.ok;
  const firstName = player.full_name.split(' ')[0];

  const subBits: string[] = [];
  if (pendingChallenges && pendingChallenges.length > 0) {
    subBits.push(`${pendingChallenges.length} ${pendingChallenges.length === 1 ? 'challenge needs' : 'challenges need'} your response`);
  }
  if (recentMatches.length > 0 && r) {
    subBits.push(`Singles ELO ${r.singles_elo} · ${singlesWinRate} win rate`);
  } else if (isApproved) {
    subBits.push('Issue your first challenge to start climbing.');
  } else {
    // Don't tell someone to do the one thing the server will refuse.
    subBits.push(
      standing.block === 'pending_approval'
        ? 'Your account is waiting on approval.'
        : 'Your account is suspended.',
    );
  }
  const subLine = subBits.join(' · ');

  return (
    <div data-screen-label="Feed">
      <PageHeader
        title={`Welcome back, ${firstName}.`}
        sub={subLine}
        actions={
          // "Browse" duplicated the Leaderboard nav item, so it only added
          // clutter. Issue Challenge is the one action worth surfacing here,
          // and only once the account can actually use it.
          isApproved ? (
            <Link href="/challenges/new" className="btn btn-primary-cta">
              <Plus size={14} /> Issue Challenge
            </Link>
          ) : undefined
        }
      />

      {/* Renders nothing unless this account has no passkey yet and the device
          supports them, so it self-retires once everyone is enrolled. */}
      <PasskeyNudge />

      {/* Hiding the gated features without saying why leaves a new member
          staring at a half-empty app wondering what they did wrong. Say it
          plainly, and point at the one thing they can still do. */}
      {!isApproved && (
        <div
          className="card-base"
          style={{ marginBottom: 16, borderLeft: '3px solid var(--gold, #E0A800)' }}
        >
          <h3 className="card-title" style={{ marginBottom: 6 }}>
            {standing.block === 'pending_approval' ? 'Waiting on approval' : 'Account suspended'}
          </h3>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
            {standing.detail} You can still browse the leaderboard to see where everyone stands.
          </p>
        </div>
      )}

      {r && (
        <div className="hero-banner reveal reveal-1" style={{ marginBottom: 24 }}>
          <div style={{ position: 'relative', zIndex: 2 }}>
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
                  className="row hero-meta"
                  style={{
                    gap: 12,
                    fontSize: 13,
                    fontFamily: 'var(--mono)',
                    letterSpacing: '.02em',
                  }}
                >
                  <span
                    className="hero-meta-dim"
                    style={{
                      width: 64,
                      fontSize: 11,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
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
                    <span className="hero-meta-dim">
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
              {isApproved && (
                <Link href="/challenges/new" className="btn btn-primary">
                  <Crosshair size={14} /> Find an opponent
                </Link>
              )}
              <Link href="/leaderboard" className="btn btn-ghost-inverse">
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
            <div className="card-base reveal reveal-2">
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
                      className="list-row press"
                    >
                      <AvatarChip name={creatorName} id={(creator?.id as string) ?? creatorName} src={creator?.avatar_url as string | null | undefined} size="sm" />
                      <div style={{ flex: 1 }}>
                        <div className="row-title">{creatorName} challenged you</div>
                        <div className="row-sub">
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
              <h3 className="card-title card-title-lg">Recent matches</h3>
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
                <div
                  key={m.id}
                  className="card-base reveal reveal-3"
                  style={{
                    borderLeft: `3px solid ${isWin ? 'var(--win)' : isLoss ? 'var(--loss)' : 'var(--line)'}`,
                  }}
                >
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
                      <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="md" />
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
                      <AvatarChip name={opponent?.full_name ?? '?'} id={opponent?.id ?? ''} src={opponent?.avatar_url} size="md" />
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
                    <AvatarChip name={row.person.full_name ?? '?'} id={row.person.id} src={row.person.avatar_url} size="sm" />
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
        </div>
      </div>
    </div>
  );
}
