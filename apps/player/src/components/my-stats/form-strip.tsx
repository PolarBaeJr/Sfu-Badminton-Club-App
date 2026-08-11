'use client';

import { deriveForm } from '@/lib/stats-charts';

export interface FormStripProps {
  /** `win_flag` for the player's recent matches, oldest first. */
  winFlags: (boolean | null)[];
  label: string;
  limit?: number;
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
export function FormStrip({ winFlags, label, limit = 10 }: FormStripProps) {
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
            className="mono"
            style={{
              // Fixed width rather than flex: ten cells at 22px fit inside a
              // 390px card with room to spare, and a strip that stretches to
              // the card makes three results look like a full season.
              width: 22,
              height: 26,
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              fontWeight: 600,
              color: '#fff',
              background: r === 'W' ? 'var(--win)' : 'var(--loss)',
            }}
          >
            {r}
          </span>
        ))}
      </div>
      {/* The figure beside the shape: ten coloured squares are a picture until
          the record is written next to them. */}
      <div className="mono muted" style={{ fontSize: 11, marginTop: 8 }}>
        <span style={{ color: 'var(--win)', fontWeight: 600 }}>{form.wins}W</span>
        <span style={{ margin: '0 3px' }}>–</span>
        <span style={{ color: 'var(--loss)', fontWeight: 600 }}>{form.losses}L</span>
        <span> in the last {form.results.length}</span>
        {streakText && <span> · {streakText}</span>}
      </div>
    </div>
  );
}
