'use server';

import { revalidatePath } from 'next/cache';
import {
  CHECKIN_TOKEN_REGEX,
  ExpectedError,
  screenForEventWaiver,
  type EventWaiverEntry,
  type EventWaiverState,
} from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';
import { assertMyEventWaiverSigned, loadTournamentWaiverContext } from './event-waiver';
import { requirePlayer, assertCurrentWaiver, runAction, type ActionResult } from './actions/_shared';

export interface TournamentCheckInResult {
  tournamentName: string;
  /** Events this scan checked them into, for the confirmation screen. */
  checkedIn: string[];
  /** Events they were already checked into — a second scan is not an error. */
  alreadyIn: string[];
  /**
   * Events the fence REFUSED, with the reason in plain words.
   *
   * This list exists because silence here reads as success. A scan spans
   * several events and each one is a separate fenced call, so a partial
   * refusal is normal: the first event checks in, an officer withdraws them
   * from the second while the loop is still running, and the caller's
   * "did anything land?" test passes on the strength of the first. The member
   * walks away from a screen headed "Checked in" having been refused an event
   * they think they are in, and nobody at the door knows.
   */
  refused: Array<{ event: string; detail: string }>;
  /**
   * Events whose check-in window has not OPENED yet. Reported separately from
   * `refused` on purpose: a tournament runs its events in sequence, so a member
   * entered in a morning and an afternoon event has one of each at the door,
   * and calling the afternoon one a refusal turns the ordinary case into a
   * partial failure. Nothing here needs acting on.
   */
  pending: Array<{ event: string }>;
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

  const rows = await loadMyEntries(service, tokenRow.tournament_id, player.id);

  if (rows.length === 0) {
    throw new ExpectedError('You are not registered for anything in this tournament.');
  }

  const checkedIn: string[] = [];
  const alreadyIn: string[] = [];
  const refused: Array<{ event: string; detail: string }> = [];
  // Events whose check-in has not opened yet. Reported so nothing vanishes
  // from the screen, but NOT as a failure -- see the prefilter below.
  const pending: Array<{ event: string }> = [];
  const toClaim: ScanEntry[] = [];

  for (const row of rows) {
    const label = row.event?.event_type ?? 'Event';
    // Withdrawn or disqualified entries are not re-openable by scanning a code
    // at the door — that is an admin decision.
    //
    // REPORTED, not skipped. Both of these prefilters used to `continue`
    // silently, which is the same defect as dropping an RPC refusal and was
    // missed when that one was fixed: a member with one event checked in and
    // one withdrawn saw a screen headed "Checked in" that never mentioned the
    // second. The all-empty test below cannot save it, because the first entry
    // fills alreadyIn.
    if (row.status === 'withdrawn' || row.status === 'disqualified') {
      refused.push({ event: label, detail: refusalDetail('entry_status') });
      continue;
    }
    if (row.status === 'checked_in') { alreadyIn.push(label); continue; }
    // Only while the event is actually accepting check-in. Registration is too
    // early, and once the bracket exists the field is fixed.
    //
    // TWO UNLIKE THINGS, and collapsing them was an over-correction that
    // codex's round-20 sequence and my own reading both landed on. Event
    // status runs registration -> checkin -> bracket_generated -> live ->
    // completed (00001:682) and a tournament runs its events in sequence, so
    // at any moment most of a member's events are NOT in checkin. Reporting
    // all of them as refusals headed almost every ordinary scan "Partly
    // checked in" -- the same defect as the silent drop, pointed the other
    // way: a screen that misdescribes what happened.
    //
    // `registration` is not open YET and there is nothing to act on; anything
    // past checkin means the window has closed and the desk is the remedy.
    if (row.event?.status !== 'checkin') {
      if (row.event?.status === 'registration') pending.push({ event: label });
      else refused.push({ event: label, detail: refusalDetail('event_closed') });
      continue;
    }
    toClaim.push(row);
  }

