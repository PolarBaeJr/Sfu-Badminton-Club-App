import Link from 'next/link';
import { previewEloSwing } from '@badminton/shared';
import { DStat, DPanel } from '@/components/desktop/page-shell';
import { NextCardActions } from './next-card-actions';

type Ratings = {
  singles_elo: number | null;
  doubles_elo: number | null;
  doubles_wins: number | null;
  doubles_losses: number | null;
};

type FiveRow = {
  id: string;
  win_flag: boolean | null;
  rating_delta: number | null;
  match: {
    id: string;
    score_summary: string;
    played_at: string;
    match_type: string;
    result_status: string;
  } | null;
  opponent_name: string | null;
};

type NextChallenge = {
  id: string;
  format: string | null;
  scheduled_at: string | null;
  participants: Array<{
    role: string;
    players: {
      full_name: string;
      ratings:
        | { singles_elo: number | null; doubles_elo: number | null }[]
        | { singles_elo: number | null; doubles_elo: number | null }
        | null;
    } | null;
  }>;
};

interface FeedDesktopViewProps {
  seasonLabel: string;
  myRank: number;
  myElo: number;
  ratings: Ratings | null;
  singlesSeasonDelta: number;
  doublesSeasonDelta: number;
  totalMatches: number;
  totalWins: number;
  winRate: number;
  rankDeltaLabel: string;
  recentFive: FiveRow[];
  nextChallenge: NextChallenge | null;
}

/**
 * Desktop variant of /feed (player-app.html dashboard). Visibility is
 * .d-only — toggled at the 1024px breakpoint by globals.css.
 *
 * Hero copy is hardcoded per Phase 10 Decision #1 ("Born on the court.") —
 * the dynamic time-of-day greeting was dropped to match the design exactly.
 * Watermark is the literal "A1" from the design (not the player's initials
 * or rank — confirmed in the audit pass).
 */
