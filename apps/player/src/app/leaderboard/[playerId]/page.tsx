import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { getPublicProfile } from '@/lib/public-profile';
import { getRatingSettings } from '@/lib/rating-settings';
import { getKFactor, PLAYER_STATUS_LABELS, getWinRate, getStreakDisplay, getPointDifferential, formatDate, buildChallengeQrUrl, getAccountStanding } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft, Crosshair, QrCode, Trophy } from 'lucide-react';
import Link from 'next/link';
import { AvatarChip } from '@badminton/ui';
import { StandingNote } from '@/components/standing-notice';
import QRCode from 'qrcode';

export default async function PlayerProfilePage({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  const supabase = await createServerSupabaseClient();
  // The *viewer's* standing, not the profile's — this decides whether we offer
  // them the Challenge link, which createChallenge would refuse.
  //
  // The player row itself is kept now as well as the standing derived from it,
  // because `hide_from_leaderboard` is a rule about OTHER people: a member who
  // has opted out still sees their own numbers here, exactly as /my-stats and
  // the feed's own-record card show them.
  const viewer = await getCurrentPlayer();
  const standing = getAccountStanding(viewer);

  const [
    player,
    { data: rating },
    ratingSettings,
    { data: recentMatchesRaw },
    { data: h2hStats },
  ] = await Promise.all([
    // FIX-LIST #11: this page no longer queries the members table with the
    // viewer's own key. That key may read the status column, and the raw column
    // says `suspended`. This helper reads it server-side and hands back only
    // what this viewer is entitled to — see lib/public-profile.ts, which also
    // re-applies players_select's row rule, because the service-role key skips
    // RLS as well as the column grants.
    getPublicProfile(playerId, viewer),
    supabase.from('ratings').select('*').eq('player_id', playerId).single(),
    // The K chip below used to render ratings.singles_k_factor /
    // doubles_k_factor. Those columns hold the PROVISIONAL constants (80 and
    // 64), and the chip only shows when the player is NOT provisional — so
    // every established player was shown a K the ladder does not use. 00138
    // recorded the mismatch as measured and left it. The number is derived
    // from the same settings row and the same helper apply_match_result reads,
    // rather than from a column that copied a tunable at write time.
    getRatingSettings(supabase),
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

  // FIX-LIST #14. `get_leaderboard()` honours this flag; this page did not, and
  // the feed links every match row straight to it — so the control the settings
  // screen offers ("Show on leaderboard · Your rank will be visible to others")
  // was undone by one tap on somebody's name.
  //
  // WHAT IT HIDES IS THE RATING, NOT THE PERSON. The promise on that switch is
  // about the member's rank, so the profile still renders: name, photo, bio,
  // track, the Challenge link and the results themselves. Blanket-404ing the
  // page would take away a surface the member never asked to lose and would
  // break every match row in the feed that points at it. What goes is the pair
  // of Elo cards and the per-match rating delta — the figures, and the numbers
  // they can be reconstructed from.
  //
  // NOT APPLIED TO THE MEMBER'S OWN PROFILE. The flag governs what everyone
  // else sees; hiding someone's rating from themselves would be a bug, not a
  // privacy feature.
  const hidesRatings = player.hide_from_leaderboard === true && player.id !== viewer?.id;
  const r = hidesRatings ? null : rating;

  // QR encoding the absolute form of the Challenge link beside it, so another
  // member can point a phone camera at this profile and land on a prefilled
  // challenge. Generated here (async server component) so `qrcode` never
  // reaches the client bundle. Null when NEXT_PUBLIC_PLAYER_URL /
  // NEXT_PUBLIC_APP_URL are unset at build time — then no QR is rendered.
  const challengeUrl = buildChallengeQrUrl(
    process.env.NEXT_PUBLIC_PLAYER_URL || process.env.NEXT_PUBLIC_APP_URL,
    playerId
  );
  const challengeQrSvg = challengeUrl
    ? await QRCode.toString(challengeUrl, { type: 'svg', margin: 1 })
    : null;

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
    <div data-screen-label="Player Profile">
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
              {/* Null when the value is a moderation state and the viewer is
                  not the member themselves — the pill disappears rather than
                  being relabelled, because a euphemism ("Inactive") next to a
                  member who is plainly active is its own disclosure. */}
              {player.visibleStatus && (
                <span className={'pill ' + (player.visibleStatus === 'competitive' ? 'pill-red' : 'pill-out')}>
                  {PLAYER_STATUS_LABELS[player.visibleStatus]?.toUpperCase()}
                </span>
              )}
              {r?.singles_provisional && <span className="pill pill-out">PROVISIONAL</span>}
            </div>
            {player.bio && (
              <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.55, color: 'var(--ink-2)', maxWidth: '56ch' }}>
                {player.bio}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
            {/* Kept alongside the QR — on desktop nobody scans their own screen.
                The QR stays either way: it is how someone ELSE challenges this
                profile, so the viewer's own standing has no bearing on it. */}
            {standing.ok ? (
              <Link href={`/challenges/new?opponent=${playerId}`} className="btn btn-primary">
                <Crosshair size={14} /> Challenge
              </Link>
            ) : (
              <StandingNote standing={standing} activity="Challenges" />
            )}
            {challengeQrSvg && (
              <details>
                <summary
                  className="press"
                  style={{ cursor: 'pointer', fontSize: 12, color: 'var(--mute)', listStyle: 'none' }}
                >
                  <span className="row" style={{ display: 'inline-flex', gap: 6 }}>
                    <QrCode size={13} /> Show QR
                  </span>
                </summary>
                {/* The qrcode lib emits only <svg><path d="..."/></svg> — the URL
                    is encoded into the modules, never interpolated into markup —
                    so this renders as a data URI rather than raw inner HTML. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/svg+xml;base64,${Buffer.from(challengeQrSvg).toString('base64')}`}
                  alt={`QR code opening a new challenge against ${player.full_name}`}
                  width={132}
                  height={132}
                  style={{ marginTop: 8, borderRadius: 8, background: '#fff', padding: 6 }}
                />
              </details>
            )}
          </div>
        </div>
      </div>

      {hidesRatings && (
        <div className="card-base" style={{ padding: 16, marginBottom: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {player.full_name.split(' ')[0]} has chosen not to show their rating.
          </div>
        </div>
      )}

      {r && (
        <>
          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div className="card-base">
              <div className="stat-label">SINGLES ELO</div>
              <div className="stat-value">{r.singles_elo}</div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
                {r.singles_provisional ? 'Provisional' : `K=${getKFactor('singles', false, r.singles_matches_played, ratingSettings)}`} · {r.singles_wins}W–{r.singles_losses}L · {getWinRate(r.singles_wins, r.singles_losses)}
              </div>
            </div>
            <div className="card-base">
              <div className="stat-label">DOUBLES ELO</div>
              <div className="stat-value">{r.doubles_elo}</div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
                {r.doubles_provisional ? 'Provisional' : `K=${getKFactor('doubles', false, r.doubles_matches_played, ratingSettings)}`} · {r.doubles_wins}W–{r.doubles_losses}L · {getWinRate(r.doubles_wins, r.doubles_losses)}
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
                  {/* Withheld with the Elo cards above, and for a stronger
                      reason than symmetry: a run of deltas beside a known
                      starting point reconstructs the number the member asked
                      to withhold. */}
                  {typeof delta === 'number' && !hidesRatings && (
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
