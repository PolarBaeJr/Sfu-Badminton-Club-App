import { createServerSupabaseClient, getCurrentPlayer, getActiveSeason } from '@/lib/supabase-server';
import { MATCH_FORMAT_LABELS, formatRelativeTime, getWinRate, pickOne, unwrap, getAccountStanding } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, Crosshair } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { PasskeyNudge } from '@/components/passkey-nudge';
import { RatingSpark } from '@/components/feed/rating-spark';
import { FormRun } from '@/components/feed/form-run';
import { buildFormRun, buildRatingSeries, type ParticipationPoint } from '@/lib/feed-series';

type Person = { id: string; full_name: string | null; handle?: string | null; avatar_url?: string | null };
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
type HistoryRow = {
  played_at: string | null;
  season_id: string | null;
  match_type: string;
  rated_flag: boolean;
  match_participants: { post_rating: number | null; win_flag: boolean | null }[] | null;
};

/** A name and, when the member has one, the handle they chose.
 *
 * 00092's rule, stated once so no call site can quietly break it: the handle
 * travels BESIDE the name, never instead of it, and it is nullable — a member
 * who has not picked one renders as just their name, with no orphaned dot. */
function NameWithHandle({
  name,
  handle,
  size = 14,
}: { name: string; handle?: string | null; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600, fontSize: size }}>{name}</span>
      {handle && (
        <span className="mono muted" style={{ fontSize: Math.max(10, size - 3) }}>
          @{handle}
        </span>
      )}
    </span>
  );
}

/** One format's current rating: the number, where it has been, and whether it
 *  counts yet. Provisional is not decoration — a provisional rating is not
 *  comparable to an established one, and the member needs to know which they
 *  are looking at before they read the line. */
function RatingRow({
  label,
  elo,
  provisional,
  matchesLeft,
  series,
}: {
  label: string;
  elo: number;
  provisional: boolean;
  matchesLeft: number;
  series: ReturnType<typeof buildRatingSeries>;
}) {
  const change = series?.change ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span
          className="hero-meta-dim"
          style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }}
        >
          {label}
        </span>
        <span
          className="mono"
          style={{ fontFamily: 'var(--display)', fontSize: 34, fontWeight: 700, letterSpacing: '-.03em', lineHeight: 1 }}
        >
          {elo}
        </span>
        {series && change !== 0 && (
          <span
            className="mono"
            style={{ fontSize: 12, color: change > 0 ? 'var(--win)' : 'var(--loss)' }}
          >
            {change > 0 ? '+' : ''}
            {change} over {series.ratings.length}
          </span>
        )}
        <span
          className={provisional ? 'tag tag-gold' : 'tag tag-win'}
          style={{ marginLeft: 'auto' }}
        >
          {provisional ? `Provisional · ${matchesLeft} to go` : 'Established'}
        </span>
      </div>

      {series ? (
        <RatingSpark
          series={series}
          label={`${label} rating over the last ${series.ratings.length} rated matches, now ${series.last}`}
        />
      ) : (
        // An empty chart with no explanation reads as a bug. Say what it means.
        <div
          className="hero-meta-dim"
          style={{ fontSize: 12, height: 56, display: 'flex', alignItems: 'center' }}
        >
          Play a rated {label.toLowerCase()} match to start your line.
        </div>
      )}
    </div>
  );
}

