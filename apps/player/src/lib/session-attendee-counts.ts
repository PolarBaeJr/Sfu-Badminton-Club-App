import { selectAllInChunks } from '@badminton/shared';

/**
 * How many people turned up, without the roster.
 *
 * FIX-LIST #12. `attendance_select` on `session_attendance` is `USING (TRUE)`
 * (00005_rls.sql:111) and `status`, `checked_in_at` and `marked_by` are all
 * granted, so any signed-in member could ask PostgREST for
 * /rest/v1/session_attendance?select=player_id,status and get the club's
 * itemised no-show and excused-absence history back as JSON. The database
 * already treats the AGGREGATE of exactly this as private — `rm_select_own`
 * limits `reliability_metrics` to your own row — and left the source rows open.
 *
 * The only cross-member read the members' app ever needed from that table is
 * the number on a session card. So the rows stop being readable (00153) and the
 * number comes from an aggregate instead: get_session_attendee_counts() is
 * SECURITY DEFINER, takes session ids and returns counts — no player_id, no
 * status, nothing about any individual.
 *
 * A second thing falls out of the shape. The direct read had to be chunked AND
 * paged, because production sets PGRST_DB_MAX_ROWS=1000 and 25 sessions of 40
 * members is exactly that; the aggregate returns one row per session, so the
 * cap is no longer anywhere near.
 *
 * THE FALLBACK IS TRANSITIONAL AND SAYS SO. Migrations here are applied by hand
 * by the club owner, so there is a window in which this code is deployed and
 * 00152 is not — and in that window an RPC-only implementation would print "0
 * going" on every card. It falls back to the old read, which still works
 * because 00153 (the policy narrowing) is applied after the deploy, and warns
 * once so the window is visible rather than silent. Once 00152 and 00153 are
 * both applied everywhere, the fallback is dead code and can be deleted — and
 * PRESENT below goes with it, since it exists only to mirror 00152's status
 * list for that one path. Until then the two are duplicated on purpose, and if
 * they ever disagree the symptom is a count that changes the day the migration
 * lands.
 */

/** The statuses that mean somebody was actually there. Mirrored in 00152. */
const PRESENT = ['checked_in', 'present'] as const;

let fallbackWarned = false;

interface CountRow {
  session_id: string;
  attendees: number;
}

// Structural, not the generated Supabase type: this module is handed the server
// client by its caller and only ever uses these two entry points, and typing it
// this way is what lets the tests drive it without a database.
export interface AttendanceReader {
  rpc(
    fn: 'get_session_attendee_counts',
    args: { p_session_ids: string[] },
  ): PromiseLike<{ data: CountRow[] | null; error: unknown }>;
  from(table: 'session_attendance'): {
    select(cols: string): {
      in(col: string, values: readonly string[]): {
        in(col: string, values: readonly string[]): {
          order(col: string): {
            range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
          };
        };
      };
    };
  };
}

export async function attendeeCountsBySession(
  supabase: AttendanceReader,
  sessionIds: readonly string[],
): Promise<Record<string, number>> {
  if (sessionIds.length === 0) return {};

  const { data, error } = await supabase.rpc('get_session_attendee_counts', {
    p_session_ids: [...sessionIds],
  });

  if (!error && data) {
    const counts: Record<string, number> = {};
    for (const row of data) counts[row.session_id] = Number(row.attendees) || 0;
    return counts;
  }

  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn(
      '[sessions] get_session_attendee_counts is unavailable, falling back to reading ' +
      'session_attendance rows directly. Apply migration 00152 — until then these ' +
      'counts are subject to PGRST_DB_MAX_ROWS. Reported once per process.',
    );
  }

  const { data: rows } = await selectAllInChunks<{ session_id: string }>(
    sessionIds,
    (batch, from, to) =>
      supabase
        .from('session_attendance')
        .select('session_id')
        .in('session_id', batch)
        .in('status', PRESENT)
        // A range request over an unordered result is not a stable window:
        // without this two pages can overlap or skip and the tally is wrong in a
        // way no small fixture would show.
        .order('session_id')
        .range(from, to) as never,
  );

  const counts: Record<string, number> = {};
  for (const row of rows ?? []) {
    counts[row.session_id] = (counts[row.session_id] ?? 0) + 1;
  }
  return counts;
}

/** Test seam: the warning is once per process, which outlives a test file. */
export function __resetAttendeeCountWarning(): void {
  fallbackWarned = false;
}
