'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

/**
 * WATCHING A DRAW MOVE.
 *
 * A tournament is the one thing this club runs where the screen is watched by
 * people who are not the person typing. Every write goes through the console
 * and ends in `revalidateEventPaths()`, which covers the exec at the scoring
 * table and nobody else — so an entrant sitting courtside with the bracket open
 * on their phone, waiting to find out whether their next match is ready, was
 * looking at whatever the page rendered when they opened it. Half of them had
 * worked out that pulling to refresh was the actual interface.
 *
 * NUDGE, DO NOT MERGE. The callback calls router.refresh() rather than pushing
 * the payload into local state. Three reasons, in order of how much they
 * matter:
 *
 *   1. CAPABILITY. The socket payload is whatever RLS lets through, and RLS on
 *      all four of these tables is `TO authenticated USING (true)` — every
 *      signed-in member can read every row. What a page SHOWS is far narrower,
 *      and on the console side it is narrower per viewer: the score controls,
 *      the seeding controls and the entrant notes are each behind their own
 *      capability. Re-running the server component re-derives all of that from
 *      the viewer's own credentials, so a live update cannot surface something
 *      a static render would have withheld. Hand-merging rows would move that
 *      decision to the client, where it does not belong.
 *
 *   2. DERIVED NUMBERS. One score entry moves the match card, the round it sits
 *      in, the next round's occupants, the standings table, the entrant's
 *      points and final position, and sometimes the event's status. They are
 *      folded out of one read in page.tsx; a refresh re-derives every one of
 *      them from that single source instead of leaving six copies to drift.
 *
 *   3. NAMES. These rows carry ids. The bracket shows names because the SERVER
 *      joins `players` when it re-renders. There is nothing to merge.
 *
 * *** INERT UNTIL THE PUBLICATION SAYS SO. *** None of these four tables is a
 * member of `supabase_realtime` until 00113 is applied, and a subscription to
 * an unpublished table SUCCEEDS and then never fires — .subscribe() resolves,
 * the callback never runs, nothing errors. That is the exact silent failure
 * 00036 was written to fix. Until the owner runs 00113 this component does
 * nothing whatsoever and both screens behave as they did before.
 */

/** Long enough to fold one result into one re-render, and it has to be: a
 *  single score entry writes tournament_matches at least three times (the
 *  result, then the elo snapshot, then the advancement into the next round)
 *  and touches tournament_participants on the way, while regenerating a draw
 *  inserts every match in the event in a loop. Short enough that somebody
 *  courtside reads it as immediate. Between the door feed's 400ms and the
 *  leaderboard's 2.5s, which is about where a bracket belongs. */
const COALESCE_MS = 700;

export function LiveTournament({
  channel: channelName,
  tournamentId,
  eventIds,
  draw = false,
}: {
  /** UNIQUE PER SURFACE, so the tournament page and one of its event pages
   *  never share a topic. */
  channel: string;
  /** Watched whole: one listener covers every event in this tournament. */
  tournamentId: string;
  /** The events whose ENTRY LISTS this surface shows. */
  eventIds: string[];
  /** Also watch the matches of those events. True only where a draw is drawn —
   *  the tournament overview lists events and counts and would otherwise be
   *  woken by every score in every event it is merely summarising. */
  draw?: boolean;
}) {
  const router = useRouter();

  // THE DEPENDENCY IS THE JOINED KEY, NOT THE ARRAY. `eventIds` is built by a
  // .map() in the server component, so it is a new array identity on every
  // render — depending on it directly would tear the channel down and open a
  // fresh one each time React re-rendered.
  const key = eventIds.join(',');

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(channelName);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const nudge = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), COALESCE_MS);
    };

    // ONE LISTENER PER FILTER. postgres_changes takes a single filter
    // expression, so several events means several .on() calls — on one
    // channel, which is one socket. The filters are what keep a member
    // watching Saturday's mixed doubles from being woken by every score in
    // every other tournament the club has ever run, and they are about noise
    // rather than exposure: RLS already decides what a subscriber may see, and
    // here it lets every signed-in member see everything.
    //
    // EVERY EVENT, AND SOME THAT WILL NOT ARRIVE. `event: '*'` because a score,
    // a walkover, a void, a check-in, a seeding change and a status transition
    // all move what these pages print. A DELETE does not: under default replica
    // identity the WAL's old tuple carries the primary key alone, so neither
    // `event_id` nor `tournament_id` is there for `filter` to match on. 00113
    // works through the four delete paths and why the gap is survivable — the
    // short version is that all three real ones are refused once a draw exists,
    // and the fourth (clearing an event's matches to rebuild them) is followed
    // immediately by INSERTs, which DO route because an insert's tuple is the
    // new row.
    //
    // KEEP THIS PROSE OUT OF THE CONFIG OBJECTS. The publication guards
    // (lib/__tests__/realtime-publication.test.ts in both apps) read each table
    // name out of the 400 characters following each postgres_changes literal,
    // so a long comment between the two hides the subscription from the very
    // test that exists to notice it. It did exactly that once, which is how
    // this note got here — and the name is written WITHOUT its quotes in this
    // sentence for the same family of reason, since the guard scans for the
    // quoted form and would otherwise open a scan position on a comment.

    // TOURNAMENT-WIDE, and the only one of the four that can be. This is the
    // one table carrying `tournament_id`, so a single listener covers every
    // event under it — including one that does not exist yet, which a
    // per-event `id=eq.` filter would miss. An exec adding an event to a live
    // tournament is a change the overview has to show.
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tournament_events',
        filter: `tournament_id=eq.${tournamentId}`,
      },
      nudge,
    );

    for (const eventId of key === '' ? [] : key.split(',')) {
      // BOTH ENTRY TABLES, ALWAYS. A singles event has participants and no
      // pairs, a doubles event has pairs and no participants, and a surface
      // that subscribed only to whichever one it happened to be rendering
      // would be live for half the club's events. Subscribing to both costs a
      // listener that never fires on the other kind of event.
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_participants',
          filter: `event_id=eq.${eventId}`,
        },
        nudge,
      );

      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_pairs',
          filter: `event_id=eq.${eventId}`,
        },
        nudge,
      );

      if (draw) {
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournament_matches',
            filter: `event_id=eq.${eventId}`,
          },
          nudge,
        );
      }
    }

    channel.subscribe();

    return () => {
      // The timer as well as the channel: a refresh queued a moment before the
      // reader navigated away would otherwise fire against an unmounted tree.
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [channelName, tournamentId, key, draw, router]);

  return null;
}
