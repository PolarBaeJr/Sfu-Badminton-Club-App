import { Card } from '@badminton/ui';
import { PanelLabel, PANEL_NOTE } from './panel';
import { seasonProgress, shortDate, type SeasonShape } from './season-shape';

interface ProgressSeason extends SeasonShape {
  name: string;
}

/**
 * How far through the live season the club is.
 *
 * The bar is one block per week, and it is drawn from `start_date` and
 * `end_date` alone — nothing here is stored. Elapsed weeks take the club accent;
 * the remainder is a surface step rather than a colour, which is where the
 * console's depth is supposed to come from.
 *
 * FOUR STATES, all of them reachable in the schema and all of them rendered:
 *
 *   no live season       — the panel says so. A blank panel reads as broken.
 *   not started yet      — no week number exists, so it shows the start date.
 *   no end_date          — end_date is nullable, so a week number without a
 *                          total is legal; the bar cannot be drawn and is not.
 *   running / overdue    — the ordinary case. Week is clamped at the total, so
 *                          a season nobody closed reads as full, not as 24/17.
 */
export function SeasonProgressCard({ season }: { season: ProgressSeason | null }) {
  if (!season) {
    return (
      <Card padding={false}>
        <div className="px-5 pt-5 pb-5">
          <PanelLabel label="Season progress" />
          <p className="mt-3 text-sm text-[var(--text-secondary)]">
            No season is live.
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Set a season active to start the clock on it. Until then every match
            and fee is filed against whichever season is flagged active.
          </p>
        </div>
      </Card>
    );
  }

  const { week, totalWeeks, elapsed } = seasonProgress(season);

  // "OF 17 · CLOSES 4 MAY", assembled from the parts that exist. A season with
  // no end date gets the second half and not the first, rather than "OF NULL".
  const noteParts = [
    totalWeeks ? `of ${totalWeeks}` : null,
    season.end_date ? `closes ${shortDate(season.end_date)}` : 'no closing date',
  ].filter(Boolean);

  return (
    <Card padding={false}>
      <div className="px-5 pt-5 pb-5">
        <PanelLabel label={`${season.name} · Progress`} />

        <div className="mt-4 flex items-end gap-3">
          <span className="font-mono text-[40px] leading-[0.9] font-bold tracking-tight text-[var(--text-primary)]">
            {week === null ? 'WK —' : `WK ${week}`}
          </span>
          <span className={`${PANEL_NOTE} pb-1`}>{noteParts.join(' · ')}</span>
        </div>

        {totalWeeks === null ? (
          <p className="mt-4 text-xs text-[var(--text-muted)]">
            No end date is set, so there is nothing to count down to. Closing the
            season stamps one.
          </p>
        ) : (
          <>
            <div className="mt-4 flex gap-[3px]" aria-hidden>
              {Array.from({ length: totalWeeks }, (_, i) => (
                <span
                  key={i}
                  className="h-[22px] flex-1"
                  style={{
                    background:
                      i < elapsed ? 'var(--color-accent)' : 'var(--bg-elevated)',
                  }}
                />
              ))}
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className={PANEL_NOTE}>Wk 1</span>
              <span className={PANEL_NOTE}>Wk {totalWeeks}</span>
            </div>
            <p className="sr-only">
              {week === null
                ? `${season.name} has not started.`
                : `Week ${week} of ${totalWeeks}.`}
            </p>
          </>
        )}

        {week === null && season.start_date && (
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Starts {shortDate(season.start_date)}.
          </p>
        )}
      </div>
    </Card>
  );
}
