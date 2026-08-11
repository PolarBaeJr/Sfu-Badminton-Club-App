'use server';

import { headers } from 'next/headers';
import { createServiceRoleClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import {
  ensureEntryFees,
  isDoublesEvent,
  isMembershipAllowed,
  membershipRefusalMessage,
  eventHasDraw,
  ExpectedError,
} from '@badminton/shared';
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import {
  assertMyEventWaiverSigned,
  loadMyEventWaiver,
  recordEventWaiverAcceptance,
} from './event-waiver';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';

// Revalidate every surface that surfaces tournament_participants /
// tournament_pairs after a register/withdraw/check-in. The event detail
// page must be in this list — that's the page where the user clicked
// the action button, and "No participants yet" was rendering stale.
function revalidateTournamentPaths(tournamentId: string, eventId: string) {
  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
  revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Supabase may return a to-one embed as object-or-array — unwrap defensively.
function pickSuspension(embed: unknown): { suspended_at: string | null; suspension_reason: string | null; waiver_text?: string | null } | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { suspended_at: string | null; suspension_reason: string | null; waiver_text?: string | null } | null) ?? null;
}

// Same object-or-array unwrap as pickSuspension, for the eligibility list.
function pickAllowedMemberships(embed: unknown): string[] | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  const value = (row as { allowed_memberships?: string[] | null } | null)?.allowed_memberships;
  return Array.isArray(value) ? value : null;
}

export async function registerForEvent(eventId: string, opts?: { eventWaiverAccepted?: boolean }): Promise<ActionResult> {
  return runAction(() => registerForEventImpl(eventId, opts));
}

async function registerForEventImpl(eventId: string, opts?: { eventWaiverAccepted?: boolean }) {
  const player = await requirePlayer();
  if (player.is_banned) {
    throw new Error('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  // Parallelize the three independent reads needed before we can validate.
  // `.maybeSingle()` instead of `.single()` so a missing existing row isn't
  // surfaced as a thrown PGRST116 error.
  const [eventRes, existingRes, ratingRes] = await Promise.all([
    service.from('tournament_events')
      .select('id, status, event_type, tournament_id, max_participants, tournament:tournaments(suspended_at, suspension_reason, waiver_text, allowed_memberships)')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
    service.from('ratings').select('singles_elo').eq('player_id', player.id).maybeSingle(),
  ]);

  const event = eventRes.data;
  if (!event) throw new Error('Event not found');
  const regTournament = pickSuspension(event.tournament);
  if (regTournament?.suspended_at) {
    throw new Error(`This tournament is currently suspended${regTournament.suspension_reason ? `: ${regTournament.suspension_reason}` : ''}`);
  }
  // Membership gate. Some events are internal-only, some admit alumni, some are
  // open. Enforced here rather than in RLS because this action uses the
  // service-role key, which bypasses policies entirely — a policy would look
  // like protection and do nothing.
  //
  // Admin-added participants deliberately skip this: adding someone by hand in
  // the admin app is an explicit override, not a loophole.
  const allowedMemberships = pickAllowedMemberships(event.tournament);
  if (!isMembershipAllowed(player.membership_type, allowedMemberships)) {
    throw new ExpectedError(membershipRefusalMessage(allowedMemberships));
  }

  if (event.status !== 'registration') throw new Error('Registration is closed');
  if (isDoublesEvent(event.event_type)) throw new Error('Use pair registration for doubles events');
  if (existingRes.data) throw new Error('Already registered');

  // Event waiver gate — the tournament may require its own waiver before
  // registering. The client must confirm acceptance; the hash is always taken
  // from the server-side text, never a client-supplied value.
  const eventWaiverText = regTournament?.waiver_text?.trim();
  if (eventWaiverText && !opts?.eventWaiverAccepted) {
    throw new Error('You must accept the event waiver to register');
  }

  // Capacity check is the only thing that has to wait — it depends on a fresh count.
  if (event.max_participants) {
    const { count } = await service.from('tournament_participants')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    if (count && count >= event.max_participants) throw new Error('Event is full');
  }

  const { error: insertErr } = await service.from('tournament_participants').insert({
    event_id: eventId,
    player_id: player.id,
    elo_before: ratingRes.data?.singles_elo ?? 400,
    status: 'registered',
  });
  if (insertErr) throw new Error(insertErr.message);

  // What this entry costs, on the club's fee ledger, priced from the member's
  // membership_type. Deliberately AFTER the participant row and deliberately
  // not awaited for its success: the member is registered either way, and
  // ensureEntryFees never throws for exactly that reason. Per tournament, not
  // per event, so entering a second event here finds the existing row.
  await ensureEntryFees(service, event.tournament_id, [player.id]);

  // Record immutable acceptance evidence keyed by the text hash. onConflict
  // ignore keeps it idempotent if the same text is accepted twice.
  if (eventWaiverText) {
    const waiverHash = eventWaiverHash(eventWaiverText);
    const userAgent = (await headers()).get('user-agent');
    await service.from('event_waiver_acceptances').upsert({
      player_id: player.id,
      tournament_id: event.tournament_id,
      waiver_hash: waiverHash,
      user_agent: userAgent,
    }, { onConflict: 'player_id,tournament_id,waiver_hash', ignoreDuplicates: true });
  }

  revalidateTournamentPaths(event.tournament_id, eventId);
}

/**
 * Accept a tournament's event waiver on its own, outside registration.
 *
 * This is what closes the loop for somebody an EXEC added: they never went
 * through registerForEvent, so nothing ever asked them. The tournament page
 * shows them the text and this records the acceptance.
 *
 * IT IS THE MEMBER'S ACTION AND NOBODY ELSE'S. requirePlayer() reads the
 * signed-in session, and the row is written for THAT player — there is no
 * parameter for whose signature this is, deliberately, because a parameter is
 * all an exec-facing wrapper would need to start recording signatures on other
 * people's behalf.
 *
 * "Sign at the door" is therefore: the exec hands over a device the member is
 * signed in on, and the member reads and accepts. Same action, same evidence,
 * no proxy.
 */
export async function acceptEventWaiver(
  tournamentId: string,
  opts: { accepted: boolean },
): Promise<ActionResult> {
  return runAction(() => acceptEventWaiverImpl(tournamentId, opts));
}

async function acceptEventWaiverImpl(tournamentId: string, opts: { accepted: boolean }) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  // The tick box is a UI affordance and this is the server's copy of the same
  // question. Without it, a request with the box unchecked records agreement.
  if (!opts.accepted) throw new ExpectedError('Tick the box to accept the event waiver.');

  const { text, status } = await loadMyEventWaiver(service, tournamentId, player.id);
  if (!text) throw new ExpectedError('This tournament has no event waiver to accept.');
  // Idempotent by the unique index anyway; saying so is friendlier than a
  // silent no-op that looks like the button did nothing.
  if (status.state === 'signed') return;

  // ENTRANTS ONLY. An acceptance from somebody who is not in the tournament is
  // evidence of nothing and would sit in the table forever. Checked across both
  // disciplines because a doubles entrant has no tournament_participants row at
  // all — they exist only as half of a pair, which is exactly the population
  // this feature was built for.
  const [singles, pairs] = await Promise.all([
    service.from('tournament_participants')
      .select('id, event:tournament_events!inner(tournament_id)')
      .eq('player_id', player.id)
      .eq('tournament_events.tournament_id', tournamentId)
      .limit(1),
    service.from('tournament_pairs')
      .select('id, event:tournament_events!inner(tournament_id)')
      .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
      .eq('tournament_events.tournament_id', tournamentId)
      .limit(1),
  ]);
  if ((singles.data?.length ?? 0) === 0 && (pairs.data?.length ?? 0) === 0) {
    throw new ExpectedError('You are not entered in this tournament, so there is nothing to accept yet.');
  }

  await recordEventWaiverAcceptance(service, tournamentId, player.id, text);

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function withdrawFromEvent(eventId: string): Promise<ActionResult> {
  return runAction(() => withdrawFromEventImpl(eventId));
}

async function withdrawFromEventImpl(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: participant } = await service.from('tournament_participants')
    .select('id, status, event:tournament_events(tournament_id, status)')
    .eq('event_id', eventId).eq('player_id', player.id).maybeSingle();
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered' && participant.status !== 'checked_in') {
    throw new ExpectedError('Cannot withdraw at this stage');
  }

  const event = (Array.isArray(participant.event) ? participant.event[0] : participant.event) as
    { tournament_id: string; status: string } | null;

  // Self-withdrawal stops the moment the draw is published. Up to that point
  // leaving only affects you; afterwards it hands your opponent a rated
  // walkover, shifts the round above, and can strand a slot at TBD. That is a
  // tournament-desk decision, and the machinery that makes it coherent (the
  // forfeit cascade and its Elo snapshots) lives in the admin app — reachable
  // only by an exec. Letting the button through here would leave the bracket
  // exactly as broken as doing nothing.
  if (eventHasDraw(event?.status)) {
    throw new ExpectedError(
      'The draw is already published — ask a tournament admin to withdraw you so your matches can be forfeited properly.',
    );
  }

  const { error } = await service.from('tournament_participants')
    .update({ status: 'withdrawn' })
    .eq('id', participant.id);
  if (error) throw new Error(error.message);

  if (event?.tournament_id) revalidateTournamentPaths(event.tournament_id, eventId);
  else revalidatePath('/tournaments');
}

