'use client';

import { deriveForm } from '@/lib/stats-charts';

export interface FormStripProps {
  /** `win_flag` for the player's recent matches, oldest first. */
  winFlags: (boolean | null)[];
  label: string;
  limit?: number;
  /**
   * The `6W–4L in the last 10` line under the cells. Off when the caller has
   * already printed the record as its own figure — see FormCard, where it is
   * the headline and repeating it below the strip says the same thing twice.
   */
  showSummary?: boolean;
  /** Oldest/latest captions under the run. Only worth the room in a card of its own. */
  showAxis?: boolean;
}

/**
 * Recent form: one cell per decided match, oldest on the left.
 *
 * Cells rather than a line because form is categorical — there is no value
 * between a win and a loss to interpolate, and a sparkline of 1s and 0s draws a
 * shape that invites reading a trend into six results. `--win` and `--loss`
 * carry the whole meaning, which is the one place on this page those two tokens
 * belong: these are actual results.
 */
export function FormStrip({
  winFlags,
  label,
  limit = 10,
  showSummary = true,
  showAxis = false,
}: FormStripProps) {
  const form = deriveForm(winFlags, limit);

  if (form.results.length === 0) {
    return (
      <div className="mono muted" style={{ fontSize: 12 }}>
        No decided {label.toLowerCase()} results yet — your form strip fills in as
        matches are confirmed.
      </div>
    );
  }

  const streakText =
    form.streak > 0
      ? `W${form.streak} run`
      : form.streak < 0
        ? `L${Math.abs(form.streak)} run`
        : '';

  return (
    <div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {form.results.map((r, i) => (
          <span
            key={i}
            title={r === 'W' ? 'Win' : 'Loss'}
            // Sized by CSS, not inline: fixed cells rather than equal-flex ones,
            // because a strip that stretches to the card makes three results
            // look like a full season — and that argument holds harder in a
            // wide rail than it does on a phone. .me-form-cell only grows the
            // cell a little on a big screen, it never fills the card.
            className="mono me-form-cell"
            data-result={r}
          >
            {r}
          </span>
        ))}
      </div>
      {showAxis && (
        <div
          className="row mono muted"
          style={{ justifyContent: 'space-between', fontSize: 9, letterSpacing: '.16em', marginTop: 6 }}
        >
          <span>OLDEST</span>
          <span>LATEST</span>
        </div>
      )}
      {/* The figure beside the shape: ten coloured squares are a picture until
          the record is written next to them. */}
      {showSummary && (
        <div className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>
          <span style={{ color: 'var(--win)', fontWeight: 600 }}>{form.wins}W</span>
          <span style={{ margin: '0 3px' }}>–</span>
          <span style={{ color: 'var(--loss)', fontWeight: 600 }}>{form.losses}L</span>
          <span> in the last {form.results.length}</span>
          {streakText && <span> · {streakText}</span>}
        </div>
      )}
    </div>
  );
}