export function FeedDesktopView({
  seasonLabel,
  myRank,
  myElo,
  ratings,
  singlesSeasonDelta,
  doublesSeasonDelta,
  totalMatches,
  totalWins,
  winRate,
  rankDeltaLabel,
  recentFive,
  nextChallenge,
}: FeedDesktopViewProps) {
  return (
    <div className="d-only">
      {/* HERO ─ matches player-app.html lines 797-805 exactly. */}
      <div className="d-hero">
        <div className="d-hero-watermark">A1</div>
        <div className="d-hero-inner">
          <div className="d-tag-row">
            <span className="d-red-line" />
            <span className="d-micro d-micro-red">{seasonLabel}</span>
          </div>
          <h1>
            Born on the
            <br />
            court.
          </h1>
          <p>
            ELO that moves with every match. Sessions you can join on the fly. Challenges that end
            on the score, not the dispute.
          </p>
        </div>
      </div>

      {/* STATS GRID ─ 4-up. Rank / Singles ELO / Doubles ELO / Win Rate.
          ELO deltas are SEASON-net (sum of every rating change since the
          active season started), not last-match deltas. */}
      <div className="d-stats-grid">
        <DStat
          label="Rank"
          value={ratings?.singles_elo != null ? `#${myRank}` : '—'}
          delta={rankDeltaLabel}
        />
        <DStat
          label="Singles ELO"
          value={ratings?.singles_elo ?? '—'}
          delta={
            singlesSeasonDelta !== 0
              ? `${singlesSeasonDelta >= 0 ? '+' : ''}${singlesSeasonDelta} this season`
              : 'No matches yet'
          }
          deltaTone={
            singlesSeasonDelta > 0 ? 'up' : singlesSeasonDelta < 0 ? 'down' : 'neutral'
          }
        />
        <DStat
          label="Doubles ELO"
          value={ratings?.doubles_elo ?? '—'}
          delta={
            doublesSeasonDelta !== 0
              ? `${doublesSeasonDelta >= 0 ? '+' : ''}${doublesSeasonDelta} this season`
              : 'No matches yet'
          }
          deltaTone={
            doublesSeasonDelta > 0 ? 'up' : doublesSeasonDelta < 0 ? 'down' : 'neutral'
          }
        />
        <DStat
          label="Win Rate"
          value={totalMatches > 0 ? `${winRate}%` : '—'}
          delta={`${totalWins}W · ${totalMatches - totalWins}L`}
        />
      </div>

      {/* NEXT CHALLENGE ─ rendered only when an incoming pending challenge
          exists. Hidden entirely when there isn't one (per Decision #3 —
          empty grids look broken). */}
      {nextChallenge && nextChallenge.participants?.length > 0 && (() => {
        const oppParticipant = nextChallenge.participants.find((p) => p.role !== 'challenger');
        const opp = oppParticipant?.players;
        const oppName = opp?.full_name ?? 'Opponent';
        const oppRatings = Array.isArray(opp?.ratings) ? opp?.ratings[0] : opp?.ratings;
        const oppElo = oppRatings?.singles_elo ?? null;
        const swing = oppElo != null ? previewEloSwing(myElo, oppElo) : { win: 0, loss: 0 };
        const fmt = nextChallenge.format ?? 'singles';
        const when = nextChallenge.scheduled_at
          ? new Date(nextChallenge.scheduled_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : 'Time TBD';
        return (
          <div className="d-next-card">
            <div className="d-next-card-inner">
              <div className="d-micro" style={{ color: 'var(--ink)' }}>
                Next Challenge
              </div>
              <div className="d-next-card-name">{oppName}</div>
              <div className="d-next-card-meta">
                {oppElo != null && `ELO ${oppElo} · `}
                {fmt.charAt(0).toUpperCase() + fmt.slice(1)} · {when}
              </div>
              <div className="d-next-card-elo">
                If you win: <span className="d-pos">+{swing.win}</span> ELO &nbsp;·&nbsp; If you lose:{' '}
                <span className="d-neg">{swing.loss}</span> ELO
              </div>
            </div>
            <div className="d-next-card-actions">
              <NextCardActions challengeId={nextChallenge.id} />
            </div>
          </div>
        );
      })()}

      {/* RECENT MATCHES ─ 6-column table with Opponent. Empty state covers
          the no-history case without breaking the panel chrome. */}
      <DPanel
        label="Recent Matches"
        sublabel="/ Last 5"
        action={
          <Link href="/my-matches" className="d-view-all">
            View All →
          </Link>
        }
      >
        <div className="d-table-wrap">
          <table className="d-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Opponent</th>
                <th>Format</th>
                <th>Score</th>
                <th>Result</th>
                <th>ELO Δ</th>
              </tr>
            </thead>
            <tbody>
              {recentFive.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ color: 'var(--text-faint)', textAlign: 'center', padding: '32px 24px' }}
                  >
                    No matches yet — log your first one!
                  </td>
                </tr>
              ) : (
                recentFive.map((row) => {
                  const m = row.match;
                  if (!m) return null;
                  const date = new Date(m.played_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  });
                  return (
                    <tr key={row.id}>
                      <td className="d-td-date">{date}</td>
                      <td className="d-td-name">{row.opponent_name ?? '—'}</td>
                      <td className="d-td-date" style={{ textTransform: 'capitalize' }}>
                        {m.match_type}
                      </td>
                      <td className="d-td-elo" style={{ fontSize: 12 }}>
                        {m.score_summary || '—'}
                      </td>
                      <td className={row.win_flag ? 'd-td-win' : 'd-td-loss'}>
                        {row.win_flag ? 'WIN' : 'LOSS'}
                      </td>
                      <td className={(row.rating_delta ?? 0) >= 0 ? 'd-delta-pos' : 'd-delta-neg'}>
                        {row.rating_delta != null
                          ? `${row.rating_delta >= 0 ? '+' : ''}${row.rating_delta}`
                          : '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </DPanel>
    </div>
  );
}
