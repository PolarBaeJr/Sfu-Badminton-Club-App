'use client';

import { useState } from 'react';
import { getWinRate } from '@badminton/shared';
import type { RatingPoint } from '@/lib/stats-charts';
import { RatingChart } from './rating-chart';

export type Discipline = 'singles' | 'doubles';

export interface DisciplineStats {
  elo: number;
  provisional: boolean;
  wins: number;
  losses: number;
  points: RatingPoint[];
  /** Final rating in the previous season, when one was archived. */
  priorRating: number | null;
}

export interface RatingCardProps {
  singles: DisciplineStats;
  doubles: DisciplineStats;
  priorSeasonName: string | null;
  seasonStart: string | null;
}

/**
 * Singles and doubles are rated separately, so they get one card with a switch
 * rather than two cards side by side. Two charts stacked on a phone means the
 * second one is below the fold and is compared to the first from memory; a
 * switch puts them in the same place so the difference is the thing that moves.
 *
 * Client-side because the switch is, and only because of that — everything it
 * draws is computed on the server and handed down as props, so flipping the tab
 * costs no request.
 *
 * The recent-form strip used to hang off the bottom of this card. It moved into
 * a card of its own (FormCard) so the wide layout has something to put in the
 * side rail, and it went from per-discipline to overall on the way: a rail card
 * with no switch of its own cannot borrow this one's, and "am I winning lately"
 * is one question whichever discipline the member happened to play. On a phone
 * the two cards are still adjacent, in this order.
 */
export function RatingCard({ singles, doubles, priorSeasonName, seasonStart }: RatingCardProps) {
  // Doubles is the default when the member has never played a rated singles
  // match, so the card does not open on an empty chart for the many members who
  // only ever play doubles.
  const [discipline, setDiscipline] = useState<Discipline>(
    singles.points.length === 0 && doubles.points.length > 0 ? 'doubles' : 'singles'
  );
  const active = discipline === 'singles' ? singles : doubles;
  const label = discipline === 'singles' ? 'Singles' : 'Doubles';

  return (
    <div className="card-base">
      <div className="card-head">
        <h3 className="card-title">Rating over time</h3>
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

      <div className="row" style={{ gap: 14, alignItems: 'baseline', marginBottom: 16 }}>
        {/* The figure grows with the card rather than staying phone-sized in a
            column two and a half times as wide — see .me-rating-figure. */}
        <div
          className="me-rating-figure"
          style={{
            fontFamily: 'var(--display)',
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-.02em',
          }}
        >
          {active.elo}
        </div>
        <div className="mono muted" style={{ fontSize: 12 }}>
          {label.toUpperCase()} ELO · {getWinRate(active.wins, active.losses)} of{' '}
          {active.wins + active.losses}
          {active.provisional && ' · PROVISIONAL'}
        </div>
      </div>

      <RatingChart
        points={active.points}
        priorRating={active.priorRating}
        priorSeasonName={priorSeasonName}
        seasonStart={seasonStart}
        provisional={active.provisional}
        label={label}
      />
    </div>
  );
}
