import React from 'react';
import { AvatarChip, Atomic, Badge } from '@badminton/ui';

/**
 * The right-hand column of /sessions: what is happening at the door right now.
 *
 * Both server components. The door feed carries what a member owes, and money
 * is a separate capability from the schedule — page.tsx skips that FETCH when
 * the viewer does not hold `fees.clubfees.read`, and `showFees` here only
 * decides whether the column exists at all. Nothing on this file can leak a
 * figure page.tsx did not read.
 *
 * WHAT THE MOCKUP ASKED FOR AND THE DATABASE CANNOT ANSWER: a 12-block meter
 * reading "30 OF 36 · EACH BLOCK = 3 MEMBERS". `sessions` has no capacity
 * column (00001_schema.sql:251), so there is no 36 and no share of it. The
 * count stands on its own and the footer says why there is no total, rather
 * than the page implying one it made up.
 */

const LABEL = 'font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]';

export function TonightCheckin({
  heading,
  sessionName,
  checkedIn,
  signedUp,
  doorLine,
}: {
  /** "Tonight · Check-in", or "Today · Check-in" when the club is playing at a
   *  time nobody would call tonight. The schema permits a Saturday morning
   *  session and this card is the one an officer reads at the door. */
  heading: string;
  /** Null when the club is not playing today. */
  sessionName: string | null;
  checkedIn: number;
  signedUp: number;
  /** The check-in window in words — "DOORS CLOSE IN 42 MIN". Null when the
   *  session has no start time to compute one from. */
  doorLine: string | null;
}) {
  return (
    <div>
      <div className="px-4 pt-4 pb-3">
        <span className={LABEL}>{heading}</span>
      </div>

      {sessionName === null ? (
        // "Nothing on today" is a real state, not an error and not a blank.
        <div className="px-4 pb-4">
          <p className="text-sm text-[var(--text-secondary)]">No session today.</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            The door feed below wakes up when a session on today&apos;s date has someone checked in.
          </p>
        </div>
      ) : (
        <>
          <div className="px-4 pb-4 flex items-baseline gap-3 flex-wrap">
            <Atomic className="font-mono text-[40px] leading-none tracking-[-0.03em] text-[var(--text-primary)]">
              {checkedIn}
            </Atomic>
            <span className={LABEL}>
              {/* Signed up rather than a capacity: this is the number the count
                  is actually chasing, and unlike a capacity it exists. */}
              <Atomic>{signedUp} signed up</Atomic>
              {doorLine && <> · <Atomic>{doorLine}</Atomic></>}
            </span>
          </div>
          <div className="px-4 pb-4">
            <p className="text-sm text-[var(--text-secondary)]">{sessionName}</p>
          </div>
        </>
      )}

      <div className="border-t border-[var(--border)] px-4 py-2.5">
        <span className={LABEL}>Checked in so far · no capacity is recorded</span>
      </div>
    </div>
  );
}

export interface DoorFeedEntry {
  playerId: string;
  name: string;
  avatarUrl: string | null;
  /** Club-local wall clock, e.g. "19:02". */
  timeLabel: string;
  /** status 'checked_in' is a self-scan (00008); anything else was marked by an
   *  officer at the door. */
  viaQr: boolean;
  /** Null when this member is not on the fee roster at all — an exec, a
   *  fee-exempt member, or somebody with no status that pays. Distinct from
   *  "withheld", which is `showFees === false`.
   *
   *  `amount` is absent when the season carries no price for that member's
   *  status. Still outstanding, just said without a figure rather than with an
   *  invented one. */
  fee: { state: 'paid' | 'waived' | 'owes'; amount?: string } | null;
}

function FeeBadge({ fee }: { fee: NonNullable<DoorFeedEntry['fee']> }) {
  if (fee.state === 'paid') return <Badge variant="success">Paid</Badge>;
  if (fee.state === 'waived') return <Badge variant="neutral">Waived</Badge>;
  return <Badge variant="warning">{fee.amount ? `Owes ${fee.amount}` : 'Unpaid'}</Badge>;
}

export function DoorFeed({
  entries,
  showFees,
}: {
  entries: DoorFeedEntry[];
  /** `fees.clubfees.read`. When false the badge column is not rendered at all —
   *  a per-row pill cannot carry "withheld from you", and a row of blanks reads
   *  as broken. The card's sub-line says it instead. */
  showFees: boolean;
}) {
  return (
    <div>
      <div className="px-4 pt-4 pb-3 flex items-baseline justify-between gap-3">
        <span className={LABEL}>Just scanned in</span>
        <span className={LABEL}>{showFees ? 'Newest first' : 'Fees not shown to you'}</span>
      </div>

      {entries.length === 0 ? (
        <div className="px-4 pb-4">
          <p className="text-sm text-[var(--text-secondary)]">Nobody has checked in yet.</p>
        </div>
      ) : (
        <ul className="border-t border-[var(--border)]">
          {entries.map((e) => (
            <li
              key={e.playerId}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] last:border-b-0"
            >
              <AvatarChip name={e.name} id={e.playerId} src={e.avatarUrl} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--text-primary)] truncate">{e.name}</p>
                <Atomic className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  {e.timeLabel} · {e.viaQr ? 'QR' : 'Manual'}
                </Atomic>
              </div>
              {showFees && e.fee && <FeeBadge fee={e.fee} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
