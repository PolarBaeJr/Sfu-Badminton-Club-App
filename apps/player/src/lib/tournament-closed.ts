// THE GATE THAT WASN'T THERE, SPLIT OUT SO IT CAN BE TESTED AT ALL.
//
// tournament-actions.ts carries 'use server', and Next permits only async
// function exports from such a file — so a pure predicate living there is
// unreachable from a test. That is the same trap that let the archive refusal
// ship with the wrong button name in it, and it is why this is its own module.
//
// WHAT WAS MISSING. Every entry path read the tournament embed for
// `suspended_at` and never for `status`, so nothing on the player side asked
// whether the tournament was over. Observed on staging 2026-08-18: pressing
// REGISTER on an event still at `registration` inside the ARCHIVED Fall Open
// reached the capacity check — the last gate before the insert — and was turned
// away by "Event is full", not by the tournament being finished. With one free
// place the entry would have been written.
//
// 'draft' is deliberately NOT refused here. It is unpublished rather than over,
// nothing was observed reaching these paths from a draft tournament, and
// refusing it would be an untested behaviour change riding along on a fix for
// something else.

import type { TournamentStatus } from '@badminton/shared';

const CLOSED: readonly string[] = ['completed', 'archived'];

/**
 * The sentence to refuse with, or null if the tournament is still open.
 *
 * @param status the tournament's own status, already unwrapped from the embed
 * @param what   what the member was trying to do, e.g. 'enter this event'
 */
export function refuseClosedTournament(
  status: TournamentStatus | string | null | undefined,
  what: string,
): string | null {
  if (!status || !CLOSED.includes(status)) return null;
  const state = status === 'archived' ? 'has been archived' : 'is over';
  return `This tournament ${state}, so you cannot ${what}. Ask a tournament admin if you think that is wrong.`;
}
