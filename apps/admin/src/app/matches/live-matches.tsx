'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

/**
 * THE CLUB'S MATCH LEDGER, LIVE.
 *
 * /matches is server-rendered and every console write path ends in
 * `revalidatePath('/matches')` — but only for the exec who made it. The case
 * this file exists for is the other one, and on this screen it is mostly not
 * another exec at all: it is the MEMBERS. Club results are submitted and
 * confirmed from phones through the player app all evening, and each of those
 * writes lands in the ledger this page draws. An exec with /matches open while
 * a session runs was watching a list that stopped moving the moment it
 * rendered, with no way to tell a quiet night from a stale page.
 *
 * The second case is the console's own: two execs, one entering results at the
 * scoring table and another resolving a dispute from a laptop, each invisible
 * to the other until a reload.
 *
 * UNFILTERED, AND IT HAS TO BE. `matches` carries no player column, and this
 * screen is the whole club's ledger — the last fifty matches, everyone's — so
 * there is no filter that would not simply make it wrong. That also buys
 * something the filtered listeners in the player app cannot have: under
 * default replica identity a DELETE's WAL tuple carries only the primary key,
 * which is enough to route an event to an UNFILTERED subscriber and not enough
 * to match any `filter` expression. So this is the one surface in 00114 that
 * hears a match row disappear — which matters, because discardIncompleteMatch
 * (lib/actions/matches.ts) is the only DELETE against `matches` anywhere and
 * it is a console path.
 *
 * ONE TABLE IS ENOUGH HERE, deliberately, where the player app needs four.
 * Every write path that changes what this page prints ends up touching
 * `matches` itself: adminCreateMatch INSERTs it, apply_match_result UPDATEs
 * result_status and confirmed_by on it, voidMatch and convertMatchToCasual
 * UPDATE it, resolveDispute UPDATEs it after rewriting the games, and
 * apply_walkover_result INSERTs one. The participant and game rows this page
 * also renders are always written in the same flow as one of those, so a
 * second listener on them would only ever fire alongside this one and buy a
 * duplicate refresh.
 *
 * NUDGE, DO NOT MERGE. router.refresh() rather than merging the payload into
 * local state. The socket payload is whatever RLS lets through, and
 * matches_select is `USING (TRUE)` — every signed-in member can read every row
 * of this table. What this CONSOLE shows is much narrower and is decided per
 * viewer: the create form needs `matches.create.write`, the void and convert
 * controls their own capabilities, the dispute and walkover panels theirs, and
 * the ADMIN NOTE strip the union of the three match writes. Re-running the
 * server component re-derives all of it from the viewer's own credentials, so a
 * live update cannot surface something a static render withheld. Names are not
 * in the payload either — they come from the `players` join the server does,
 * and `players` is not published and must never be.
 *
 * THE NOTE IS NOT ON THIS WIRE ANY MORE, and that is the point of 00117. It
 * used to be `matches.admin_note`, riding on every row this channel carries to
 * every subscriber; it now lives in `match_admin_notes`, which is deliberately
 * NOT a member of `supabase_realtime` (both apps' realtime-publication guard
 * tests assert that by name). So this listener no longer fires when a note is
 * written on its own — it fires on the `matches` write that always accompanies
 * one — and adding the note table to the publication to "fix" that would hand
 * the text back to the whole club. The column itself is still there and still
 * streams its historical values until a later migration drops it.
 *
 * *** INERT UNTIL THE PUBLICATION SAYS SO. *** `matches` is not a member of
 * `supabase_realtime` until 00114 is applied, and a subscription to an
 * unpublished table SUCCEEDS and then never fires — .subscribe() resolves, the
 * callback never runs, nothing errors. That is the exact silent failure 00036
 * was written to fix. Until the owner runs 00114 this component does nothing.
 */

/** Long enough to fold one entry into one re-render, and it has to be:
 *  adminCreateMatch is six round-trips against three tables and finishes with
 *  apply_match_result, which UPDATEs `matches` a second time. Short enough
 *  that an exec watching the ledger reads it as immediate. The same 700ms the
 *  tournament and player-side listeners use. */
const COALESCE_MS = 700;

/**
 * Renders nothing. The ledger stays a server component — the capability gates,
 * the name joins and the dispute/walkover panels are all decided server-side,
 * and there is no reason to ship that shaping to the browser.
 *
 * MOUNTED AS A SIBLING OF THE TABLE, NOT INSIDE IT. That is not incidental:
 * page.tsx renders through SearchableTable into ResponsiveTable, which mounts
 * BOTH a card list and a table and hides one with CSS rather than unmounting
 * it. Anything passed as a row child is therefore instantiated twice — which
 * is why MatchActions exists twice per row — and a listener placed in there
 * would open two identical channels on one topic. A sibling is mounted once,
 * which is the same shape LiveAttendance uses beside the door feed.
 *
 * The in-progress input on this screen needs no `enabled` flag for the same
 * structural reason it needed one on the player's challenge page and does not
 * here: every dialog (CreateMatchForm's score entry, MatchActions' void
 * reason) is open-prop controlled from pure client useState in a component
 * that keeps its identity across a refresh, and none of them is gated on a
 * server prop that a refresh could flip. A refresh re-renders the ledger
 * underneath an open dialog and leaves the typing in it alone.
 */
export function LiveMatches() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // KEEP PROSE OUT OF THE GAP BELOW. The publication guard
    // (lib/__tests__/realtime-publication.test.ts) reads the table name out of
    // the 400 characters that follow each postgres_changes literal, so a
    // comment wedged between that literal and the config object hides this
    // subscription from the very test written to notice it. It has happened
    // once already, which is why this note sits up here — and the name is
    // written without its quotes in this sentence for the same family of
    // reason, since the guard scans for the quoted form.
    //
    // EVERY EVENT, INCLUDING DELETE. No filter means the primary key in a
    // delete's tuple is enough to route it here, so a discarded match leaves
    // this list as well as arriving in it.
    const channel = supabase
      .channel('matches-console')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'matches' },
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => router.refresh(), COALESCE_MS);
        },
      )
      .subscribe();

    return () => {
      // The timer as well as the channel: a refresh queued a moment before the
      // exec navigated away would otherwise fire against an unmounted tree.
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
