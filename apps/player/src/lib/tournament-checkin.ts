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
  // The label to report per participant row, so the response can be built from
  // the rows the UPDATE actually changed rather than from the rows we hoped it
  // would change.
  const labelById = new Map<string, string>();

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
    labelById.set(row.id, label);
  }

  // FENCED -- 00201, and this path was the one that never got there. The
  // sibling self-check-in in tournament-actions.ts was moved behind
  // set_field_entry_status; this one kept a direct service-role UPDATE, so the
  // fence had a hole in exactly the shape it was built to close.
  //
  // The direct write re-asserted the ENTRY status in its WHERE clause, which
  // is why two rapid scans could not both claim a row. What it could not
  // re-assert was the EVENT status: `row.event?.status !== 'checkin'` is read
  // in JS, several awaits earlier -- the waiver assertion sits between that
  // read and the write -- and no WHERE clause on tournament_participants can
  // express a condition on tournament_events. The RPC re-reads both under the
  // shared field key, so the decision is made from state that could not have
  // moved in between.
  //
  // One call per entry rather than one batched UPDATE: the fence keys on the
  // event, and a scan spans several events, so there is no single lock to take
  // for all of them. Sequential rather than concurrent -- each call takes an
  // advisory lock, and issuing them in a fixed order per scan keeps two
  // simultaneous scanners from taking the same pair of event locks in opposite
  // orders.
  //
  // p_actor is null for the same reason as selfCheckIn: nobody at a desk
  // checked this person in, so checked_in_by must not name one.
  for (const id of toClaim) {
    const label = labelById.get(id) ?? 'Event';
    const { data: outcome, error } = await service.rpc('set_field_entry_status', {
      p_entry_id: id,
      p_is_pair: false,
      p_new_status: 'checked_in',
      p_actor: null,
    });
    if (error) throw new Error(error.message);
    const result = outcome as { ok: boolean; already?: boolean; reason?: string } | null;

    // `already` comes from the status the fence read under the lock, so a
    // second scan racing this one reports "already checked in" from the write
    // itself rather than from a follow-up read that could move again.
    if (result?.ok) {
      if (result.already) alreadyIn.push(label);
      else checkedIn.push(label);
      continue;
    }

    // Refused. Something moved underneath the scan -- an officer withdrawing
    // someone mid-queue, or a draw published between the read above and here.
    // It belongs in neither list: the member is not checked in and was not
    // already, and saying either would be a lie. If every entry lands here the
    // caller below reports check-in is not open, which is what they need to
    // hear at the door.
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
