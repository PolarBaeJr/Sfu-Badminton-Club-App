'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

/**
 * WATCHING THE DOOR.
 *
 * /sessions is server-rendered and `revalidatePath('/sessions')` on every
 * attendance mutation keeps it honest — but only for the exec who made the
 * write. The case this file exists for is the other one: an officer with the
 * door list open on a laptop while members scan themselves in from their
 * phones, where nothing on this machine has written anything and the page
 * would sit on its first render all night.
 *
 * NUDGE, DO NOT MERGE. The callback calls router.refresh() rather than pushing
 * the payload into local state. Three reasons, in order of how much they
 * matter:
 *
 *   1. CAPABILITY. The socket payload is whatever RLS lets through, and RLS on
 *      session_attendance is `USING (TRUE)` — every signed-in member can read
 *      every row. What the console SHOWS is much narrower: fee badges need
 *      `fees.clubfees.read`, the walk-in roster needs
 *      `sessions.attendance.write`. Re-running the server component re-derives
 *      all of that from the viewer's own credentials, so a live update cannot
 *      surface something a static render would have withheld. Hand-merging
 *      rows would put that decision on the client, where it does not belong.
 *
 *   2. DERIVED NUMBERS. One check-in moves the door list, the door feed, the
 *      "checked in today" stat, each row's checked-in count and the turnout
 *      panel. They are all folded out of one attendance read in page.tsx; a
 *      refresh re-derives every one of them from that single source instead of
 *      leaving five copies to drift apart.
 *
 *   3. NAMES. The row carries ids and timestamps and no name at all — the name
 *      comes from a `players` join the server does. There is nothing to merge.
 *
 * *** INERT UNTIL THE PUBLICATION SAYS SO. *** session_attendance is not a
 * member of `supabase_realtime` until 00112 is applied, and a subscription to
 * an unpublished table SUCCEEDS and then never fires — .subscribe() resolves,
 * the callback never runs, nothing errors. That is the exact silent failure
 * 00036 was written to fix. Until the owner runs 00112 these listeners do
 * nothing whatsoever and both surfaces behave as they did before.
 *
 * THE OTHER WAY THIS CAN GO QUIET, which no test can see: page.tsx reads
 * attendance with createAdminClient() (service role, RLS bypassed) while this
 * subscribes with the browser anon client, which is subject to
 * `attendance_select TO authenticated`. So the render needs no Supabase
 * session and the socket does. It has one: requireCapability() authenticates
 * through supabase.auth.getUser() on the shared auth cookie, and
 * supabase-browser.ts is built with the same AUTH_COOKIE_OPTIONS, so the
 * browser client resolves the same GoTrue session the server just checked.
 */

/** Long enough that a queue of five people scanning at once is one re-render,
 *  short enough that an officer watching the screen reads it as immediate.
 *  Deliberately far below the leaderboard's 2.5s: standings settling a couple
 *  of seconds late is invisible, a door list is being watched. */
const COALESCE_MS = 400;

export function useLiveAttendance({
  channel: channelName,
  sessionIds,
  enabled = true,
}: {
  /** UNIQUE PER MOUNT-SITE. The dialog is rendered once per session row and
   *  the feed is always mounted, so a fixed name (the player app's habit)
   *  would have several live subscribers fighting over one topic. */
  channel: string;
  /** Which sessions this surface is actually showing. */
  sessionIds: string[];
  /** False parks the whole thing — no client, no channel. The dialog passes
   *  its open state, so a door list opened and closed twenty times across a
   *  club night leaves nothing behind. */
  enabled?: boolean;
}) {
  const router = useRouter();

  // THE DEPENDENCY IS THE JOINED KEY, NOT THE ARRAY. `sessionIds` is built by
  // a .map() in the server component, so it is a new array identity on every
  // render — depending on it directly would tear the channel down and open a
  // fresh one each time React re-rendered, which is how twenty channels
  // happen without anybody forgetting a cleanup.
  const key = sessionIds.join(',');

  useEffect(() => {
    if (!enabled || key === '') return;

    const supabase = createClient();
    const channel = supabase.channel(channelName);
    let timer: ReturnType<typeof setTimeout> | undefined;

    // ONE LISTENER PER SESSION. postgres_changes takes a single filter
    // expression, so several sessions means several .on() calls — on one
    // channel, which is one socket. The filter is what keeps an exec with
    // Tuesday's door list open from being woken by Thursday's traffic, and
    // it is about noise rather than exposure: RLS already decides what the
    // subscriber may see, and here it lets every signed-in member see
    // everything.
    for (const sessionId of key.split(',')) {
      channel.on(
        'postgres_changes',
        {
          // Not just INSERT. A walk-in marked present, a no-show corrected and
          // a mistaken check-in removed all move the numbers this page prints,
          // and all three reach the door list of an exec who did not make
          // them.
          event: '*',
          schema: 'public',
          table: 'session_attendance',
          filter: `session_id=eq.${sessionId}`,
        },
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => router.refresh(), COALESCE_MS);
        },
      );
    }

    channel.subscribe();

    return () => {
      // The timer as well as the channel: a refresh queued a moment before the
      // dialog closed would otherwise fire against an unmounted tree.
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [channelName, key, enabled, router]);
}

/**
 * The door feed's subscriber. Renders nothing — the feed itself stays a server
 * component, because everything it shows (names, fee badges, the QR/manual
 * split) is decided server-side and there is no reason to ship any of that
 * shaping to the browser.
 */
export function LiveAttendance({ sessionIds }: { sessionIds: string[] }) {
  // No session today means no door to watch: `sessionIds` is empty and the
  // hook opens no channel at all.
  useLiveAttendance({ channel: 'sessions-door-feed', sessionIds });
  return null;
}
