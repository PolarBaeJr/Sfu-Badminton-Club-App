'use client';

import { useState } from 'react';
import { getWinRate } from '@badminton/shared';
import type { RatingPoint } from '@/lib/stats-charts';
import { RatingChart } from './rating-chart';

export interface PastDiscipline {
  /** Every rated, confirmed match of that discipline in that season, oldest first. */
  points: RatingPoint[];
  /**
   * The member's Elo in `season_final_ratings` for this season, or null when the
   * club never closed the term off while they were on the ladder.
   *
   * NOT the last point of the line, and the two can legitimately differ: the
   * archive is written when the NEXT season is activated, which may be weeks
   * after the last match, and 00084 edits it retroactively when an old match is
   * corrected while leaving the historical post_rating on the match alone. They
   * are two different facts and the card labels them as two different facts.
   */
  closingElo: number | null;
  wins: number;
  losses: number;
}

/**
 * A finished term's rating, for one discipline at a time.
 *
 * The live card's switch and chart, with its headline replaced. On /my-stats
 * the big figure is the member's rating right now; here there is no "now" — the
 * season is over — so the figure is whichever of the two archived facts exists,
 * and it says which one it is underneath rather than leaving the reader to
 * assume. "Provisional" is not shown at all: that flag lives on the live
 * `ratings` row and describes today, and there is no record of whether the
 * member was still settling back then.
 */
export function PastRatingCard({
  singles,
  doubles,
  seasonName,
}: {
  singles: PastDiscipline;
  doubles: PastDiscipline;
  seasonName: string;
}) {
  const [discipline, setDiscipline] = useState<'singles' | 'doubles'>(
    singles.points.length === 0 && doubles.points.length > 0 ? 'doubles' : 'singles'
  );
  const active = discipline === 'singles' ? singles : doubles;
  const label = discipline === 'singles' ? 'Singles' : 'Doubles';

  const lastPoint = active.points[active.points.length - 1] ?? null;
  // The archived ladder is the better answer where it exists — it is what the
  // club's own records say the member finished on, and it is the number a
  // correction to an old match moves. Where it does not, the last match of the
  // term is still a true statement about that term, so it is shown under its own
  // name instead of the archive's.
  const headline = active.closingElo ?? lastPoint?.rating ?? null;
  const headlineNote =
    active.closingElo !== null
      ? `${label.toUpperCase()} ELO WHEN ${seasonName.toUpperCase()} WAS CLOSED OFF`
      : lastPoint
        ? `${label.toUpperCase()} ELO AFTER YOUR LAST MATCH OF ${seasonName.toUpperCase()}`
        : null;

  return (
    <div className="card-base">
      <div className="card-head">
        <h3 className="card-title">Rating through {seasonName}</h3>
        <div className="chips" role="tablist" aria-label="Discipline">
          {(['singles', 'doubles'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={discipline === d}
              className={'filter-chip' + (discipline === d ? ' active' : '')}
              onClick={() => setDiscipline(d)}
            >
              {d === 'singles' ? 'Singles' : 'Doubles'}
              <span className="count">{(d === 'singles' ? singles : doubles).points.length}</span>
            </button>
          ))}
        </div>
      </div>

      {headline !== null && (
        <div style={{ marginBottom: 16 }}>
          <div
            className="me-rating-figure"
            style={{
              fontFamily: 'var(--display)',
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: '-.02em',
            }}
          >
            {headline}
          </div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 6, letterSpacing: '.08em' }}>
            {headlineNote}
          </div>
          {(active.wins + active.losses > 0) && (
            <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>
              {getWinRate(active.wins, active.losses)} of {active.wins + active.losses} that season
            </div>
          )}
        </div>
      )}

      {active.points.length === 0 ? (
        <div className="empty" style={{ padding: '32px 20px' }}>
          <div className="empty-title">No rated {label.toLowerCase()} that season</div>
          <div className="empty-hint">
            Only rated, confirmed matches move a rating, so there is no line to draw for{' '}
            {label.toLowerCase()} in {seasonName}.
          </div>
        </div>
      ) : (
        <RatingChart
          points={active.points}
          // No prior-season rule and no divider: this chart IS one season, so a
          // boundary inside it would be marking nothing, and the live card
          // already carries the comparison against the term before.
          priorRating={null}
          priorSeasonName={null}
          seasonStart={null}
          provisional={false}
          label={label}
          // "ENDED", not "LAST MATCH": the four figures under the chart are one
          // flex row of 25% cells, and a ten-character label wraps at 390px and
          // shoves its own number onto a second line. Five characters is
          // shorter than the "CURRENT" this replaces, so the row is no tighter
          // than it is on the live screen — and it still says something the
          // headline above does not, which is where the LINE stopped rather
          // than what the club archived.
          currentLabel="ENDED"
        />
      )}
    </div>
  );
}
