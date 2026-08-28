'use server';

import { headers } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import {
  ensureEntryFees,
  isDoublesEvent,
  isMembershipAllowed,
  membershipRefusalMessage,
  eventHasDraw,
  loadTournamentEntryCounts,
  isAtEntryCap,
  countDoublesField,
  doublesDrawSlots,
  wouldExceedCapacity,
  screenSelfEntry,
  toCompetitionCategory,
  ExpectedError,
  type TournamentEventType,
} from '@badminton/shared';
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import {
  assertMyEventWaiverSigned,
  loadMyEventWaiver,
  recordEventWaiverAcceptance,
} from './event-waiver';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';
import { refuseClosedTournament } from './tournament-closed';

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
function pickSuspension(embed: unknown): {
  suspended_at: string | null;
  suspension_reason: string | null;
  waiver_text?: string | null;
  // The tournament's own status, so an entry path can tell a tournament that is
  // OVER from one that is merely paused. Optional because not every select that
  // goes through this unwrap asks for it.
  status?: string | null;
} | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { suspended_at: string | null; suspension_reason: string | null; waiver_text?: string | null; status?: string | null } | null) ?? null;
}

// Same object-or-array unwrap as pickSuspension, for the eligibility list.
function pickAllowedMemberships(embed: unknown): string[] | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  const value = (row as { allowed_memberships?: string[] | null } | null)?.allowed_memberships;
  return Array.isArray(value) ? value : null;
}

// Same object-or-array unwrap again, for the per-member event cap (00098).
function pickEntryCap(embed: unknown): number | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  const value = (row as { max_events_per_player?: number | null } | null)?.max_events_per_player;
  return typeof value === 'number' ? value : null;
}

/**
 * What the member has to have been TOLD before this runs.
 *
 * Both flags are the server's copy of something the dialog said out loud, and
 * neither is a UI convenience: a request that arrives without one is refused,
 * so the sentence cannot be skipped by a client that forgot to render it.
 * `eventWaiverAccepted` already worked this way; `soloEntryAcknowledged` is the
 * same fiction for the same reason.
 */
export interface RegisterOptions {
  eventWaiverAccepted?: boolean;
  /**
   * DOUBLES ONLY, AND REQUIRED THERE. Entering a doubles event on your own is a
   * commitment to play with whoever you are given — the exec pairs you later —
   * and finding that out when a partner appears is not consent. This is set by
   * the dialog that says so, and nothing else sets it.
   */
  soloEntryAcknowledged?: boolean;
}

export async function registerForEvent(eventId: string, opts?: RegisterOptions): Promise<ActionResult> {
  return runAction(() => registerForEventImpl(eventId, opts));
}

