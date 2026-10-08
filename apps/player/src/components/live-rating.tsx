'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveChannel } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';

/**
 * YOUR OWN RATING, WITHOUT A RELOAD.
 *
 * /my-stats and /feed both print the member's own ELO, record, streak and
 * provisional flag, and both read them off the single `ratings` row that
 * getCurrentPlayer() already loads. Neither page subscribed to anything, so the
 * number a member stares at right after their match was confirmed stayed at its
 * pre-match value until they pulled to refresh — and the one moment somebody
 * genuinely watches that figure is the moment it is most likely to be stale.
 *
 * The write does not come from this browser. `revalidatePath` on the confirm
 * path covers the exec (or the opponent) who entered the result; the member
 * whose rating moved is on another phone, and nothing on that phone has written
 * anything.
 *
 * ONE ROW, THEIRS. `filter: player_id=eq.<id>` is the whole point: `ratings` is
 * one row per member and an unfiltered listener would wake this screen every
 * time anybody in the club finished a match. That is what /leaderboard wants —
 * it draws the whole field, so it subscribes unfiltered — and precisely what a
 * page about one person does not. The filter is about noise, not exposure:
 * `ratings_select` (00005:79) is `FOR SELECT TO authenticated USING (TRUE)`, so
 * every signed-in member could already read every rating row, and Realtime
 * applies that same policy per subscriber.
 *
 * NUDGE, DO NOT MERGE. The callback calls router.refresh() rather than pushing
 * the payload into state. The socket payload is the raw `ratings` row; what
 * these pages SHOW is derived from it several times over — the ladder position
 * on /my-stats comes from get_leaderboard(), the form strip and the rating
 * chart are folded out of a 200-match window, the feed's record card is gated
 * behind account standing. Re-running the server component re-derives all of it
 * from the viewer's own credentials, so a live update cannot surface anything a
 * static render withheld. There is also nothing useful to merge: the render
 * reads the row through getCurrentPlayer(), which uses the service role
 * precisely because 00032 took blanket SELECT on `players` away.
 *
 * NO MIGRATION FOR THIS ONE. `ratings` has been a member of `supabase_realtime`
 * since 00036 — verified against pg_publication_tables on both databases — so
 * this listener is live the moment it ships, unlike almost every other
 * subscription in this repository. It is still the same hazard in reverse: a
 * subscription to an UNPUBLISHED table succeeds and then never fires, which is
 * why lib/__tests__/realtime-publication.test.ts reads this file as text.
 *
 * DELETES ARE NOT DELIVERED HERE, and it does not matter. Under default replica
 * identity the WAL's old tuple for a DELETE carries only the primary key
 * (`ratings.id`), so `player_id` is not there to match and a filtered
 * subscriber is never routed the event. A `ratings` row is only ever deleted by
 * the ON DELETE CASCADE from `players` — at which point the member has no
 * account and no screen to keep up to date.
 */

/** Long enough to fold a confirm that touches the row more than once into a
 *  single re-render, short enough that a member watching their own number reads
 *  it as immediate. Well under the leaderboard's 2.5s: the ladder is settling
 *  in the background, this is the figure somebody is looking straight at. */
const COALESCE_MS = 800;

export function LiveRating({ playerId }: { playerId: string }) {
  const router = useRouter();
  // THE SAME REFRESH THE LISTENER DOES, for the case the listener was not
  // there to do it. A channel that dies and comes back has missed every
  // `ratings` UPDATE in between and will never be sent them — CDC has no
  // replay — so the member's own number would sit at its pre-match value with
  // a healthy-looking socket underneath it. See use-live-channel.ts.
  const subscribe = useLiveChannel(() => router.refresh());

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // KEEP PROSE OUT OF THE GAP BELOW. The publication guard reads the table
    // name out of the 400 characters that follow each postgres_changes literal,
    // so a comment wedged between that literal and the config object hides this
    // subscription from the very test written to notice it. It has happened
    // once already (5d100de), which is why this note sits up here.
    //
    // The name is written WITHOUT its quotes in this sentence on purpose: the
    // guard scans for the quoted form, so spelling it that way in prose
    // manufactures a scan position that resolves to no table at all.
    //
    // UPDATE only. The INSERT is 00004's trigger writing the row at approval,
    // on an account that has no rating to be stale about yet.
    const channel = supabase
      .channel(`rating-${playerId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'ratings',
          filter: `player_id=eq.${playerId}`,
        },
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => router.refresh(), COALESCE_MS);
        },
      );

    const stopWatching = subscribe(channel);

    return () => {
      // The timer as well as the channel: a refresh queued a moment before the
      // member navigated away would otherwise fire against an unmounted tree.
      clearTimeout(timer);
      // BEFORE removeChannel, not after: removing a channel unsubscribes it,
      // which delivers CLOSED to the status callback, and a watcher still
      // listening would read this teardown as an outage and queue a rebuild.
      stopWatching();
      void supabase.removeChannel(channel);
    };
  }, [playerId, router, subscribe]);

  return null;
}
