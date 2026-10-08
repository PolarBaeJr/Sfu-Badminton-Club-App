import type { AttendanceSummary, SessionCadence } from '@/lib/stats-charts';

export interface AttendanceGridProps {
  summary: AttendanceSummary;
  /** Named so the empty state can say which season had no sessions. */
  seasonName: string | null;
  /**
   * The club's timetable, when it has one. Null is the normal case for a term
   * that has only run twice or whose nights move — `deriveSessionCadence`
   * refuses to average a schedule into existence, and the footer is simply
   * omitted rather than printed as a guess.
   */
  cadence?: SessionCadence | null;
}

/**
 * One cell per session the member was eligible for this season, oldest first,
 * filled when they were there.
 *
 * HTML boxes rather than SVG: the grid is a wrapping run of identical squares,
 * which is what CSS flex-wrap already is, and doing it in SVG would mean
 * computing the wrap by hand for every card width. The absences are the point —
 * they are drawn as outlined cells rather than omitted, because a grid of only
 * the sessions somebody attended is a chart that always reads 100%.
 */
export function AttendanceGrid({ summary, seasonName, cadence = null }: AttendanceGridProps) {
  if (summary.total === 0) {
    return (
      <div className="empty" style={{ padding: '28px 20px' }}>
        <div className="empty-title">No sessions yet</div>
        <div className="empty-hint">
          No sessions have been held{seasonName ? ` in ${seasonName}` : ''} that you could
          attend. Your grid fills in one square per session, filled when you were there.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* The number first, then what it counts. The streak is the figure a
          member is actually keeping track of; the record beside it is what
          stops the streak reading as the whole story. */}
      <div className="row" style={{ gap: 12, alignItems: 'baseline', marginBottom: 16 }}>
        <div className="mono me-form-figure" style={{ color: summary.currentStreak > 0 ? 'var(--red)' : undefined }}>
          {summary.currentStreak}
        </div>
        <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.16em' }}>
          SESSION STREAK · {summary.attended} OF {summary.total} TURNED UP
        </div>
      </div>

      <div className="row" style={{ gap: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {summary.cells.map((cell) => (
          <span
            key={cell.sessionId}
            title={`${formatCellDate(cell.date)} — ${cell.attended ? 'attended' : 'missed'}`}
            style={{
              width: 14,
              height: 14,
              flex: '0 0 auto',
              // The member's own attendance is --red, the club's accent; an
              // absence is the same square left as the page's own surface with
              // a hairline, so the grid reads as a record rather than as a
              // scoreboard of good and bad days.
              background: cell.attended ? 'var(--red)' : 'transparent',
              border: cell.attended ? '1px solid var(--red)' : '1px solid var(--line-2)',
            }}
          />
        ))}
      </div>

      <div
        className="row"
        style={{ gap: 0, marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}
      >
        <Figure label="RATE" value={`${summary.ratePct}%`} />
        <Figure label="BEST STREAK" value={String(summary.bestStreak)} />
        <Figure label="SESSIONS" value={String(summary.total)} />
      </div>

      {cadence && (
        <div
          className="mono muted"
          style={{ fontSize: 10, letterSpacing: '.08em', marginTop: 12 }}
        >
          {cadence.perWeek} {cadence.perWeek === 1 ? 'SESSION' : 'SESSIONS'} A WEEK ·{' '}
          {cadence.weekdays.join(' / ')}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ flex: '1 1 25%', minWidth: 68 }}>
      <div className="stat-label" style={{ fontSize: 10 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: tone ?? 'var(--ink)' }}>
        {value}
      </div>
    </div>
  );
}

/**
 * `sessions.date` is a DATE, not a timestamp. `new Date('2026-01-08')` parses
 * that as UTC midnight and then renders it in the reader's zone, which west of
 * Greenwich is the previous evening — every square in the tooltip would be
 * dated a day early. Splitting the string keeps the day the club actually
 * wrote.
 */
function formatCellDate(date: string): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