export async function selfCheckIn(eventId: string): Promise<ActionResult> {
  return runAction(() => selfCheckInImpl(eventId));
}

async function selfCheckInImpl(eventId: string) {
  const player = await requirePlayer();
  if (player.is_banned) {
    throw new Error('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  // Parallel reads — event status and player participation row are independent.
  const [eventRes, participantRes] = await Promise.all([
    service.from('tournament_events')
      .select('status, tournament_id, tournament:tournaments(suspended_at, suspension_reason)')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id, status').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
  ]);

  const event = eventRes.data;
  const participant = participantRes.data;
  const checkinTournament = event ? pickSuspension(event.tournament) : null;
  if (checkinTournament?.suspended_at) {
    throw new Error(`This tournament is currently suspended${checkinTournament.suspension_reason ? `: ${checkinTournament.suspension_reason}` : ''}`);
  }
  if (!event || event.status !== 'checkin') throw new Error('Check-in is not open');
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered') throw new Error('Cannot check in');

  // THE HARD BLOCK, on the member's own route in. An exec who added them never
  // asked for the event waiver — that is the whole gap — so this is the point
  // where being on the sheet stops being enough. registerForEvent already
  // refuses without an acceptance, but an admin-added entrant never went
  // through it, and an edited waiver un-signs somebody who did.
  await assertMyEventWaiverSigned(service, event.tournament_id, player.id);

  const { error } = await service.from('tournament_participants')
    .update({ status: 'checked_in', checked_in_at: new Date().toISOString() })
    .eq('id', participant.id);
  if (error) throw new Error(error.message);

  revalidateTournamentPaths(event.tournament_id, eventId);
}