  // ---- THE PARTNER'S SIGNATURE ------------------------------------------
  // Only the SCANNER's waiver was asserted above, and for a pair that is half
  // the question. 00102 puts it plainly: check-in is the gate that refuses an
  // entrant with no current acceptance, and it is asked of the thing that
  // takes the court. A team whose partner never signed would be on court
  // having passed the gate as one individual and never as a team — which is
  // the exact hole `checkInPair` closes on the admin side.
  //
  // A REFUSAL, not a hard block, unlike the scanner's own. The scanner can do
  // nothing about their partner's phone while standing at the door, and their
  // singles events are unaffected: refusing the whole scan would turn one
  // unsigned partner into a member who cannot check in to anything.
  await screenPartnerWaivers(service, tokenRow.tournament_id, toClaim, refused);

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
  for (const claim of toClaim) {
    const label = claim.event?.event_type ?? 'Event';
    const { data: outcome, error } = await service.rpc('set_field_entry_status', {
      p_entry_id: claim.id,
      // A DOUBLES ENTRY IS A PAIR ROW, and this was hardcoded false. The fence
      // reads the wrong table for a pair id, finds nothing, and returns
      // entry_not_found — but that was never reached, because the read above
      // only looked at tournament_participants and pairing DELETES those rows
      // (00102). A member in a formed team was told they were registered for
      // nothing at all.
      p_is_pair: claim.isPair,
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
    // already, and saying either would be a lie.
    //
    // It goes in its OWN list rather than being dropped. Dropping it was only
    // safe if every entry was refused -- then the all-empty test below fires --
    // and a scan covers several events, so the common case is that one lands
    // and one is refused and the all-empty test passes on the first.
    refused.push({ event: label, detail: refusalDetail(result?.reason) });
  }

  if (checkedIn.length === 0 && alreadyIn.length === 0) {
    // Nothing landed. Say WHY when the refusals know — the flat sentence below
    // is right for a member who is simply early, and misleading for one whose
    // only entry was withdrawn, which now reaches here rather than vanishing
    // at the prefilter.
    if (refused.length > 0) {
      throw new ExpectedError(
        `You were not checked in: ${refused.map(r => `${r.event} — ${r.detail}`).join('; ')}.`,
      );
    }
    throw new ExpectedError('Check-in is not open for your events yet.');
  }

  revalidatePath(`/tournaments/${tokenRow.tournament_id}`);

  return {
    tournamentName: (tournament.name as string) ?? 'Tournament',
    checkedIn,
    alreadyIn,
    refused,
    pending,
  };
}

/**
 * One thing this member can be checked into: a singles entry, or a pair.
 *
 * `isPair` decides which table the fence reads, and `members` is who has to
 * have signed — one person for a singles entry, both halves for a team.
 */
interface ScanEntry {
  id: string;
  isPair: boolean;
  status: string;
  event: { id: string; event_type: string; status: string } | null;
  members: { id: string; name: string }[];
}

const EVENT_EMBED = 'event:tournament_events!inner(id, event_type, status, tournament_id)';

/**
 * EVERY entry this member holds in the tournament — BOTH tables.
 *
 * Reading only `tournament_participants` was the defect. A doubles entry stops
 * being a participant row the moment a partner is assigned: `pair_tournament_entrants`
 * DELETEs both pool rows and INSERTs one `tournament_pairs` row in the same
 * statement (00102:169-173). So the read returned nothing for exactly the
 * members most likely to be at a tournament — anyone in a formed team — and
 * they were told "You are not registered for anything in this tournament."
 *
 * TWO QUERIES FOR THE PAIRS, not one `.or()`. A pair matches on either
 * `player1_id` or `player2_id`, and whether a PostgREST `or` composes with the
 * `!inner` filter on the embedded event is not something this codebase has
 * proven. A read that comes back malformed arrives as an EMPTY LIST rather
 * than an error, so getting it subtly wrong would ship a fix that reproduces
 * the very bug it closes, silently. Two plain `.eq()` reads cannot.
 */
async function loadMyEntries(
  service: ReturnType<typeof createServiceRoleClient>,
  tournamentId: string,
  playerId: string,
): Promise<ScanEntry[]> {
  // Errors are read on every one of these. A dropped error here reads as
  // "registered for nothing", which is the same sentence the bug produced.
  const { data: singles, error: singlesError } = await service
    .from('tournament_participants')
    .select(`id, status, ${EVENT_EMBED}`)
    .eq('player_id', playerId)
    .eq('tournament_events.tournament_id', tournamentId);
  if (singlesError) throw new Error(singlesError.message);

  const pairSelect =
    `id, status, player1_id, player2_id, ${EVENT_EMBED}, ` +
    'player1:players!tournament_pairs_player1_id_fkey(full_name), ' +
    'player2:players!tournament_pairs_player2_id_fkey(full_name)';
  const pairReads = await Promise.all(
    (['player1_id', 'player2_id'] as const).map((column) =>
      service
        .from('tournament_pairs')
        .select(pairSelect)
        .eq(column, playerId)
        .eq('tournament_events.tournament_id', tournamentId),
    ),
  );

  const pairRows: Record<string, unknown>[] = [];
  for (const { data, error } of pairReads) {
    if (error) throw new Error(error.message);
    pairRows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }

  const entries: ScanEntry[] = ((singles ?? []) as unknown as {
    id: string;
    status: string;
    event: ScanEntry['event'];
  }[]).map((row) => ({
    id: row.id,
    isPair: false,
    status: row.status,
    event: row.event,
    // The scanner is the only member of their own singles entry, and their
    // signature is the hard block above — so this list is never blocking here.
    // It is populated anyway so the two shapes screen through one function.
    members: [{ id: playerId, name: 'You' }],
  }));

  for (const row of pairRows) {
    entries.push({
      id: row.id as string,
      isPair: true,
      status: row.status as string,
      event: (row.event ?? null) as ScanEntry['event'],
      members: [
        { id: row.player1_id as string, name: embeddedName(row.player1) },
        { id: row.player2_id as string, name: embeddedName(row.player2) },
      ],
    });
  }

  // No dedup needed: pairing removes the participant rows, so a member is in
  // one table or the other for any given event, never both.
  return entries;
}

/** PostgREST returns a to-one embed as an object or a one-element array. */
function embeddedName(embed: unknown): string {
  const one = Array.isArray(embed) ? embed[0] : embed;
  return (one as { full_name?: string | null } | null)?.full_name || 'Your partner';
}

/**
 * Move any pair whose partner has not signed out of `toClaim` and into
 * `refused`, with a sentence that names them.
 *
 * MUTATES both lists, which is ugly and is the shape that keeps the refusal
 * next to the other refusals rather than inventing a third outcome list the
 * caller has to remember to render.
 */
async function screenPartnerWaivers(
  service: ReturnType<typeof createServiceRoleClient>,
  tournamentId: string,
  toClaim: ScanEntry[],
  refused: Array<{ event: string; detail: string }>,
): Promise<void> {
  const pairs = toClaim.filter((e) => e.isPair);
  // Nothing to screen, and no reason to pay for the acceptances read on the
  // overwhelmingly common singles-only scan.
  if (pairs.length === 0) return;

  const { requiredHash, acceptances } = await loadTournamentWaiverContext(service, tournamentId);
  if (!requiredHash) return;

  const entries: EventWaiverEntry[] = pairs.map((e) => ({ id: e.id, members: e.members }));
  const { blocked } = screenForEventWaiver(entries, requiredHash, acceptances);
  if (blocked.length === 0) return;

  const byId = new Map(toClaim.map((e) => [e.id, e]));
  for (const block of blocked) {
    const entry = byId.get(block.id);
    refused.push({
      event: entry?.event?.event_type ?? 'Event',
      detail: partnerWaiverDetail(block.unsigned),
    });
  }

  const blockedIds = new Set(blocked.map((b) => b.id));
  for (let i = toClaim.length - 1; i >= 0; i--) {
    if (blockedIds.has(toClaim[i]!.id)) toClaim.splice(i, 1);
  }
}

/**
 * Said to the MEMBER, not to the exec — so it names the partner and says what
 * the partner has to do, rather than sending the reader to the desk for
 * something no one at the desk is allowed to fix. There is deliberately no way
 * for anybody else to record that signature.
 */
function partnerWaiverDetail(
  unsigned: readonly { name: string; state: EventWaiverState }[],
): string {
  const names = unsigned.map((u) => u.name).join(' and ');
  // `stale` and `unsigned` block identically and read differently: one of them
  // signed something and the club moved the text underneath them, and being
  // told they "never signed" would be untrue to their face.
  if (unsigned.every((u) => u.state === 'stale')) {
    return `${names} accepted an earlier version of this tournament’s waiver — the wording has changed since, so it needs accepting again before your team can check in`;
  }
  return `${names} needs to accept this tournament’s event waiver before your team can check in — they can do it on their own phone, from the tournament page`;
}

// The fence's reason codes, said the way somebody standing at a door needs to
// hear them. Deliberately not a lookup that falls through to the raw code: a
// member reading "entry_status" learns nothing, and the desk is who they will
// ask either way.
function refusalDetail(reason: string | undefined): string {
  switch (reason) {
    case 'entry_status':
      return 'you are no longer in this event — see the desk';
    // NOT "not open for this event", which was true of two different
    // situations and actionable in only one. An event that has not opened yet
    // never reaches here -- it goes to `pending`.
    case 'event_closed':
    case 'event_status':
    case 'event_completed':
      return 'check-in has closed for this event — see the desk';
    case 'entry_not_found':
    case 'event_not_found':
      return 'this entry could not be found — see the desk';
    default:
      return 'could not be checked in — see the desk';
  }
}
