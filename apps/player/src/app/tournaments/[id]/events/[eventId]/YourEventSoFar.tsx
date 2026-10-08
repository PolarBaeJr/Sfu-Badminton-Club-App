import type { EventRecord } from '@badminton/shared';

/**
 * "YOUR EVENT SO FAR", at the top of Your Matches: the last result and the
 * running record, so a member between rounds does not have to add up the rows
 * below to know where they stand.
 *
 * Counted by the shared eventRecordFor, the same rule the desk's after-score
 * summary uses, so the member and the console read the same record.
 *
 * THE POINTS HERE ARE RALLY POINTS. Tournament points and placings are only
 * written when the event is finalised, so a total of those mid-event would be a
 * zero that reads as a verdict.
 */
export function YourEventSoFar({
  record,
  opponentName,
  doubles,
  rating,
}: {
  record: EventRecord;
  opponentName: string;
  doubles: boolean;
  /** Singles only, from eventRatingLine. Null when there is nothing to show. */
  rating: { before: number | null; after: number | null; delta: number } | null;
}) {
  const last = record.last;
  const lastScores = last?.scores.map((g) => `${g.mine}–${g.theirs}`).join(', ') ?? '';
  const up = (rating?.delta ?? 0) > 0;
  const down = (rating?.delta ?? 0) < 0;

  return (
    <div className="p-3 border border-[var(--border)] bg-white/[0.02] space-y-1.5">
      <p className="eyebrow">Your event so far</p>
      {last && (
        <p className="text-sm text-[var(--text-primary)]">
          <span className="text-[var(--text-muted)]">Last match: </span>
          <span className={`font-semibold ${last.won ? 'text-[var(--color-success)]' : 'text-[var(--color-accent)]'}`}>
            {last.won ? 'Won' : 'Lost'}
          </span>
          {' '}vs {opponentName}
          {lastScores ? <span className="nums">, {lastScores}</span> : ' by walkover'}
          <span className="text-[var(--text-muted)]"> ({last.roundName})</span>
        </p>
      )}
      <p className="text-sm text-[var(--text-primary)]">
        <span className="text-[var(--text-muted)]">In this event: </span>
        <span className="nums">
          {record.won}–{record.lost}, games {record.gamesWon}–{record.gamesLost}, points {record.pointsFor}–{record.pointsAgainst}
        </span>
      </p>
      {!doubles && rating && (
        <p className="text-sm text-[var(--text-primary)]">
          <span className="text-[var(--text-muted)]">Rating: </span>
          <span className="nums">
            {rating.before != null && rating.after != null && <>{rating.before} &rarr; {rating.after} </>}
            <span className={up ? 'text-[var(--color-success)]' : down ? 'text-[var(--color-accent)]' : 'text-[var(--text-muted)]'}>
              <span className="sr-only">{up ? 'gained' : down ? 'lost' : 'no change'} </span>
              ({up ? '+' : ''}{rating.delta})
            </span>
          </span>
        </p>
      )}
      {doubles && (
        <p className="text-xs text-[var(--text-muted)]">
          Rating is not tracked per pair: a doubles result moves each player&rsquo;s own doubles rating, so there is no rating line here.
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Points here are rally points. Tournament points are written when the event is finalised.
      </p>
    </div>
  );
}
