import { MapPin, FileText, Users, UserCheck } from 'lucide-react';
import { formatTime } from '@badminton/shared';
import type { AttendanceStatus, SessionIntent } from '@badminton/shared';
import { CheckInButton } from './check-in-button';
import { AddToCalendarButton } from './add-to-calendar';
import { RsvpButtons } from './rsvp-buttons';
import { describeMyState, isAttendanceRecorded } from '@/lib/schedule';

export interface SessionCardSession {
  id: string;
  name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string;
  notes: string | null;
  track: string;
}

interface SessionCardProps {
  session: SessionCardSession;
  myStatus: AttendanceStatus | null;
  myIntent: SessionIntent | null;
  checkedInCount: number;
  goingCount: number;
  canCheckIn: boolean;
  /** "Opens at 6:00 PM" / "Check-in closed" — already resolved on the server. */
  windowLabel?: string;
  /** The soonest open session gets the accent spine. */
  isNext: boolean;
  /** False when the member is suspended, banned or owes a signature. */
  standingOk: boolean;
}

/**
 * One open session. A server component on purpose: every date and time on it
 * is formatted once, here, and the interactive parts (check in, RSVP, add to
 * calendar) stay the same client components they were — a card that re-derived
 * "today" in the browser could disagree with the day heading above it.
 */
export function SessionCard({
  session,
  myStatus,
  myIntent,
  checkedInCount,
  goingCount,
  canCheckIn,
  windowLabel,
  isNext,
  standingOk,
}: SessionCardProps) {
  const attendanceRecorded = isAttendanceRecorded(myStatus);
  const state = describeMyState(myStatus, myIntent);

  // CheckInButton returns null before it ever reaches its own `windowLabel`
  // branch, so the reason a button is missing has to be said out here. It only
  // helps where the clock is the reason: when the member declined, is already
  // on the attendance list, or had the control withheld for their standing, the
  // explanation is elsewhere on the card and a time here would just be noise.
  const showWindowLabel =
    Boolean(windowLabel) && !attendanceRecorded && !canCheckIn && myIntent !== 'declined' && standingOk;

  return (
    <article
      // Calendar entries deep-link to /sessions?s=<id>, and deep-link-scroll.tsx
      // finds the card by this exact id. It must not change shape.
      id={`session-${session.id}`}
      className={`session-card${isNext ? ' is-next' : ''}`}
    >
      <div className="session-grid">
        <div style={{ minWidth: 0 }}>
          {isNext && <div className="sess-eyebrow">Next up</div>}

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="card-title card-title-lg" style={{ margin: 0 }}>
              {session.name ?? 'Practice Session'}
            </div>
            {/* Sessions are already filtered to this member's track, so the tag
                is here to say "this one is aimed at your stream", not to warn
                anyone off. 'all' nights need no label. */}
            {session.track !== 'all' && (
              <span className="tag tag-outline">{session.track.toUpperCase()}</span>
            )}
          </div>

          {session.start_time ? (
            <div className="sess-time">
              {formatTime(session.start_time)}
              {session.end_time && <span className="to"> – {formatTime(session.end_time)}</span>}
            </div>
          ) : (
            <div className="sess-time to">Time TBC</div>
          )}

          <div className="session-meta" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 6 }}>
              <MapPin size={14} /> <span>{session.location}</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <UserCheck size={14} /> <span className="mono">{goingCount} going</span>
            </span>
            {/* Nobody has checked in to next Tuesday's practice, and "0 checked
                in" on every future card is dead weight — the number only earns
                its place once someone is actually in the hall. */}
            {checkedInCount > 0 && (
              <span className="row" style={{ gap: 6 }}>
                <Users size={14} /> <span className="mono">{checkedInCount} checked in</span>
              </span>
            )}
          </div>

          {session.notes && (
            <div
              className="row"
              style={{ gap: 6, fontSize: 13, color: 'var(--ink-2)', marginTop: 10, alignItems: 'flex-start' }}
            >
              <FileText size={14} className="text-[var(--mute)]" style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{session.notes}</span>
            </div>
          )}
        </div>

        {/* Check-in stays first and unwrapped: this is what someone taps at the
            door with a queue behind them, and it must not move further from
            their thumb than it was. */}
        <div className="sess-actions">
          <CheckInButton
            sessionId={session.id}
            myStatus={myStatus}
            canCheckIn={canCheckIn}
            windowLabel={windowLabel}
            myIntent={myIntent}
          />
          {showWindowLabel && <span className="sess-window">{windowLabel}</span>}
          {/* Once attendance is on the record the RSVP is moot — showing both
              would let the card say "Checked In" and "Not going" at once. */}
          {!attendanceRecorded && <RsvpButtons sessionId={session.id} myIntent={myIntent} />}
          <AddToCalendarButton
            name={session.name ?? 'Practice Session'}
            date={session.date}
            start_time={session.start_time}
            end_time={session.end_time}
            location={session.location}
            notes={session.notes}
          />
        </div>
      </div>
    </article>
  );
}
