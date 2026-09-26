import type { WeekStripDay } from '@/lib/calendar-items';

/**
 * The next seven days as one row, for a phone, where the month grid would be
 * a 620px sideways scroll about 500px tall. The marks are a glance only: the
 * agenda cards directly under the strip name everything, and each day carries
 * the same content in words for a screen reader. A day with something on it
 * jumps to that day in the agenda.
 */
export function WeekStrip({ days, linkedDates }: { days: WeekStripDay[]; linkedDates: ReadonlySet<string> }) {
  return (
    <div className="week-strip" role="list" aria-label="The next seven days">
      {days.map((day) => {
        const cls = [
          'week-day',
          day.count > 0 ? 'has-items' : '',
          day.isToday ? 'is-today' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const body = (
          <>
            <span className="week-dow" aria-hidden="true">{day.weekday}</span>
            <span className="week-num" aria-hidden="true">{day.day}</span>
            <span className="week-marks" aria-hidden="true">
              {day.marks.map((tone, i) => (
                <span key={i} className={`week-mark is-${tone}`} />
              ))}
              {day.more > 0 && <span className="week-more">+{day.more}</span>}
            </span>
            <span className="sr-only">
              {day.isToday ? 'Today, ' : ''}
              {day.summary}
            </span>
          </>
        );
        return (
          <div key={day.dateISO} role="listitem" className="week-cell">
            {linkedDates.has(day.dateISO) ? (
              <a href={`#day-${day.dateISO}`} className={`${cls} press`}>
                {body}
              </a>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
