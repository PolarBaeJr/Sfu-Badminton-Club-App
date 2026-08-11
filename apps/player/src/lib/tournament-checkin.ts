'use server';

import { revalidatePath } from 'next/cache';
import { CHECKIN_TOKEN_REGEX, ExpectedError } from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';
import { assertMyEventWaiverSigned } from './event-waiver';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';

export interface TournamentCheckInResult {
  tournamentName: string;
  /** Events this scan checked them into, for the confirmation screen. */
  checkedIn: string[];
  /** Events they were already checked into — a second scan is not an error. */
  alreadyIn: string[];
}

export async function checkInToTournament(
  token: string,
): Promise<ActionResult<TournamentCheckInResult>> {
  return runAction(() => checkInToTournamentImpl(token));
}

// One scan checks a player into EVERY event of that tournament they are
// entered in. Previously check-in was per event, on separate pages — someone in
// Men's Singles and Mixed Doubles had to do it twice while standing at the door.
async function checkInToTournamentImpl(token: string): Promise<TournamentCheckInResult> {
  // Shape-check before touching the database, so a malformed scan costs a
  // regex rather than a query.
  if (!CHECKIN_TOKEN_REGEX.test(token)) {
    throw new ExpectedError('That QR code is not valid.');
  }

  const player = await requirePlayer();
  if (player.is_banned) {
    throw new ExpectedError('Your account is suspended. Speak to an exec.');
  }

  // Service role throughout: tournament_checkin_tokens has RLS on with no
  // policies (00045), and tournament_participants rows for other players are
  // not readable by `authenticated`.
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  const { data: tokenRow } = await service
    .from('tournament_checkin_tokens')
    .select('tournament_id')
    .eq('token', token)
    .maybeSingle();
  // Uniform message for an unknown token: confirming which codes exist would
  // let someone probe the token space.
  if (!tokenRow) throw new ExpectedError('That QR code is not valid.');

  const { data: tournament } = await service
    .from('tournaments')
    .select('name, suspended_at, suspension_reason')
    .eq('id', tokenRow.tournament_id)
    .maybeSingle();
  if (!tournament) throw new ExpectedError('That QR code is not valid.');
  if (tournament.suspended_at) {
    throw new ExpectedError(
      `This tournament is suspended${tournament.suspension_reason ? `: ${tournament.suspension_reason}` : ''}`,
    );
  }

  // THE HARD BLOCK, on the third way in. One scan checks a member into every
  // event they are entered in, and the waiver is per TOURNAMENT — so this is a
  // single question asked once, before any of those rows move.
  //
  // Refusing the whole scan is right HERE and wrong in the exec's bulk button:
  // this is one person, standing at the door, who can fix it themselves in the
  // next ten seconds. Nobody else is held up behind them.
  await assertMyEventWaiverSigned(service, tokenRow.tournament_id, player.id);

  // Every entry this player holds in the tournament, with its event's status.
  const { data: entries } = await service
    .from('tournament_participants')
    .select('id, status, event:tournament_events!inner(id, event_type, status, tournament_id)')
    .eq('player_id', player.id)
    .eq('tournament_events.tournament_id', tokenRow.tournament_id);

  const rows = (entries ?? []) as unknown as {
    id: string;
    status: string;
    event: { id: string; event_type: string; status: string } | null;
  }[];

  if (rows.length === 0) {
    throw new ExpectedError('You are not registered for anything in this tournament.');
  }

  const checkedIn: string[] = [];
  const alreadyIn: string[] = [];
  const toClaim: string[] = [];

  for (const row of rows) {
    const label = row.event?.event_type ?? 'Event';
    // Withdrawn or disqualified entries are not re-openable by scanning a code
    // at the door — that is an admin decision.
    if (row.status === 'withdrawn' || row.status === 'disqualified') continue;
    if (row.status === 'checked_in') { alreadyIn.push(label); continue; }
    // Only while the event is actually accepting check-in. Registration is too
    // early, and once the bracket exists the field is fixed.
    if (row.event?.status !== 'checkin') continue;
    toClaim.push(row.id);
    checkedIn.push(label);
  }

  if (toClaim.length > 0) {
    const { error } = await service
      .from('tournament_participants')
      .update({ status: 'checked_in' })
      .in('id', toClaim)
      // Re-assert the precondition in the WHERE clause so two rapid scans
      // cannot both claim the same row.
      .eq('status', 'registered');
    if (error) throw new Error(error.message);
  }

  if (checkedIn.length === 0 && alreadyIn.length === 0) {
    throw new ExpectedError('Check-in is not open for your events yet.');
  }

  revalidatePath(`/tournaments/${tokenRow.tournament_id}`);

  return {
    tournamentName: (tournament.name as string) ?? 'Tournament',
    checkedIn,
    alreadyIn,
  };
}