export default async function FeedPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const r = pickOne(player.ratings);

  const [
    pendingChallengesRes,
    matchParticipationsRes,
    ratingHistoryRes,
    topRatingsRes,
    activeSeason,
  ] = await Promise.all([
    supabase
      .from('challenge_participants')
      .select('*, challenge:challenges(*, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
    supabase
      .from('match_participants')
      .select(`
        match:matches(
          id, score_summary, played_at, match_type, format, result_status,
          match_participants(team_side, win_flag, player:players(id, full_name, handle, avatar_url))
        )
      `)
      .eq('player_id', player.id)
      .limit(60),
    // The chart series is its own query, driven from `matches` rather than from
    // `match_participants`, for one reason: this one can be ORDERED. Ordering a
    // top-level match_participants query by the embedded match's played_at is a
    // no-op in PostgREST (see the sort below), so that query can only take an
    // arbitrary 60 rows and hope the recent ones are among them — fine for the
    // five cards it draws, wrong for "the last 20 rated matches".
    //
    // The !inner embed filtered to this player narrows the embedded rows to the
    // member's own participation, which is exactly what a personal series
    // wants; nobody else's post_rating is fetched.
    supabase
      .from('matches')
      .select('played_at, season_id, match_type, rated_flag, match_participants!inner(post_rating, win_flag)')
      .eq('match_participants.player_id', player.id)
      .not('played_at', 'is', null)
      .order('played_at', { ascending: false })
      .limit(40),
    // Use the same source as /leaderboard rather than querying `ratings`
    // directly. The old query had no status filter, so unapproved signups showed
    // on the feed's ladder while being correctly absent from the leaderboard
    // itself. get_leaderboard() already enforces active_flag, excludes
    // pending_approval/suspended, and honours hide_from_leaderboard — reusing it
    // means the two views cannot drift apart again.
    supabase.rpc('get_leaderboard'),
    getActiveSeason(),
  ]);

  const pendingChallenges = unwrap(pendingChallengesRes);
  const matchParticipations = unwrap(matchParticipationsRes);
  const ratingHistory = unwrap(ratingHistoryRes) as HistoryRow[] | null;
  const topRatings = unwrap(topRatingsRes);

  const singlesWinRate = r ? getWinRate(r.singles_wins, r.singles_losses) : '—';
  const singlesStreak = (r as Record<string, unknown> | null | undefined)?.current_singles_streak as number | undefined;
  const streakLabel =
    typeof singlesStreak === 'number' && singlesStreak !== 0
      ? `${singlesStreak > 0 ? 'W' : 'L'}${Math.abs(singlesStreak)}`
      : '—';

  // Flatten the history rows into the shape the derivations take. The embed is
  // an array because PostgREST types a filtered to-many that way, but the
  // player_id filter guarantees at most one entry per match.
  const historyPoints: ParticipationPoint[] = (ratingHistory ?? []).map((row) => {
    const own = row.match_participants?.[0];
    return {
      playedAt: row.played_at,
      matchType: row.match_type,
      rated: row.rated_flag,
      seasonId: row.season_id,
      postRating: own?.post_rating ?? null,
      winFlag: own?.win_flag ?? null,
    };
  });

  const singlesSeries = buildRatingSeries(historyPoints, 'singles');
  const doublesSeries = buildRatingSeries(historyPoints, 'doubles');
  const formRun = buildFormRun(historyPoints);

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

  // get_leaderboard() returns rows already filtered and sorted; it exposes
  // full_name as `name` and, since 00092, the member's handle beside it.
  // get_leaderboard() has no ORDER BY — the leaderboard page sorts per tab in
  // memory — so this must sort explicitly. Ranking by rating is the whole point
  // of the widget; without it the list came out in arbitrary table order.
  const top = ((topRatings ?? []) as {
    id: string;
    name: string;
    handle: string | null;
    avatar_url: string | null;
    singles_elo: number;
  }[])
    .slice()
    .sort((a, b) => (b.singles_elo ?? 0) - (a.singles_elo ?? 0))
    .map((row) => ({
      person: { id: row.id, full_name: row.name, handle: row.handle, avatar_url: row.avatar_url } as Person,
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

  const pendingList = pendingChallenges ?? [];
  const pendingCount = pendingList.length;
  // One line, and it says the most urgent true thing rather than everything at
  // once. The old header concatenated up to three clauses with dots, which on a
  // 360px phone wrapped to three lines of small grey text nobody read.
  const stateLine = !isApproved
    ? standing.block === 'pending_approval'
      ? 'Your account is waiting on approval.'
      : 'Your account is suspended.'
    : pendingCount > 0
      ? `${pendingCount} ${pendingCount === 1 ? 'challenge needs' : 'challenges need'} your response.`
      : formRun.results.length > 0
        ? `${formRun.wins}W · ${formRun.losses}L over your last ${formRun.results.length}.`
        : 'No matches yet — issue a challenge to start climbing.';

  return (
    <div data-screen-label="Feed">
      <PageHeader
        eyebrow={activeSeason ? `FEED · ${activeSeason.name}` : 'FEED'}
        title={`Welcome back, ${firstName}.`}
        sub={
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            {player.handle && <span className="mono">@{player.handle}</span>}
            <span>{stateLine}</span>
          </span>
        }
      />

      {/* Renders nothing unless this account has no passkey yet and the device
          supports them, so it self-retires once everyone is enrolled. */}
      <PasskeyNudge />

      {/* Hiding the gated features without saying why leaves a new member
          staring at a half-empty app wondering what they did wrong. Say it
          plainly, and point at the one thing they can still do. */}
      {!isApproved && (
        <div className="card-base" style={{ marginBottom: 20, borderLeft: '3px solid var(--gold)' }}>
          <h3 className="card-title" style={{ marginBottom: 6 }}>
            {standing.block === 'pending_approval' ? 'Waiting on approval' : 'Account suspended'}
          </h3>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
            {standing.detail} You can still browse the leaderboard to see where everyone stands.
          </p>
        </div>
      )}

      {r && (
        <div className="hero-banner reveal reveal-1" style={{ marginBottom: 20 }}>
          <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div className="eyebrow">Your rating</div>
            <RatingRow
              label="Singles"
              elo={r.singles_elo}
              provisional={!!r.singles_provisional}
              matchesLeft={Math.max(0, 8 - ((r.singles_wins ?? 0) + (r.singles_losses ?? 0)))}
              series={singlesSeries}
            />
            <RatingRow
              label="Doubles"
              elo={r.doubles_elo}
              provisional={!!r.doubles_provisional}
              matchesLeft={Math.max(0, 8 - ((r.doubles_wins ?? 0) + (r.doubles_losses ?? 0)))}
              series={doublesSeries}
            />
          </div>
          <div className="hero-stats">
            <div className="stat">
              <div className="stat-label">Win rate</div>
              <div className="stat-value mono">{singlesWinRate}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Streak</div>
              <div className="stat-value mono">{streakLabel}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Singles</div>
              <div className="stat-value mono">{(r.singles_wins ?? 0) + (r.singles_losses ?? 0)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Doubles</div>
              <div className="stat-value mono">{(r.doubles_wins ?? 0) + (r.doubles_losses ?? 0)}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-12">
        <div style={{ gridColumn: 'span 8' }} className="feed-col">
          {pendingCount > 0 && (
            <div className="card-base reveal reveal-2">
              <div className="card-head">
                <div>
                  <h3 className="card-title">Needs your response</h3>
                  <div className="card-sub">Answering keeps your reliability up.</div>
                </div>
                <span className="tag tag-red">{pendingCount} waiting</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pendingList.map((pc) => {
                  const c = pc.challenge as Record<string, unknown> | null;
                  if (!c) return null;
                  const creator = c.creator as Record<string, unknown> | null;
                  const creatorName = (creator?.full_name as string) || 'Someone';
                  return (
                    <Link key={pc.id} href={`/challenges/${c.id}`} className="list-row press">
                      <AvatarChip
                        name={creatorName}
                        id={(creator?.id as string) ?? creatorName}
                        src={creator?.avatar_url as string | null | undefined}
                        size="sm"
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row-title">
                          <NameWithHandle
                            name={creatorName}
                            handle={creator?.handle as string | null | undefined}
                          />{' '}
                          challenged you
                        </div>
                        <div className="row-sub">
                          {(c.type as string) || ''} ·{' '}
                          {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS] ||
                            (c.format as string)}
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

          <div className="card-base reveal reveal-2">
            <div className="card-head" style={{ marginBottom: 12 }}>
              <div>
                <h3 className="card-title">Recent form</h3>
                <div className="card-sub">Oldest on the left.</div>
              </div>
              {formRun.results.length > 0 && (
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {formRun.wins}W · {formRun.losses}L
                </span>
              )}
            </div>
            {formRun.results.length > 0 ? (
              <FormRun run={formRun} />
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>
                No confirmed results yet. Your first win lands here.
              </div>
            )}
          </div>

          <div>
            <div className="card-head" style={{ marginBottom: 12 }}>
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
                <div className="empty">
                  <div className="empty-title">Nothing played yet</div>
                  <div className="empty-hint">
                    A new member starts here. Issue a challenge to get rolling — your first
                    confirmed result sets your line moving.
                  </div>
                </div>
              </div>
            ) : (
              <div className="feed-col">
                {recentMatches.map((m) => {
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

                  const formatLabel =
                    MATCH_FORMAT_LABELS[m.format as keyof typeof MATCH_FORMAT_LABELS] || m.format;
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
                        <div
                          className="right mono"
                          style={{ color: isWin ? 'var(--win)' : isLoss ? 'var(--loss)' : 'var(--mute)' }}
                        >
                          {isWin ? 'WIN' : isLoss ? 'LOSS' : 'PENDING'}
                        </div>
                      </div>
                      <div className="feed-match">
                        <div className="side">
                          <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="md" />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 15 }}>You</div>
                            {partnerPerson && (
                              <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                                + {partnerPerson.full_name}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <div className="score mono">
                            <span style={{ opacity: isWin ? 1 : 0.4 }}>{myTotal}</span>
                            <span className="muted" style={{ margin: '0 8px', fontWeight: 400 }}>
                              :
                            </span>
                            <span style={{ opacity: !isWin ? 1 : 0.4 }}>{oppTotal}</span>
                          </div>
                          {games.length > 0 && (
                            <div className="score-mini">
                              {games.map(([a, b], i) => {
                                const mine = me?.team_side === 'a' ? a : b;
                                const theirs = me?.team_side === 'a' ? b : a;
                                return (
                                  <span key={i}>
                                    {mine}–{theirs}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="side right">
                          <AvatarChip
                            name={opponent?.full_name ?? '?'}
                            id={opponent?.id ?? ''}
                            src={opponent?.avatar_url}
                            size="md"
                          />
                          <div style={{ minWidth: 0 }}>
                            <NameWithHandle
                              name={opponent?.full_name ?? 'Opponent'}
                              handle={opponent?.handle}
                              size={15}
                            />
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
                })}
              </div>
            )}
          </div>
        </div>

        <div style={{ gridColumn: 'span 4' }} className="feed-col">
          <div className="card-base">
            <div className="card-head">
              <h3 className="card-title">Top of the ladder</h3>
              {activeSeason && <span className="tag">{activeSeason.name}</span>}
            </div>
            {top.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}>
                <div className="empty-title">No ratings yet</div>
                <div className="empty-hint">
                  The ladder fills in as members play their first rated matches this season.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {top.map((row, i) => (
                  <Link
                    key={row.person.id}
                    href="/leaderboard"
                    className="row press"
                    style={{ padding: '10px 8px', borderRadius: 0, width: '100%', textAlign: 'left' }}
                  >
                    <div
                      className="mono"
                      style={{ width: 26, color: i < 3 ? 'var(--red)' : 'var(--mute)', fontSize: 13, fontWeight: 600 }}
                    >
                      #{i + 1}
                    </div>
                    <AvatarChip
                      name={row.person.full_name ?? '?'}
                      id={row.person.id}
                      src={row.person.avatar_url}
                      size="sm"
                      ring={row.person.id === player.id}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <NameWithHandle name={row.person.full_name ?? '?'} handle={row.person.handle} size={13} />
                    </div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
                      {row.elo}
                    </div>
                  </Link>
                ))}
              </div>
            )}
            <div className="sep" />
            <Link href="/leaderboard" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
              View full leaderboard <ChevronRight size={12} />
            </Link>
          </div>

          {/* THE one primary action on this screen, and the last thing in the
              document. At ≤980px .grid-12 collapses to a single column in
              source order, so this lands at the bottom of the scroll — where a
              thumb is — without a fixed bar that would have to clear the tab
              bar, the toast viewport and the safe-area inset by hand. It is
              hidden outright for an account requirePlayer() would refuse. */}
          {isApproved && (
            <Link
              href="/challenges/new"
              className="btn btn-primary btn-lg press"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <Crosshair size={16} /> Issue a challenge
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
