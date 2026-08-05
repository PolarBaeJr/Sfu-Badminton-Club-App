'use server';

import { headers } from 'next/headers';
import { createServiceRoleClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import {
  isDoublesEvent,
  isMembershipAllowed,
  membershipRefusalMessage,
  ExpectedError,
} from '@badminton/shared';
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
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

export async function withdrawFromEvent(eventId: string): Promise<ActionResult> {
  return runAction(() => withdrawFromEventImpl(eventId));
}

async function withdrawFromEventImpl(eventId: string) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: participant } = await service.from('tournament_participants')
    .select('id, status, event:tournament_events(tournament_id)')
    .eq('event_id', eventId).eq('player_id', player.id).maybeSingle();
  if (!participant) throw new Error('Not registered');
  if (participant.status !== 'registered' && participant.status !== 'checked_in') {
    throw new Error('Cannot withdraw at this stage');
  }

  const { error } = await service.from('tournament_participants')
    .update({ status: 'withdrawn' })
    .eq('id', participant.id);
  if (error) throw new Error(error.message);

  const tid = (participant.event as unknown as { tournament_id: string } | null)?.tournament_id;
  if (tid) revalidateTournamentPaths(tid, eventId);
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

  const { error } = await service.from('tournament_participants')
    .update({ status: 'checked_in', checked_in_at: new Date().toISOString() })
    .eq('id', participant.id);
  if (error) throw new Error(error.message);

  revalidateTournamentPaths(event.tournament_id, eventId);
}