async function registerForEventImpl(eventId: string, opts?: RegisterOptions) {
  const player = await requirePlayer();
  if (player.is_banned) {
    throw new ExpectedError('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  // Parallelize the three independent reads needed before we can validate.
  // `.maybeSingle()` instead of `.single()` so a missing existing row isn't
  // surfaced as a thrown PGRST116 error.
  const [eventRes, existingRes, existingPairRes, ratingRes] = await Promise.all([
    service.from('tournament_events')
      .select('id, status, event_type, tournament_id, max_participants, tournament:tournaments(status, suspended_at, suspension_reason, waiver_text, allowed_memberships, max_events_per_player)')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id, status').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
    // THE OTHER WAY TO ALREADY BE IN A DOUBLES EVENT. Since 00102 a member can
    // be an unpaired entrant (a participant row) OR half of a formed pair, and
    // the second has no participant row at all — so the existing check above
    // would wave a paired member straight through into a second entry.
    service.from('tournament_pairs')
      .select('id').eq('event_id', eventId)
      .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
      .limit(1),
    // Both disciplines' ratings. elo_before is stamped at registration and a
    // doubles entrant is rated on doubles_elo — it is the number the pool shows
    // and the number the team they end up in would be built from.
    service.from('ratings').select('singles_elo, doubles_elo').eq('player_id', player.id).maybeSingle(),
  ]);

  // FAIL CLOSED ON EVERY PREREQUISITE. All four of these reads answer a
  // question whose failure mode is silently permissive: a failed pair read is
  // "not in a pair", a failed participant read is "not registered", a failed
  // rating read is Elo 400. Awaiting a Supabase call is not error handling —
  // PostgREST failures resolve, they do not reject — so each one has to be
  // inspected or the guards below are decided by an outage.
  for (const [what, res] of [
    ['event', eventRes],
    ['existing entry', existingRes],
    ['existing pair', existingPairRes],
    ['rating', ratingRes],
  ] as const) {
    if (res.error) {
      Sentry.captureException(res.error, { tags: { action: 'registerForEvent', read: what } });
      throw new ExpectedError('Cannot process your entry right now — please try again shortly');
    }
  }

  const event = eventRes.data;
  if (!event) throw new Error('Event not found');
  const regTournament = pickSuspension(event.tournament);
  if (regTournament?.suspended_at) {
    throw new ExpectedError(`This tournament is currently suspended${regTournament.suspension_reason ? `: ${regTournament.suspension_reason}` : ''}`);
  }
  // BEFORE the event's own status, because a finished tournament is the true
  // reason and the more useful sentence. "Registration is closed" on an event
  // still sitting at `registration` inside an archived tournament reads as a
  // bug; nothing here told the member the tournament itself had ended.
  const regClosed = refuseClosedTournament(regTournament?.status, 'enter this event');
  if (regClosed) throw new ExpectedError(regClosed);
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

  if (event.status !== 'registration') throw new ExpectedError('Registration is closed');

  // THE COMPETITION CATEGORY GATE (00111), and the reason it exists at all.
  // event_type has said 'womens_singles' since 00001 with nothing enforcing it,
  // which was survivable while only an exec could put somebody in an event. This
  // action is the path that made it a real hole: the member enters THEMSELVES.
  //
  // STRICTER HERE THAN IN THE CONSOLE, deliberately and in both directions:
  // this refuses an undeclared member, the console does not. Adding somebody by
  // hand is an explicit override by a named exec — the same line the membership
  // gate above draws, in the same words — whereas nobody overrides themselves.
  // The refusal carries the remedy, because a member who cannot act on it will
  // just ask anyway — and since 00129 the remedy differs by branch: an
  // UNDECLARED member is sent to Settings, where the Gender control is still
  // theirs to set, while a MISMATCH is by definition somebody who has already
  // declared and therefore somebody the write-once lock refuses, so they are
  // sent to an exec. Both also get the Open events, which need nobody.
  //
  // Open events reach none of this: screenSelfEntry returns ok for them, which
  // is what keeps an undeclared member playing tournaments.
  const categoryScreen = screenSelfEntry(
    event.event_type as TournamentEventType,
    toCompetitionCategory(player.competition_category),
  );
  if (!categoryScreen.ok) throw new ExpectedError(categoryScreen.message);

  // ---------------------------------------------------------------------
  // ENTERING A DOUBLES EVENT ON YOUR OWN
  // ---------------------------------------------------------------------
  // "i need it to be allowed to join" — the club owner. This used to throw
  // 'Use pair registration for doubles events', which was true because there was
  // no way to be in a doubles event without a partner. Since 00102 there is: the
  // member enters the POOL and an exec pairs them later.
  //
  // SOLO ONLY. Entering as a self-selected pair is deliberately still
  // admin-managed — one member cannot enter another, because that needs the
  // partner's own consent, which needs an invite and an accept and states for
  // both. That is a separate feature and this is not half of it.
  //
  // THE ACKNOWLEDGEMENT IS A HARD GATE, not a tick box the client may skip.
  // Being paired with a stranger is the substance of what is being agreed to
  // here, and a member who finds that out when a partner appears was never
  // asked. Refused server-side so that no client can register somebody who was
  // not shown the sentence.
  const doubles = isDoublesEvent(event.event_type);
  if (doubles && !opts?.soloEntryAcknowledged) {
    throw new ExpectedError(
      'Entering a doubles event on your own means the exec will pair you with another member. ' +
      'Confirm that before you enter.',
    );
  }
  if (doubles && (existingPairRes.data?.length ?? 0) > 0) {
    throw new ExpectedError('You are already in a pair in this event.');
  }

  // A WITHDRAWN ROW IS STILL A ROW, and the insert below would collide with it
  // on UNIQUE(event_id, player_id). Saying "Already registered" to somebody
  // looking at their own withdrawal is the one reading that cannot be right, so
  // the two cases are separated. Re-entry is deliberately NOT an UPDATE here:
  // resurrecting a withdrawn entry is an exec decision with its own fee and cap
  // consequences, and it is already reachable from the console.
  if (existingRes.data) {
    if (existingRes.data.status === 'withdrawn' || existingRes.data.status === 'disqualified') {
      throw new ExpectedError(
        'You have already left this event. Ask a tournament admin if you want to enter it again.',
      );
    }
    throw new ExpectedError('Already registered');
  }

  // Event waiver gate — the tournament may require its own waiver before
  // registering. The client must confirm acceptance; the hash is always taken
  // from the server-side text, never a client-supplied value.
  const eventWaiverText = regTournament?.waiver_text?.trim();
  if (eventWaiverText && !opts?.eventWaiverAccepted) {
    throw new ExpectedError('You must accept the event waiver to register');
  }

  // Capacity check is the only thing that has to wait — it depends on a fresh count.
  //
  // FOR DOUBLES IT IS COUNTED IN DRAW SLOTS: formed pairs, plus one slot per two
  // people still waiting for a partner. max_participants has always meant "how
  // many entries fit" and a doubles entry is a TEAM, so counting participant
  // rows would let forty loose entrants into an event with room for eight teams.
  // The same arithmetic the admin app enforces and the same the /tournaments
  // card shows — one implementation, in @badminton/shared, so the screen cannot
  // promise a place this action then refuses.
  if (event.max_participants) {
    if (doubles) {
      const [unpairedRes, pairsRes] = await Promise.all([
        service.from('tournament_participants').select('player_id, status').eq('event_id', eventId),
        service.from('tournament_pairs').select('player1_id, player2_id, status').eq('event_id', eventId),
      ]);
      // A failed read must not read as "the event is empty" and wave somebody
      // past a full event.
      if (unpairedRes.error || pairsRes.error) {
        throw new Error('Could not check how full this event is. Nothing was changed — try again.');
      }
      const field = countDoublesField(unpairedRes.data ?? [], pairsRes.data ?? []);
      const after = doublesDrawSlots(field.pairs, field.unpaired + 1);
      if (wouldExceedCapacity(field.slots, after, event.max_participants)) {
        throw new ExpectedError('Event is full');
      }
    } else {
      const { count } = await service.from('tournament_participants')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .not('status', 'in', '("withdrawn","disqualified")');
      if (count && count >= event.max_participants) throw new ExpectedError('Event is full');
    }
  }

  // THE PER-MEMBER EVENT CAP (00098). The tournament may limit how many of its
  // events any one member takes; the capacity check above asks whether the
  // EVENT has room, this asks whether the MEMBER has an entry left.
  //
  // The cap rides along on the tournament embed already being read above, so an
  // uncapped tournament — which is every tournament that exists today — pays
  // for nothing extra and does not reach the counting queries at all.
  //
  // Counted across BOTH tables, because this member may already be half of a
  // doubles pair and that pair is not a tournament_participants row. An
  // unpaired doubles entrant DOES have one, and counts once through it — the
  // same single slot they keep when an exec later pairs them.
  const entryCap = pickEntryCap(event.tournament);
  if (entryCap !== null) {
    const counts = await loadTournamentEntryCounts(service, event.tournament_id);
    if (isAtEntryCap(counts.get(player.id) ?? 0, entryCap)) {
      throw new ExpectedError(
        `You are already entered in ${entryCap} ${entryCap === 1 ? 'event' : 'events'} at this tournament, which is the limit. ` +
        // "Withdraw from one" is not advice a member in a formed doubles pair
        // can act on — leaving a pair is an exec action, because it takes
        // somebody else's team away from them. Don't tell them to do something
        // the app will refuse.
        'Withdraw from one to enter another, or ask a tournament admin if one of them is a doubles pair.',
      );
    }
  }

  // NO 400 FALLBACK. elo_before is a snapshot that seeding, the pool display
  // and the legacy undo path all read back as fact, so inventing 400 for a
  // member whose rating row simply failed to load contaminates all three and
  // leaves no trace that it was a guess. A member with no rating row at all is
  // an integrity problem to repair, not a number to make up.
  const eloBefore = doubles ? ratingRes.data?.doubles_elo : ratingRes.data?.singles_elo;
  if (eloBefore == null) {
    Sentry.captureMessage('registerForEvent: no rating row for player', {
      level: 'error',
      tags: { action: 'registerForEvent', playerId: player.id, discipline: doubles ? 'doubles' : 'singles' },
    });
    throw new ExpectedError('Your club rating is not set up yet — contact an exec before entering.');
  }

  const { error: insertErr } = await service.from('tournament_participants').insert({
    event_id: eventId,
    player_id: player.id,
    elo_before: eloBefore,
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

  // NO PARTICIPANT ROW IS NOT THE SAME AS NOT ENTERED, since 00102. A member in
  // a formed doubles pair is entered and has no row here, and 'Not registered'
  // is flatly wrong for them.
  //
  // LEAVING A FORMED PAIR IS AN EXEC ACTION, deliberately. It is not a solo act:
  // it takes another member's team away from them and puts them back in the
  // pool, and that person has to be told. Nothing on the player side can tell
  // them. The exec's withdrawPairMember does the whole thing properly — the
  // partner keeps their fee, their event waiver and their entry-cap slot — and
  // this is the same line the app already draws once a draw is published.
  //
  // Entering alone and changing your mind BEFORE being paired needs none of
  // that, and falls straight through to the ordinary withdrawal below.
  if (!participant) {
    const { data: pair } = await service.from('tournament_pairs')
      .select('id').eq('event_id', eventId)
      .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
      .limit(1);
    if ((pair?.length ?? 0) > 0) {
      throw new ExpectedError(
        'You have been paired with a partner, so leaving is not something you can do on your own — ' +
        'it puts them back in the pool too. Ask a tournament admin to withdraw you.',
      );
    }
    throw new ExpectedError('Not registered');
  }
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
    throw new ExpectedError('Your account is suspended pending a reinstatement fee. Contact an admin to be reinstated.');
  }
  const service = createServiceRoleClient();
  await assertCurrentWaiver(service, player);

  // Parallel reads — event status and player participation row are independent.
  const [eventRes, participantRes] = await Promise.all([
    service.from('tournament_events')
      .select('status, tournament_id, tournament:tournaments(status, suspended_at, suspension_reason)')
      .eq('id', eventId).maybeSingle(),
    service.from('tournament_participants')
      .select('id, status').eq('event_id', eventId).eq('player_id', player.id).maybeSingle(),
  ]);

  const event = eventRes.data;
  const participant = participantRes.data;
  const checkinTournament = event ? pickSuspension(event.tournament) : null;
  if (checkinTournament?.suspended_at) {
    throw new ExpectedError(`This tournament is currently suspended${checkinTournament.suspension_reason ? `: ${checkinTournament.suspension_reason}` : ''}`);
  }
  // Same ordering as registerForEvent, for the same reason.
  const checkinClosed = refuseClosedTournament(checkinTournament?.status, 'check in');
  if (checkinClosed) throw new ExpectedError(checkinClosed);
  // Split so the two halves classify separately. A wrong STATUS is the member
  // arriving before check-in opens or after it closed — a refusal. A MISSING
  // event on a service-role read is a bad id or a row that went away, which is
  // a fault worth reporting. The member sees the same sentence either way.
  if (!event) throw new Error('Check-in is not open');
  if (event.status !== 'checkin') throw new ExpectedError('Check-in is not open');
  if (!participant) throw new ExpectedError('Not registered');
  if (participant.status !== 'registered') throw new ExpectedError('Cannot check in');

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

/**
 * "I'M HERE" — the member telling the desk they are standing courtside and
 * ready to play this match.
 *
 * THE BUG THIS CAME OUT OF. The event page painted the match's status in a
 * bordered uppercase chip in the right-hand slot of the member's own row, so a
 * match at status 'ready' rendered a thing that looked exactly like a READY
 * button. The owner pressed it repeatedly and reported "it has never worked".
 * It was a label. Rather than make the label look less like a button, the club
 * asked for the button — and it turns out to be the thing the scoring table is
 * missing, because today nobody there knows whether the person whose match is
 * up is even in the building.
 *
 * A TOGGLE, WHICH IS THE UNDO. Somebody taps it and then goes to the toilet;
 * they tap it again on the way and the mark comes off. There is no timeout and
 * no expiry — a flag that silently withdrew itself would be worse than one that
 * is occasionally stale, because the desk would have no way to tell the two
 * apart. The other two ways a mark ends are structural rather than actions:
 * every mark is scoped to ONE match, so the next round starts empty; and the
 * marks are on the match row, so regenerating a draw deletes them with it.
 *
 * NOT eventId-SCOPED LIKE ITS NEIGHBOURS. Every other action in this file is
 * given the event and finds the member's row; this one is given the MATCH,
 * because that is what the control is attached to. The tournament and event ids
 * needed for revalidation are read back from it.
 *
 * NO PARTICIPANT LOOKUP HERE, deliberately. Whether this member is in this
 * match is decided by set_match_ready() inside one statement — it has to be,
 * because a doubles entrant may have no tournament_participants row at all
 * (00102) and because a stray id in that array is data nobody can see in order
 * to fix. The gate is not skipped, it has moved somewhere it cannot be raced.
 */
export async function setMyMatchReady(matchId: string, ready: boolean): Promise<ActionResult> {
  return runAction(() => setMyMatchReadyImpl(matchId, ready));
}

async function setMyMatchReadyImpl(matchId: string, ready: boolean) {
  const player = await requirePlayer();
  const service = createServiceRoleClient();

  const { data: match } = await service
    .from('tournament_matches')
    .select('id, event_id, event:tournament_events(tournament_id, tournament:tournaments(suspended_at, suspension_reason))')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  const event = (Array.isArray(match.event) ? match.event[0] : match.event) as
    { tournament_id?: string; tournament?: unknown } | null;
  const tournamentId = event?.tournament_id;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');

  const suspension = pickSuspension(event?.tournament);
  if (suspension?.suspended_at) {
    throw new ExpectedError(
      `This tournament is currently suspended${suspension.suspension_reason ? `: ${suspension.suspension_reason}` : ''}`,
    );
  }

  // p_player_id is ALWAYS requirePlayer()'s id and never a parameter of this
  // action — the same rule every self-service action in this app follows, and
  // the reason set_match_ready's EXECUTE is service_role only. The function
  // takes an arbitrary player id because the console needs to pass somebody
  // else's; nothing reachable from a browser gets to choose it.
  const { error } = await service.rpc('set_match_ready', {
    p_match_id: matchId,
    p_player_id: player.id,
    p_ready: ready,
  });
  // The refusals this can return are sentences an entrant can act on ("This
  // match is finished"), so they go through the expected channel rather than
  // into Sentry as unhandled.
  if (error) throw new ExpectedError(error.message);

  revalidateTournamentPaths(tournamentId, match.event_id as string);
}
