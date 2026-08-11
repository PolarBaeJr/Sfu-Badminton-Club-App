import React from 'react';
import { AvatarChip, Atomic, ResponsiveTable, TableCard } from '@badminton/ui';
import { splitFullName } from '@badminton/shared';

/**
 * The two session tables on /sessions — upcoming, and the term's archive.
 *
 * One component for both because they are the same five columns with the same
 * row actions; the only difference is which sessions are in the array and what
 * the heading says. Two copies of this markup is how the console's tables came
 * to disagree about their own type sizes.
 *
 * A SERVER COMPONENT. Every row action arrives already built as a `ReactNode`
 * from page.tsx, which is where the capability tests live — so this file
 * decides nothing about who may do what, and cannot accidentally start to.
 *
 * ResponsiveTable, always. Below `md` the table is replaced by one TableCard
 * per row: this is the screen an officer works from a phone at the gym door,
 * and it is the strongest case in the console for the card form. A wide table
 * in an overflow box would put VENUE and ACTION off the right edge of the one
 * screen that must never lose them.
 */

/** WHAT THIS PAGE KNOWS ABOUT A SESSION. Note what is not here: no capacity,
 *  no denominator, no court count. `sessions` has none of those columns — see
 *  the note on the stat strip in page.tsx. */
export interface SessionRow {
  id: string;
  name: string;
  /** Relative day where it helps ("TONIGHT"), absolute otherwise. */
  dayLabel: string;
  /** Absolute wall-clock, always, even when the day is relative. */
  timeLabel: string;
  venue: string;
  /** session_rsvp intent = 'going'. NOT attendance, and not a capacity share. */
  signedUp: number;
  /** session_attendance rows. Counted separately: RSVPs and turnout are two
   *  different facts and the club's whole no-show problem lives in the gap. */
  checkedIn: number;
  /** sessions.host_player_id — the officer who created the night. There is no
   *  column for "who is on the door", so this is labelled HOST rather than
   *  DOOR; see page.tsx. */
  host: { id: string; name: string; avatarUrl: string | null } | null;
  closed: boolean;
  actions: React.ReactNode;
}

const TH =
  'px-4 py-2.5 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--text-muted)] font-normal';
const TD = 'px-4 py-3 align-middle';

/** "Aiko Tanaka" -> "A. TANAKA". A mononym stays whole. The door column is
 *  mono and narrow, and a full name at 12px mono wraps in it. */
function abbreviate(full: string): string {
  const { first_name, last_name } = splitFullName(full);
  if (!last_name) return first_name.toUpperCase();
  return `${first_name.charAt(0).toUpperCase()}. ${last_name.toUpperCase()}`;
}

function HostCell({ host }: { host: SessionRow['host'] }) {
  // Two different facts, drawn differently on purpose: a session with nobody
  // recorded against it is a gap somebody has to close, so it is warning-toned
  // rather than just blank.
  if (!host) {
    return (
      <span className="font-mono text-xs uppercase tracking-[0.1em] text-[var(--color-warning)]">
        Unassigned
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <AvatarChip name={host.name} id={host.id} src={host.avatarUrl} size="xs" />
      <Atomic className="font-mono text-xs text-[var(--text-secondary)]">
        {abbreviate(host.name)}
      </Atomic>
    </span>
  );
}

/** Signed up beside turned up. No denominator: `sessions` has no capacity
 *  column, so there is no honest total to divide by. */
function TurnoutCell({ signedUp, checkedIn }: { signedUp: number; checkedIn: number }) {
  return (
    <span className="inline-flex flex-col gap-0.5">
      <Atomic className="font-mono text-[13px] text-[var(--text-primary)]">
        {signedUp} going
      </Atomic>
      {checkedIn > 0 && (
        <Atomic className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
          {checkedIn} checked in
        </Atomic>
      )}
    </span>
  );
}

export function SessionTable({
  rows,
  heading,
  count,
}: {
  rows: SessionRow[];
  /** Left label of the card's header row. */
  heading: string;
  /** Right label — what the reader is looking at, in the reader's words. */
  count: string;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)]">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
          {heading}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {count}
        </span>
      </div>

      <ResponsiveTable
        cards={rows.map((row) => (
          <TableCard
            key={row.id}
            title={
              <span className="flex items-baseline gap-2 flex-wrap">
                <span>{row.name}</span>
                {row.closed && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    Closed
                  </span>
                )}
              </span>
            }
            value={
              <Atomic className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                {row.dayLabel} · {row.timeLabel}
              </Atomic>
            }
            fields={[
              { label: 'Venue', value: row.venue },
              {
                label: 'Signed up',
                value: <TurnoutCell signedUp={row.signedUp} checkedIn={row.checkedIn} />,
              },
              { label: 'Host', value: <HostCell host={row.host} /> },
            ]}
            actions={
              // Row actions are already 44px each; this only stops them from
              // sitting shoulder to shoulder with no gap on a narrow phone.
              <div className="flex flex-wrap items-center gap-2">{row.actions}</div>
            }
          />
        ))}
      >
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className={TH}>Session</th>
              <th className={TH}>Venue</th>
              <th className={TH}>Signed up</th>
              <th className={TH}>Host</th>
              <th className={`${TH} text-right`}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-[var(--border)]">
                <td className={TD}>
                  <div className="text-sm text-[var(--text-primary)]">
                    {row.name}
                    {row.closed && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                        Closed
                      </span>
                    )}
                  </div>
                  <Atomic className="block mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    {row.dayLabel} · {row.timeLabel}
                  </Atomic>
                </td>
                <td className={`${TD} text-sm text-[var(--text-secondary)]`}>{row.venue}</td>
                <td className={TD}>
                  <TurnoutCell signedUp={row.signedUp} checkedIn={row.checkedIn} />
                </td>
                <td className={TD}>
                  <HostCell host={row.host} />
                </td>
                <td className={`${TD} text-right`}>
                  <div className="inline-flex items-center justify-end gap-2">{row.actions}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </>
  );
}
