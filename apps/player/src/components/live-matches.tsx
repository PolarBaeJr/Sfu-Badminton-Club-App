'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

/**
 * CLUB PLAY, WITHOUT A RELOAD.
 *
 * Two people play a match. ONE of them submits the score. The other is on a
 * different phone, has written nothing, and is the person the result is
 * actually about — they are waiting to be asked to confirm it, and then waiting
 * to see what it did to their rating and their record. `revalidatePath` on the
 * submit path covers the submitter and nobody else, so every screen the
 * opponent was looking at stayed exactly as it was.
 *
 * LiveRating already covers ONE number of theirs, and only one: the `ratings`
 * row. Everything else on /my-stats is derived from `matches` and
 * `match_participants` — the record table, the form strip, head-to-head, best
 * partners — and none of it moved. This is the other half of that component.
 *
 * /feed IS THE SHARPEST CASE. apps/player/src/lib/actions/matches.ts
 * revalidates `/challenges`, `/challenges/[id]`, `/leaderboard` and
 * `/my-stats`, and never `/feed`. The club river is therefore not live for
 * anybody today — not even the member who just submitted the result that
 * belongs in it. For that surface these listeners are not an improvement on
 * revalidatePath, they are the only mechanism it has.
 *
 * NUDGE, DO NOT MERGE. Every callback calls router.refresh() rather than
 * pushing the payload into local state. Three reasons, in order of how much
 * they matter:
 *
 *   1. STANDING AND CAPABILITY. The socket payload is whatever RLS lets
 *      through, and RLS on all four of these tables is `TO authenticated USING
 *      (TRUE)` — every signed-in member can read every row. What these pages
 *      SHOW is far narrower: the whole action rail on a challenge is gated on
 *      account standing, and the feed's record card is gated the same way.
 *      Re-running the server component re-derives all of it from the viewer's
 *      own credentials, so a live update cannot surface something a static
 *      render withheld. Hand-merging rows would move that decision to the
 *      client, where it does not belong.
 *
 *   2. DERIVED NUMBERS. One confirmation moves the member's rating, their
 *      record, both streaks, their point differentials, their form strip,
 *      their rating chart, their head-to-head line against that opponent,
 *      their best-partners table, the match history table and the club feed.
 *      They are folded out of a handful of reads in page.tsx; a refresh
 *      re-derives every one of them from that single source instead of leaving
 *      ten copies to drift apart.
 *
 *   3. NAMES. These rows carry ids. The feed and the history table show names
 *      because the SERVER joins `players` when it re-renders — `players` is
 *      not published and must never be, since 00032 withheld `email` and
 *      `phone` by column GRANT and logical replication does not honour column
 *      grants. There is nothing to merge.
 *
 * *** INERT UNTIL THE PUBLICATION SAYS SO. *** None of these four tables is a
 * member of `supabase_realtime` until 00114 is applied, and a subscription to
 * an unpublished table SUCCEEDS and then never fires — .subscribe() resolves,
 * the callback never runs, nothing errors. That is the exact silent failure
 * 00036 was written to fix. Until the owner runs 00114 this file does nothing
 * whatsoever and every surface behaves as it did before.
 */

/** Long enough to fold one result into one re-render, and it has to be:
 *  adminCreateMatch is six round-trips (matches, then a bulk participants
 *  insert, then a bulk games insert, then apply_match_result, which UPDATEs
 *  every participant row and the match again), and a confirm touches
 *  match_participants once per player before moving `matches` itself. Short
 *  enough that the member being asked to confirm reads it as immediate.
 *  700ms, the same figure the tournament work settled on, and for the same
 *  reason: between the door feed's 400ms and the leaderboard's 2.5s. */
const COALESCE_MS = 700;

/**
 * The shared subscriber. Every argument is optional and an omitted one costs
 * nothing — a surface subscribes to exactly the slices it draws.
 */
