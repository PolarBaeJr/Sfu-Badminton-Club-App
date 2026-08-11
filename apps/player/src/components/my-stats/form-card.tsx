import { deriveForm } from '@/lib/stats-charts';
import { FormStrip } from './form-strip';

const WINDOW = 10;

export interface FormCardProps {
  /**
   * `win_flag` for every confirmed match, oldest first and across BOTH
   * disciplines — see buildOverallFormFlags for why this card is not split the
   * way the rating line is.
   */
  winFlags: (boolean | null)[];
}

/**
 * Recent form as a card of its own, for the side rail.
 *
 * The headline is the record, not the streak: `6–4` is the answer to "how am I
 * doing", and the streak is the qualifier that goes beside it. Both come out of
 * the same `deriveForm` call the strip below makes, so the number written here
 * and the cells drawn there can never disagree about which ten matches they
 * are describing.
 */
export function FormCard({ winFlags }: FormCardProps) {
  const form = deriveForm(winFlags, WINDOW);

  return (
    <div className="card-base">
      <div className="card-head">
        <h3 className="card-title">Recent form</h3>
        {form.results.length > 0 && (
          <span className="tag">LAST {form.results.length}</span>
        )}
      </div>

      {form.results.length === 0 ? (
        // An empty axis says nothing; this says what to do about it. The card
        // still renders — a rail that appears only once a member has played is
        // a rail that is missing on exactly the account that looks emptiest.
        <div className="empty" style={{ padding: '28px 20px' }}>
          <div className="empty-title">No results yet</div>
          <div className="empty-hint">
            Play a match and confirm the result — your last ten land here, newest on
            the right.
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 12, alignItems: 'baseline', marginBottom: 16 }}>
            <div className="mono me-form-figure">
              {form.wins}–{form.losses}
            </div>
            <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.16em' }}>
              LAST {form.results.length}
              {form.streak !== 0 && (
                <>
                  {' · '}
                  <span style={{ color: form.streak > 0 ? 'var(--win)' : 'var(--loss)', fontWeight: 600 }}>
                    {form.streak > 0 ? 'W' : 'L'}
                    {Math.abs(form.streak)} STREAK
                  </span>
                </>
              )}
            </div>
          </div>

          {/* The record is the headline above, so the strip does not repeat it. */}
          <FormStrip winFlags={winFlags} label="recent" limit={WINDOW} showSummary={false} showAxis />
        </>
      )}
    </div>
  );
}