export function useLiveMatches({
  channel: channelName,
  playerId,
  challengeIds,
  clubMatches = false,
  enabled = true,
}: {
  /** UNIQUE PER SURFACE, so the feed and the challenge list never share a
   *  topic. */
  channel: string;
  /** The viewer, when this surface shows THEIR matches or THEIR challenges.
   *  The only per-member key available: `match_participants` and
   *  `challenge_participants` carry `player_id` and `matches` does not. */
  playerId?: string;
  /** The challenges this surface is actually showing, watched by id. */
  challengeIds?: string[];
  /** Watch every club match, unfiltered. True only for /feed, which draws the
   *  whole club's last fifteen results and would be wrong to filter. */
  clubMatches?: boolean;
  /** False parks the whole thing — no client, no channel. The challenge
   *  detail page passes its dialog state, so a half-typed scoreline is never
   *  re-rendered out from under the person typing it. */
  enabled?: boolean;
}) {
  const router = useRouter();

  // THE DEPENDENCY IS THE JOINED KEY, NOT THE ARRAY. `challengeIds` is built
  // by a .map() in a server component, so it is a new array identity on every
  // render — depending on it directly would tear the channel down and open a
  // fresh one each time React re-rendered, which is how twenty channels happen
  // without anybody forgetting a cleanup.
  const key = (challengeIds ?? []).join(',');

  useEffect(() => {
    if (!enabled) return;
    // Nothing asked for means no socket at all, rather than an empty channel
    // kept open for the life of the page.
    if (!playerId && key === '' && !clubMatches) return;

    const supabase = createClient();
    const channel = supabase.channel(channelName);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const nudge = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), COALESCE_MS);
    };

    // ONE LISTENER PER FILTER. postgres_changes takes a single filter
    // expression, so several challenges means several .on() calls — on one
    // channel, which is one socket. The filters are what keep a member from
    // being woken every time anybody in the club finishes a match, and they
    // are about noise rather than exposure: RLS already decides what a
    // subscriber may see, and here it lets every signed-in member see
    // everything.
    //
    // EVERY EVENT, AND SOME THAT WILL NOT ARRIVE. `event: '*'` because a
    // submission, a confirmation, a dispute, a void and a conversion to casual
    // all move what these pages print. A DELETE does not, for the filtered
    // listeners: under default replica identity the WAL's old tuple carries the
    // primary key alone, so `player_id` and `challenge_id` are not there for
    // `filter` to match on. 00114 works through every delete that can reach
    // these tables — the short version is that nothing deletes `challenges` or
    // `challenge_participants` at all, and the single DELETE against `matches`
    // is the rollback of a create that never rendered.
    //
    // KEEP THIS PROSE OUT OF THE CONFIG OBJECTS. The publication guards
    // (lib/__tests__/realtime-publication.test.ts in both apps) read each table
    // name out of the 400 characters following each postgres_changes literal,
    // so a long comment between the two hides the subscription from the very
    // test that exists to notice it. It did exactly that once, which is how
    // this note got here — and the name is written WITHOUT its quotes in this
    // sentence for the same family of reason, since the guard scans for the
    // quoted form and would otherwise open a scan position on a comment.

    if (playerId) {
      // THE MEMBER'S OWN MATCHES, and the only way to express that. `matches`
      // has no player column, so "a match I was in" is not a filter that can
      // be written against it — it can only be written against the join table.
      // apply_match_result UPDATEs post_rating, rating_delta and win_flag here
      // for every participant of every confirmed match, so this one listener
      // is what makes a member's record, streak, form strip, head-to-head and
      // best-partners cards move.
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'match_participants',
          filter: `player_id=eq.${playerId}`,
        },
        nudge,
      );

      // A CHALLENGE ISSUED TO THEM arrives as an INSERT of their own
      // participant row, which routes because an INSERT's tuple is the new
      // row. Their own accept or reject is an UPDATE of the same row.
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'challenge_participants',
          filter: `player_id=eq.${playerId}`,
        },
        nudge,
      );
    }

    for (const challengeId of key === '' ? [] : key.split(',')) {
      // THE CHALLENGE ITSELF, and it cannot be left to the participant rows
      // above. When the OTHER party accepts or rejects, the row that changes
      // is theirs; the viewer's own participant row does not move at all, and
      // `challenges.status` is the only record of the change the viewer's
      // socket can hear.
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'challenges',
          filter: `id=eq.${challengeId}`,
        },
        nudge,
      );

      // The match that came out of it. `matches.challenge_id` is what makes a
      // per-challenge scope expressible at all on this table.
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'matches',
          filter: `challenge_id=eq.${challengeId}`,
        },
        nudge,
      );
    }

    if (clubMatches) {
      // UNFILTERED, DELIBERATELY, AND ONLY HERE. /feed draws the club's last
      // fifteen confirmed matches — every member's, which is the entire point
      // of a feed — so there is no per-member filter that would not simply
      // make it wrong. `matches` has no player column to filter on in any
      // case. This is the same trade /leaderboard already makes with `ratings`
      // for the same reason: a screen about everybody subscribes to
      // everybody. The cost is one refresh per club match on any open feed,
      // bounded by the coalesce window.
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'matches' },
        nudge,
      );
    }

    channel.subscribe();

    return () => {
      // The timer as well as the channel: a refresh queued a moment before the
      // member navigated away would otherwise fire against an unmounted tree.
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [channelName, playerId, key, clubMatches, enabled, router]);
}

/**
 * The club river's subscriber. Renders nothing — /feed stays a server
 * component, because everything it shows (names, the match sentence, the
 * standing-gated record card) is decided server-side and there is no reason to
 * ship any of that shaping to the browser.
 *
 * Watches the whole club AND the viewer's own challenge rows, because the page
 * draws both: the river of everyone's results, and the viewer's own pending
 * challenges block.
 */
export function LiveFeed({ playerId }: { playerId: string }) {
  useLiveMatches({ channel: 'feed-matches', playerId, clubMatches: true });
  return null;
}

/**
 * /my-stats. Strictly the member's own rows — this page is about one person,
 * and an unfiltered listener would wake it every time anybody in the club
 * finished a match. LiveRating alongside it covers the `ratings` row; this
 * covers everything derived from the matches themselves.
 */
export function LiveMyStats({ playerId }: { playerId: string }) {
  useLiveMatches({ channel: 'my-stats-matches', playerId });
  return null;
}

/**
 * The challenge LIST. The viewer's own participant rows are enough here: a new
 * challenge naming them arrives as an INSERT, and their own response as an
 * UPDATE. The other party's response is picked up by watching the listed
 * challenges themselves, which is why the ids are passed too.
 */
export function LiveChallenges({
  playerId,
  challengeIds,
}: {
  playerId: string;
  challengeIds: string[];
}) {
  useLiveMatches({ channel: 'challenges-list', playerId, challengeIds });
  return null;
}
