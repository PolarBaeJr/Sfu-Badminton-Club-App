'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import {
  calculateTeamRating,
  ensureEntryFees,
  isDoublesEvent,
  eventHasDraw,
  screenForEventWaiver,
  eventWaiverRefusal,
  loadTournamentEntryCounts,
  isAtEntryCap,
  entryCapRefusal,
  doublesDrawSlots,
  countDoublesField,
  wouldExceedCapacity,
  ExpectedError,
} from '@badminton/shared';
import { runAction, type ActionResult } from '../action-result';
import {
  requireCapability,
  revalidateEventPaths,
  extractEventContext,
  participantContextSelect,
  pairContextSelect,
  assertTournamentNotSuspended,
  assertEventWaiverSigned,
  loadTournamentWaiverContext,
  pairWaiverMembers,
  unsignedAmong,
  notifyEventWaiverRequired,
  forfeitOpenMatchesForEntry,
  FORFEIT_REASON,
  type DrawExitStatus,
} from './_internal';

// Supabase returns a to-one embed as object-or-array depending on how it
// inferred the relationship. Unwrap defensively — the whole reason this matters
// is that a name is what the refusal message is FOR.
function pickName(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  return (row as { full_name?: string | null } | null)?.full_name ?? null;
}

/**
 * The tournament's per-member event cap, and how many events each member has
 * already taken — or nulls, when the tournament is uncapped.
 *
 * READS NOTHING WHEN THERE IS NO CAP, which is every tournament that exists
 * today. `max_events_per_player IS NULL` means uncapped, so the counting
 * queries are only paid for by the tournaments that asked for the rule.
 *
 * REFUSES RATHER THAN RETURNING ZERO on a failed read. A swallowed error here
 * reads as "this member has entered nothing", which waves them straight past
 * the cap — the one failure mode a limit must not have. Same reasoning the
 * batch capacity check already applies to its own count.
 */
async function loadEntryCapState(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
): Promise<{ cap: number | null; counts: Map<string, number> }> {
  const { data: tournament, error } = await adminClient
    .from('tournaments')
    .select('max_events_per_player')
    .eq('id', tournamentId)
    .single();
  if (error || !tournament) {
    if (error) Sentry.captureException(error);
    throw new Error('Could not check this tournament’s event limit. Nothing was added — try again.');
  }

  const cap = (tournament as { max_events_per_player: number | null }).max_events_per_player;
  if (cap === null || cap === undefined) return { cap: null, counts: new Map() };

  try {
    return { cap, counts: await loadTournamentEntryCounts(adminClient, tournamentId) };
  } catch (err) {
    Sentry.captureException(err);
    throw new Error('Could not check how many events these players have entered. Nothing was added — try again.');
  }
}

/** The name to put in a cap refusal, without letting a failed lookup mask it. */
async function nameOf(
  adminClient: ReturnType<typeof createAdminClient>,
  playerId: string,
): Promise<string> {
  const { data } = await adminClient.from('players').select('full_name').eq('id', playerId).maybeSingle();
  return (data as { full_name?: string | null } | null)?.full_name ?? 'This player';
}

// ============================================================
// The doubles pool
// ============================================================
// A doubles event holds BOTH kinds of entry at once: tournament_pairs rows for
// teams that have been formed, and tournament_participants rows for people who
// entered without a partner and are waiting to be given one. Pairing PROMOTES
// two of the second into one of the first (migration 00102).
//
// "unpaired", never "pool", in anything that touches brackets.ts —
// `seeded_from_event_id` / buildFieldFromPool already mean something else
// entirely there (seed this draw from another event's standings).

/** The doubles field as it stands right now, in the currency the cap counts. */
async function loadDoublesField(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<{ unpaired: number; pairs: number; slots: number }> {
  const [unpairedRes, pairsRes] = await Promise.all([
    adminClient.from('tournament_participants').select('player_id, status').eq('event_id', eventId),
    adminClient.from('tournament_pairs').select('player1_id, player2_id, status').eq('event_id', eventId),
  ]);
  // A failed read must not read as "the event is empty" — that would wave a
  // whole batch past max_participants in one go, which is the same failure the
  // batch capacity check already refuses to have.
  if (unpairedRes.error || pairsRes.error) {
    Sentry.captureException(unpairedRes.error ?? pairsRes.error);
    throw new Error('Could not check how full this event is. Nothing was added — try again.');
  }
  return countDoublesField(unpairedRes.data ?? [], pairsRes.data ?? []);
}

/** Which of these players are already on a team in this event. */
async function playersAlreadyPaired(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  playerIds: readonly string[],
): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const { data, error } = await adminClient
    .from('tournament_pairs')
    .select('player1_id, player2_id, status')
    .eq('event_id', eventId);
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not check who is already paired in this event. Nothing was added — try again.');
  }
  const wanted = new Set(playerIds);
  const paired = new Set<string>();
  for (const row of data ?? []) {
    // Entries that have LEFT are ignored, exactly as the entry cap ignores
    // them: somebody whose team withdrew is free to enter again.
    if (row.status === 'withdrawn' || row.status === 'disqualified') continue;
    for (const half of [row.player1_id as string, row.player2_id as string]) {
      if (wanted.has(half)) paired.add(half);
    }
  }
  return paired;
}

/** Which of these players are already loose in this event's pool. */
async function playersAlreadyUnpaired(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  playerIds: readonly string[],
): Promise<Set<string>> {
  if (playerIds.length === 0) return new Set();
  const { data, error } = await adminClient
    .from('tournament_participants')
    .select('player_id, status')
    .eq('event_id', eventId)
    .in('player_id', playerIds as string[]);
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not read this event’s entries. Nothing was changed — try again.');
  }
  return new Set(
    (data ?? [])
      .filter((r) => r.status !== 'withdrawn' && r.status !== 'disqualified')
      .map((r) => r.player_id as string),
  );
}

const ALREADY_PAIRED_REFUSAL =
  'is already in a pair in this event. Unpair that team first if they need a different partner.';

// ============================================================
// Singles Participant Management
// ============================================================
// …and, since 00102, SOLO ENTRY INTO A DOUBLES EVENT. Both paths below used to
// throw 'Use addPairToEvent for doubles events' outright, which is what made a
// partnerless entrant impossible. What still cannot happen is a PAIR in a
// singles event — addPairToEvent keeps its own refusal for that.

export async function addParticipantToEvent(eventId: string, playerId: string) {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add participants in current status');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // A DOUBLES EVENT TAKES A SOLO ENTRANT — that is the whole point of the pool.
  // What it must not take is the same person twice, and the second way to be in
  // a doubles event is as half of a team.
  const doubles = isDoublesEvent(event.event_type);
  if (doubles) {
    const paired = await playersAlreadyPaired(adminClient, eventId, [playerId]);
    if (paired.has(playerId)) {
      throw new ExpectedError(`${await nameOf(adminClient, playerId)} ${ALREADY_PAIRED_REFUSAL}`);
    }
  }

  // Check max participants. For doubles that is counted in DRAW SLOTS — formed
  // pairs plus one slot per two loose entrants — because max_participants has
  // always meant "how many entries fit", and a doubles entry is a team. Counting
  // participant rows there would let forty unpaired people into an event with
  // room for eight teams.
  if (event.max_participants) {
    if (doubles) {
      const field = await loadDoublesField(adminClient, eventId);
      const after = doublesDrawSlots(field.pairs, field.unpaired + 1);
      if (wouldExceedCapacity(field.slots, after, event.max_participants)) {
        throw new ExpectedError('Event is full');
      }
    } else {
      const { count } = await adminClient.from('tournament_participants')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .not('status', 'eq', 'withdrawn');
      if (count && count >= event.max_participants) {
        throw new Error('Event is full');
      }
    }
  }

  // THE PER-MEMBER CAP, one level up from the capacity check above: that one
  // asks whether the EVENT has room, this one asks whether the PLAYER has any
  // entries left at this tournament. Both sit before the insert, for the same
  // reason — a refusal must leave no trace of an entry that did not happen.
  const { cap, counts } = await loadEntryCapState(adminClient, event.tournament_id);
  if (cap !== null && isAtEntryCap(counts.get(playerId) ?? 0, cap)) {
    throw new ExpectedError(entryCapRefusal(await nameOf(adminClient, playerId), cap));
  }

  // Get or create player's ratings record
  let { data: rating } = await adminClient.from('ratings').select('singles_elo, doubles_elo').eq('player_id', playerId).maybeSingle();
  if (!rating) {
    // Player has no ratings record — create one with defaults
    const { data: newRating } = await adminClient.from('ratings').insert({
      player_id: playerId,
      singles_elo: 400,
      doubles_elo: 400,
      singles_provisional: true,
      doubles_provisional: true,
      singles_k_factor: 40,
      doubles_k_factor: 40,
    }).select('singles_elo, doubles_elo').single();
    rating = newRating;
  }

  // THE DISCIPLINE'S OWN RATING. elo_before was hardcoded to singles_elo, which
  // was right while only singles produced participant rows. A solo entrant in a
  // doubles event is rated on doubles_elo — it is the number the pool's Elo
  // column shows, and the number the team they end up in would be built from.
  const eloBefore = (doubles ? rating?.doubles_elo : rating?.singles_elo) ?? 400;

  const { data, error } = await adminClient.from('tournament_participants').insert({
    event_id: eventId,
    player_id: playerId,
    elo_before: eloBefore,
    added_by: admin.id,
  }).select().single();

  if (error) {
    if (error.code === '23505') throw new Error('Player already registered for this event');
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // What this entry costs, on the club's fee ledger. One row per tournament
  // rather than per event, so adding somebody to a second event here finds the
  // row the first one made. Never throws — see ensureEntryFees — because the
  // participant is already committed and an incomplete price list must not
  // report a registration that happened as a failure.
  await ensureEntryFees(adminClient, event.tournament_id, [playerId]);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'participant_added',
    performed_by: admin.id,
    details: { player_id: playerId },
  });

  // BEING ADDED PUSHES THE SIGNATURE AT THEM. Adding still succeeds — the
  // walk-up on the day is exactly why it must — but somebody an exec put on the
  // sheet was never asked for the event waiver, and this is where they are.
  // After the insert and after the audit row, because none of those may be lost
  // to a notification failure.
  const { unsigned, tournamentName } = await unsignedAmong(adminClient, event.tournament_id, [playerId]);
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, eventId);
  return data;
}

/** What the batch add reports back, per player, for the ones it could not take. */
export interface BatchAddFailure {
  id: string;
  message: string;
}

/**
 * Add a whole selection of players in ONE request.
 *
 * Why this exists rather than looping addParticipantToEvent: the loop was
 * sequential, and each pass paid for a full server action — authenticate, read
 * the event, check the tournament, read a rating, insert, write an audit row —
 * and then called revalidatePath, which makes the App Router re-render the event
 * page and ship the new RSC tree back in the response. Sixty players meant sixty
 * round trips to the Pi and sixty renders of a page that queries every
 * participant, pair and match in the event. Seeding a 128-slot draw took long
 * enough to look broken.
 *
 * Everything that does not depend on WHICH player is now done once, the inserts
 * go in a single statement, and the page is revalidated once at the end.
 *
 * The per-player action stays: it is still the honest shape for adding one
 * person, and other callers use it.
 */
export async function addParticipantsToEvent(eventId: string, playerIds: string[]) {
  const admin = await requireCapability('tournaments.draw.participants.add.write');
  const adminClient = createAdminClient();

  // Deduplicate but KEEP the caller's order. Order is not cosmetic here: when
  // the event fills mid-batch, the people who get in are the first ones the exec
  // picked, which is the same answer the sequential loop gave.
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return { added: [] as string[], failures: [] as BatchAddFailure[] };

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add participants in current status');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // Solo entry into a doubles event, same as the per-player path above.
  const doubles = isDoublesEvent(event.event_type);

  const failures: BatchAddFailure[] = [];

  // Already registered, in one read. The per-player path leaned on the unique
  // violation (23505) coming back from its own insert, which cannot work for a
  // batch: one duplicate would fail the whole statement and take 59 innocent
  // rows with it. The unique index still guards the race — see below — this
  // read is what turns the common case into a per-player message.
  const { data: existing } = await adminClient
    .from('tournament_participants')
    .select('player_id')
    .eq('event_id', eventId)
    .in('player_id', ids);
  const alreadyIn = new Set((existing ?? []).map((r) => r.player_id as string));

  let candidates = ids.filter((id) => {
    if (alreadyIn.has(id)) {
      failures.push({ id, message: 'Player already registered for this event' });
      return false;
    }
    return true;
  });

  // The OTHER way to already be in a doubles event: on a team. Partitioned per
  // player rather than refusing the batch, like every other check here.
  if (doubles && candidates.length > 0) {
    const paired = await playersAlreadyPaired(adminClient, eventId, candidates);
    candidates = candidates.filter((id) => {
      if (paired.has(id)) {
        failures.push({ id, message: `This player ${ALREADY_PAIRED_REFUSAL}` });
        return false;
      }
      return true;
    });
  }

  // Capacity, counted once against the WHOLE batch rather than re-read per
  // player. Everyone past the line is refused with the same sentence the
  // sequential path used, so a partial add still reads the same way.
  // Every read below is checked. In a per-player loop a swallowed error costs one
  // player; here the same swallow applies the wrong answer to the whole
  // selection, so "the query failed" must not be allowed to read as "the number
  // is zero" or "nobody has a rating".
  if (event.max_participants) {
    let room: number;
    if (doubles) {
      // In DRAW SLOTS, as the per-player path explains. `ceil((u + k) / 2)` must
      // fit in what is left after the formed pairs, so k is bounded by
      // `2 * (max - pairs) - u` exactly — no search, no off-by-one.
      const field = await loadDoublesField(adminClient, eventId);
      room = Math.max(Math.max(event.max_participants - field.pairs, 0) * 2 - field.unpaired, 0);
    } else {
      const { count, error: countError } = await adminClient.from('tournament_participants')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .not('status', 'eq', 'withdrawn');
      // A failed count reads as null, and `max - 0` is the FULL cap: the batch
      // would then be waved past a nearly full event in one go.
      if (countError || count === null) {
        if (countError) Sentry.captureException(countError);
        throw new Error('Could not check how full this event is. Nothing was added — try again.');
      }
      room = Math.max(event.max_participants - count, 0);
    }
    if (candidates.length > room) {
      for (const id of candidates.slice(room)) failures.push({ id, message: 'Event is full' });
      candidates = candidates.slice(0, room);
    }
  }

  // THE PER-MEMBER CAP — PARTITION, exactly as the two checks above do, because
  // a batch that refused whole because one person was at their limit would make
  // the exec pick the other fifty-nine again by hand. Nothing half-applies: the
  // refusals are decided here, before the single insert, and reported per
  // player alongside "already registered" and "Event is full".
  //
  // DELIBERATELY NOT A `room`/slice() CUTOFF like max_participants above.
  // That cap is a SHARED POOL — the event has N places and the first N in the
  // exec's order win, so order decides who gets in. This cap is a PER-PERSON
  // ALLOWANCE: each candidate is adding exactly one event to their own count,
  // so each is independently either at their limit or not, and one person being
  // at theirs must not cost the next person in the list their place. Written as
  // a slice it would refuse an arbitrary tail of innocent players.
  if (candidates.length > 0) {
    const { cap, counts } = await loadEntryCapState(adminClient, event.tournament_id);
    if (cap !== null) {
      candidates = candidates.filter((id) => {
        if (isAtEntryCap(counts.get(id) ?? 0, cap)) {
          // Keyed by player id, so the caller already knows who this is —
          // hence no name, matching the other two failure messages here.
          failures.push({
            id,
            message: `Already entered in ${cap} ${cap === 1 ? 'event' : 'events'} at this tournament, which is the limit.`,
          });
          return false;
        }
        return true;
      });
    }
  }

  if (candidates.length === 0) return { added: [], failures };

  // elo_before is stamped at registration, so every candidate needs a rating —
  // and it is the DISCIPLINE'S rating. See the per-player path: a solo entrant
  // in a doubles event is stamped with doubles_elo.
  const eloColumn = doubles ? 'doubles_elo' : 'singles_elo';
  const { data: ratingRows, error: ratingsReadError } = await adminClient
    .from('ratings')
    .select(`player_id, ${eloColumn}`)
    .in('player_id', candidates);
  if (ratingsReadError) {
    Sentry.captureException(ratingsReadError);
    throw new Error('Could not read player ratings. Nothing was added — try again.');
  }
  const eloByPlayer = new Map<string, number>(
    (ratingRows ?? []).map((r) => [
      (r as Record<string, unknown>).player_id as string,
      (r as Record<string, unknown>)[eloColumn] as number,
    ]),
  );

  // Same defaults as the single-player path, deliberately including the k_factor
  // values that differ from the column defaults — this is a copy of existing
  // behaviour, not a place to correct it.
  const missing = candidates.filter((id) => !eloByPlayer.has(id));
  if (missing.length > 0) {
    // upsert, not insert: ratings.player_id is unique, and somebody registering
    // the same player elsewhere between the read above and this write would
    // otherwise raise 23505 and reject the ratings for all sixty.
    const { error: ratingsWriteError } = await adminClient.from('ratings').upsert(
      missing.map((id) => ({
        player_id: id,
        singles_elo: 400,
        doubles_elo: 400,
        singles_provisional: true,
        doubles_provisional: true,
        singles_k_factor: 40,
        doubles_k_factor: 40,
      })),
      { onConflict: 'player_id', ignoreDuplicates: true },
    );
    if (ratingsWriteError) {
      Sentry.captureException(ratingsWriteError);
      throw new Error('Could not create ratings for these players. Nothing was added — try again.');
    }

    // Read back rather than trusting what was written: ignoreDuplicates returns
    // nothing for a row that already existed, and that row's real Elo is the one
    // that belongs in elo_before.
    const { data: filled, error: refetchError } = await adminClient
      .from('ratings')
      .select(`player_id, ${eloColumn}`)
      .in('player_id', missing);
    if (refetchError) {
      Sentry.captureException(refetchError);
      throw new Error('Could not read the ratings that were just created. Nothing was added — try again.');
    }
    for (const r of filled ?? []) {
      const row = r as Record<string, unknown>;
      eloByPlayer.set(row.player_id as string, row[eloColumn] as number);
    }
  }

  // Refuse rather than fall back to 400. A participant stamped with a made-up
  // elo_before and no ratings row registers cleanly and then fails at the point
  // somebody tries to score their match, which is the worst possible moment to
  // find out.
  const unrated = candidates.filter((id) => !eloByPlayer.has(id));
  if (unrated.length > 0) {
    throw new Error(
      `${unrated.length} of these players still have no rating record. Nothing was added — try again.`,
    );
  }

  const { data: inserted, error } = await adminClient.from('tournament_participants').insert(
    candidates.map((id) => ({
      event_id: eventId,
      player_id: id,
      elo_before: eloByPlayer.get(id) ?? 400,
      added_by: admin.id,
    })),
  ).select();

  if (error) {
    // A duplicate here means somebody else registered one of these players
    // between the read above and this insert. Nothing landed, so say so plainly
    // rather than reporting a partial success that did not happen.
    if (error.code === '23505') {
      throw new ExpectedError(
        'Someone was registered while this was being submitted, so nothing was added. Try again.',
      );
    }
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const added = (inserted ?? []).map((r) => r.player_id as string);

  // Entry fees for everyone who actually landed, in one call. Priced from each
  // player's own membership_type, so a batch of internal members and alumni
  // comes out at two different amounts without anybody choosing a tier.
  if (added.length > 0) await ensureEntryFees(adminClient, event.tournament_id, added);

  // One row per player, same shape as the single-player path writes, in one
  // statement. Collapsing the batch into a single row with a list would change
  // what `details.player_id` means for everything that reads this table.
  //
  // Reported but NOT thrown: the participants are already committed, so failing
  // the action here would tell the exec nothing was added when sixty people
  // were. A missing audit row is a real loss, which is why it goes to Sentry
  // rather than nowhere — one bad statement now costs the whole batch's trail,
  // not one row's.
  if (added.length > 0) {
    const { error: auditError } = await adminClient.from('tournament_audit_log').insert(
      added.map((id) => ({
        tournament_id: event.tournament_id,
        event_id: eventId,
        match_id: null,
        action: 'participant_added',
        performed_by: admin.id,
        details: { player_id: id },
      })),
    );
    if (auditError) Sentry.captureException(auditError);
  }

  // One read and ONE insert for the whole batch, not sixty of each — the same
  // reason this action exists at all. Only the entrants who actually landed and
  // who do not already have a current acceptance are told.
  const { unsigned, tournamentName } = await unsignedAmong(adminClient, event.tournament_id, added);
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, eventId);
  return { added, failures };
}

export async function removeParticipantFromEvent(participantId: string) {
  const admin = await requireCapability('tournaments.draw.participants.remove.write');
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('*, event:tournament_events(*)')
    .eq('id', participantId)
    .single();
  if (!participant) throw new Error('Participant not found');

  const event = participant.event as Record<string, unknown>;
  if (event.status !== 'registration') {
    throw new Error('Cannot remove participants after registration closes');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  const { error } = await adminClient.from('tournament_participants').delete().eq('id', participantId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: participant.event_id,
    action: 'participant_removed',
    performed_by: admin.id,
    details: { player_id: participant.player_id },
  });

  revalidateEventPaths(event.tournament_id as string, participant.event_id as string);
}

export async function checkInParticipant(participantId: string): Promise<ActionResult> {
  return runAction(() => checkInParticipantImpl(participantId));
}

async function checkInParticipantImpl(participantId: string) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select(`${participantContextSelect}, player_id, player:players!player_id(full_name)`)
    .eq('id', participantId)
    .single();

  // Refuse BEFORE writing rather than pressing on without it. This context is
  // what names the paths to revalidate, and the page no longer calls
  // router.refresh() as a second chance — so a check-in that reached here
  // without it would update the row and leave the desk staring at a screen that
  // still says the player is waiting.
  const participantCtx = extractEventContext(participant);
  if (!participantCtx) throw new Error('Could not read this participant. Nothing was changed — try again.');
  await assertTournamentNotSuspended(adminClient, participantCtx.tid);

  // THE HARD BLOCK. Adding somebody stays permissive; taking part does not.
  // Deliberately BEFORE the update, so a refused check-in leaves no trace of a
  // check-in that did not happen.
  await assertEventWaiverSigned(adminClient, participantCtx.tid, {
    id: participantId,
    members: [{
      id: participant!.player_id as string,
      name: pickName(participant!.player) ?? 'This player',
    }],
  });

  const { error } = await adminClient.from('tournament_participants')
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: admin.id,
    })
    .eq('id', participantId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  revalidateEventPaths(participantCtx.tid, participantCtx.eventId);
}

export async function markParticipantNoShow(participantId: string) {
  await requireCapability('tournaments.draw.noshow.write');
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_participants')
    .update({ status: 'no_show' })
    .eq('id', participantId)
    .select(participantContextSelect)
    .single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  // The row is already updated, so this cannot report a failure — but it must
  // not report a plain success either. Without the context there is nothing to
  // revalidate, and since these screens stopped calling router.refresh() a
  // silent skip leaves the desk looking at a board that still says the player is
  // waiting. Say what happened and tell them to reload.
  const ctx = extractEventContext(data);
  if (!ctx) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable — page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(ctx.tid, ctx.eventId);
}

// ============================================================
// Taking an entry OUT of the event
// ============================================================
// Withdrawal and disqualification are the same operation with different
// paperwork: the entry stops being part of the event. Once a draw exists that
// has to reach the bracket as well, because bracket generation only ever saw a
// point-in-time snapshot of who was in — leave it at a status change and the
// entry stays seeded, their match stays READY, and someone turns up to play a
// player who is not coming.

export interface DrawExitResult {
  /** Matches forfeited to an opponent right now. */
  forfeited: number;
  /**
   * Matches whose opposing slot is still TBD. They are settled automatically
   * the moment the feeder match resolves.
   */
  unresolved: number;
  /**
   * The draw exists but the event has not started, so nothing was forfeited.
   * Regenerating the bracket is the cleaner fix at this stage; failing that,
   * going live sweeps them.
   */
  deferredToGoLive: boolean;
}

async function exitDrawImpl(
  entryId: string,
  isPair: boolean,
  status: DrawExitStatus,
  reason?: string,
): Promise<DrawExitResult> {
  const admin = await requireCapability('tournaments.draw.exit.write');
  const adminClient = createAdminClient();

  const table = isPair ? 'tournament_pairs' : 'tournament_participants';
  const { data: entry } = await adminClient.from(table)
    .select('id, status, event_id, event:tournament_events(id, status, event_type, tournament_id)')
    .eq('id', entryId)
    .maybeSingle();
  if (!entry) throw new ExpectedError('Entry not found');

  const event = (Array.isArray(entry.event) ? entry.event[0] : entry.event) as {
    id: string; status: string; event_type: string; tournament_id: string;
  } | null;
  if (!event) throw new ExpectedError('Entry is not attached to an event');

  // A finished event's results and Elo are already settled. Pulling someone out
  // now would forfeit nothing and only contradict the standings.
  if (event.status === 'completed') {
    throw new ExpectedError('This event is finished — void the affected matches instead.');
  }
  // A repeat press is normally nothing to do — but on a live event it is also
  // the only way to finish a forfeit cascade that stopped partway, and that is
  // now reachable: applyTournamentMatchElo raises a failed rating write instead
  // of swallowing it, so an entry can end up marked withdrawn with some of its
  // matches still open. The status is written before the cascade runs, so the
  // old unconditional guard would have refused the very retry that fixes it —
  // the same trap finalizeEvent used to set.
  //
  // Forfeiting only ever touches matches that are still open, so re-running it
  // is idempotent. If there was genuinely nothing left, the original refusal
  // still stands (below, once we know).
  const alreadyOut = entry.status === status;
  if (alreadyOut && event.status !== 'live') {
    throw new ExpectedError(status === 'withdrawn' ? 'Already withdrawn.' : 'Already disqualified.');
  }

  if (!alreadyOut) {
    const { error } = await adminClient.from(table)
      .update({ status, notes: reason ?? null })
      .eq('id', entryId);
    if (error) {
      Sentry.captureException(error);
      throw new Error(error.message);
    }
  }

  // Only a live event gets its matches forfeited. Between bracket generation
  // and the first serve nothing has been played: a walkover there could not be
  // rated, and recording one counts as a result, which would block the admin
  // from simply regenerating the draw without this entry. setEventStatus
  // sweeps whatever is still outstanding when the event goes live.
  let outcome: DrawExitResult = {
    forfeited: 0,
    unresolved: 0,
    deferredToGoLive: eventHasDraw(event.status),
  };
  if (event.status === 'live') {
    outcome = {
      ...await forfeitOpenMatchesForEntry(
        adminClient, event.id, entryId, isPair, FORFEIT_REASON[status], admin.id,
      ),
      deferredToGoLive: false,
    };
  }

  // Nothing was left over after all — so this really was just a second press,
  // and it gets the answer it always got.
  if (alreadyOut && outcome.forfeited === 0) {
    throw new ExpectedError(status === 'withdrawn' ? 'Already withdrawn.' : 'Already disqualified.');
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: status === 'withdrawn' ? 'participant_withdrawn' : 'participant_disqualified',
    performed_by: admin.id,
    details: { entry_id: entryId, is_pair: isPair, reason: reason ?? null, ...outcome },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  return outcome;
}

// These return ActionResult rather than throwing: Next.js redacts errors thrown
// out of a Server Action in production, so "This event is finished" would reach
// the exec as an opaque banner. Same contract the result actions already use.
export async function withdrawParticipant(participantId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(participantId, false, 'withdrawn', reason));
}

export async function disqualifyParticipant(participantId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(participantId, false, 'disqualified', reason));
}

export async function withdrawPair(pairId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(pairId, true, 'withdrawn', reason));
}

export async function disqualifyPair(pairId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(pairId, true, 'disqualified', reason));
}

// ============================================================
// Doubles Pair Management
// ============================================================

/**
 * Add a doubles pair.
 *
 * RETURNS ActionResult RATHER THAN THROWING, for the reason the withdraw and
 * check-in actions in this file already give: Next.js redacts an error thrown
 * out of a Server Action in production, so every refusal below — "Event is
 * full", "Draw is locked", and above all the entry-cap refusal that NAMES THE
 * HALF AT FAULT — would reach the exec as an opaque banner. A refusal whose
 * reason is redacted is a refusal the exec cannot act on, and naming the player
 * is the entire point of that message.
 */
export async function addPairToEvent(
  eventId: string,
  player1Id: string,
  player2Id: string,
): Promise<ActionResult<unknown>> {
  return runAction(() => addPairToEventImpl(eventId, player1Id, player2Id));
}

async function addPairToEventImpl(eventId: string, player1Id: string, player2Id: string) {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add pairs in current status');
  }

  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  if (!isDoublesEvent(event.event_type)) {
    throw new Error('Use addParticipantToEvent for singles events');
  }

  if (player1Id === player2Id) throw new ExpectedError('A pair needs two different players.');

  // WHO IS ALREADY WHERE, because since 00102 either half may already be in
  // this event as an unpaired entrant — and forming their team is then a
  // PROMOTION, not a new entry. Everything below has to know which it is: a
  // promotion spends no new cap slot, occupies no new draw slot and is already
  // invoiced.
  const [alreadyPaired, alreadyUnpaired] = await Promise.all([
    playersAlreadyPaired(adminClient, eventId, [player1Id, player2Id]),
    playersAlreadyUnpaired(adminClient, eventId, [player1Id, player2Id]),
  ]);

  // Get both players' Elo and names
  const { data: ratings } = await adminClient.from('ratings')
    .select('player_id, doubles_elo')
    .in('player_id', [player1Id, player2Id]);

  const { data: players } = await adminClient.from('players')
    .select('id, full_name')
    .in('id', [player1Id, player2Id]);
  const nameFor = (id: string) => players?.find((p) => p.id === id)?.full_name ?? 'This player';

  // Refused here as well as inside the RPC, so the exec gets a sentence with a
  // NAME in it rather than the database's own wording.
  for (const half of [player1Id, player2Id]) {
    if (alreadyPaired.has(half)) {
      throw new ExpectedError(`${nameFor(half)} ${ALREADY_PAIRED_REFUSAL}`);
    }
  }

  // Capacity, in draw slots. PROMOTION IS SLOT-NEUTRAL by construction — two
  // loose entrants were already worth one prospective team — so pairing up an
  // event that is exactly full still works, which is the whole point of letting
  // people enter alone. See doublesDrawSlots.
  if (event.max_participants) {
    const field = await loadDoublesField(adminClient, eventId);
    const promoted = [player1Id, player2Id].filter((id) => alreadyUnpaired.has(id)).length;
    const after = doublesDrawSlots(field.pairs + 1, field.unpaired - promoted);
    if (wouldExceedCapacity(field.slots, after, event.max_participants)) {
      throw new ExpectedError('Event is full');
    }
  }

  // THE PER-MEMBER CAP, FOR BOTH HALVES. A pair is two entrants who happen to
  // play together — this row spends one of each player's allowance — so EITHER
  // of them being at their limit refuses the whole pair. There is no half-entry
  // to fall back to: a doubles event needs two people.
  //
  // The refusal NAMES THE HALF AT FAULT. "This pair is at the limit" tells the
  // exec the team is broken but not whose entries to go and look at, and with
  // the partner standing right there that is the difference between a two-second
  // fix and a support question. Checked before the insert, and before the fee
  // rows and waiver notices below, so a refused pair leaves nothing behind.
  //
  // THE PROMOTION IS DISCOUNTED. countEventEntriesPerPlayer already counts an
  // unpaired entrant's row, and this pair CONSUMES that row rather than adding
  // to it. Without the subtraction, pairing two people who each entered alone
  // at a tournament capped to one event would be refused for being at a limit
  // the operation does not move.
  const { cap, counts } = await loadEntryCapState(adminClient, event.tournament_id);
  if (cap !== null) {
    for (const half of [player1Id, player2Id]) {
      const spent = (counts.get(half) ?? 0) - (alreadyUnpaired.has(half) ? 1 : 0);
      if (isAtEntryCap(spent, cap)) {
        throw new ExpectedError(entryCapRefusal(nameFor(half), cap));
      }
    }
  }

  const p1Rating = ratings?.find(r => r.player_id === player1Id)?.doubles_elo ?? 400;
  const p2Rating = ratings?.find(r => r.player_id === player2Id)?.doubles_elo ?? 400;
  const combinedElo = calculateTeamRating([p1Rating, p2Rating]);

  const p1Name = players?.find(p => p.id === player1Id)?.full_name ?? '';
  const p2Name = players?.find(p => p.id === player2Id)?.full_name ?? '';

  // ONE TRANSACTION: the pair is written and both halves leave the unpaired
  // pool together, or neither happens. From here that could only be a delete
  // and an insert over two PostgREST round trips, and a failure between them
  // leaves somebody counted twice by the entry cap — in the draw AND in the
  // pool — or strips two entries that were paid for. See migration 00102.
  //
  // The arithmetic stays out of the database, per 00070: combined_elo is
  // calculateTeamRating's answer and the name is joined here, so there is only
  // ever one implementation of either.
  const { data: newPairId, error } = await adminClient.rpc('pair_tournament_entrants', {
    p_event_id: eventId,
    p_player1_id: player1Id,
    p_player2_id: player2Id,
    p_pair_name: `${p1Name} / ${p2Name}`,
    p_combined_elo: combinedElo,
    p_added_by: admin.id,
  });

  if (error) {
    if (error.code === '23505') throw new ExpectedError('This pair is already registered');
    // The function raises its own refusals with real messages — "already in a
    // pair", "already left this event", "not a doubles event" — so they are
    // passed through rather than replaced with something vaguer.
    if (error.code === '23514' || error.code === '02000') throw new ExpectedError(error.message);
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const { data } = await adminClient.from('tournament_pairs').select().eq('id', newPairId as string).maybeSingle();

  // BOTH HALVES OF THE PAIR, each priced off their own membership_type. A pair
  // is two entrants who happen to play together, not one; an internal member
  // partnering an alum pays the internal price and the alum pays theirs.
  //
  // A PROMOTED HALF IS NOT INVOICED TWICE, and not because of a check here:
  // club_fees_tournament_player_key (00094) keys the row on
  // (tournament_id, player_id), so the row their solo entry created IS the row
  // this call would write, and ensureEntryFees skips everyone who already has
  // one. Double-invoicing a promoted entrant is not something this code avoids;
  // it is something the schema makes unreachable.
  await ensureEntryFees(adminClient, event.tournament_id, [player1Id, player2Id]);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'pair_added',
    performed_by: admin.id,
    // `promoted_from_pool` is how the trail distinguishes "an exec entered a
    // team" from "two people who had entered alone were put together" — the
    // same row either way, and a different thing to have happened.
    details: {
      player1_id: player1Id,
      player2_id: player2Id,
      promoted_from_pool: [player1Id, player2Id].filter((id) => alreadyUnpaired.has(id)),
    },
  });

  // BOTH HALVES ARE TOLD, and each is asked for their own signature — because
  // the pair cannot be checked in until both have one. A pair is the population
  // this feature was built for: the player app's registration dialog returns
  // early for doubles and never shows the waiver at all, so before this change
  // NO doubles entrant had ever been asked, in any tournament.
  const { unsigned, tournamentName } = await unsignedAmong(
    adminClient, event.tournament_id, [player1Id, player2Id],
  );
  await notifyEventWaiverRequired(adminClient, event.tournament_id, tournamentName, unsigned);

  revalidateEventPaths(event.tournament_id, eventId);
  return data;
}

// ============================================================
// Taking a team APART — the two ways out that are not "remove"
// ============================================================
// Three different things an exec might mean by "this pair is wrong", and they
// are deliberately three actions rather than one:
//
//   removePairFromEvent  — the team should never have been entered. The row is
//                          deleted and nobody is left in the event.
//   unpairEntry          — the two PEOPLE belong here, this TEAM does not.
//                          Both return to the unpaired pool and can be paired
//                          with somebody else.
//   withdrawPairMember   — one half has pulled out. The leaver is marked
//                          withdrawn; the partner returns to the pool.
//
// Both of the new ones are the same two writes in the opposite order to
// pairing (delete a pair, insert two participants) and carry the same hazard,
// so both go through unpair_tournament_pair (00102) and are atomic for the same
// reason.

/** What the caller is told back, so the toast can name the pool. */
export interface UnpairResult {
  /** The two members now loose in the pool — or one, when the other withdrew. */
  returned: number;
  withdrawnName: string | null;
}

export async function unpairEntry(pairId: string): Promise<ActionResult<UnpairResult>> {
  return runAction(() => splitPairImpl(pairId, null, undefined));
}

/**
 * ONE HALF OF A FORMED PAIR PULLS OUT.
 *
 * The club owner has ruled that withdrawing does not refund. So the partner who
 * is left has already paid the tournament's entry fee, has already accepted its
 * event waiver, and is already spending one of their allowed entries — and none
 * of those three came from having a partner. Deleting their entry because
 * somebody else bailed would take all three away and punish the wrong person.
 * They drop back into the unpaired pool instead, keeping every one of them, and
 * can be given a different partner. That is the whole point of the pool.
 *
 * The leaver keeps a 'withdrawn' row rather than disappearing: it is what makes
 * "no refund" legible next to their fee, and it releases their own entry-cap
 * slot exactly as any other withdrawal does.
 *
 * ONLY BEFORE THE DRAW. Once the pair is seeded, splitting it up is not
 * something the database will do — tournament_matches.pair_a_id and its three
 * siblings REFERENCE tournament_pairs(id) with no ON DELETE action, so the
 * delete raises a foreign-key violation. At that point the coherent exit is
 * withdrawing the WHOLE pair, which forfeits its matches to its opponents and
 * is what withdrawPair already does.
 */
export async function withdrawPairMember(
  pairId: string,
  playerId: string,
  reason?: string,
): Promise<ActionResult<UnpairResult>> {
  return runAction(() => splitPairImpl(pairId, playerId, reason));
}

async function splitPairImpl(
  pairId: string,
  withdrawnPlayerId: string | null,
  reason: string | undefined,
): Promise<UnpairResult> {
  // TWO DIFFERENT CAPABILITIES FOR ONE FUNCTION, chosen by what is being asked
  // for. Unpairing destroys a pair row and creates nothing that is not already
  // in the event, which is `pairs.remove.write`. Withdrawing a member takes
  // somebody OUT of the event, which is `exit.write` — the same key the other
  // three withdrawal actions in this file ask for. Handing one to a holder of
  // the other would be a hole in whichever they do not hold.
  const admin = withdrawnPlayerId
    ? await requireCapability('tournaments.draw.exit.write')
    : await requireCapability('tournaments.draw.pairs.remove.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('id, event_id, player1_id, player2_id, event:tournament_events(id, status, tournament_id, draw_locked), player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
    .eq('id', pairId)
    .maybeSingle();
  if (!pair) throw new ExpectedError('Pair not found');

  const event = (Array.isArray(pair.event) ? pair.event[0] : pair.event) as {
    id: string; status: string; tournament_id: string; draw_locked: boolean;
  } | null;
  if (!event) throw new ExpectedError('Pair is not attached to an event');

  if (withdrawnPlayerId && withdrawnPlayerId !== pair.player1_id && withdrawnPlayerId !== pair.player2_id) {
    throw new ExpectedError('That player is not in this pair.');
  }

  // Same window pairing has: while the entry list is still being assembled.
  // `bracket_generated` and everything after is refused by the function too, on
  // the stronger test of whether the pair is actually in a match.
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError(
      withdrawnPlayerId
        ? 'The draw already exists, so this pair cannot be split up. Withdraw the whole pair instead — their matches are forfeited to their opponents.'
        : 'Pairs can only be split up while the event is still taking entries.',
    );
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const { error } = await adminClient.rpc('unpair_tournament_pair', {
    p_pair_id: pairId,
    p_withdrawn_player_id: withdrawnPlayerId,
    p_reason: reason ?? null,
    p_added_by: admin.id,
  });
  if (error) {
    // The function's own refusals are sentences an exec can act on — "already
    // in the draw", "already left the event" — so they are passed through.
    if (error.code === '23503' || error.code === '23514' || error.code === '02000') {
      throw new ExpectedError(error.message);
    }
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const nameOfHalf = (id: string) =>
    pickName(id === pair.player1_id ? pair.player1 : pair.player2) ?? 'This player';

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: withdrawnPlayerId ? 'participant_withdrawn' : 'pair_unpaired',
    performed_by: admin.id,
    details: {
      pair_id: pairId,
      player1_id: pair.player1_id,
      player2_id: pair.player2_id,
      withdrawn_player_id: withdrawnPlayerId,
      reason: reason ?? null,
    },
  });

  // NO FEE IS TOUCHED, in either direction. ensureEntryFees is not called
  // because both members already have their one row for this tournament, and
  // nothing is refunded because the club owner has ruled that a withdrawal does
  // not refund. Nor is the event-waiver acceptance touched: it is per member per
  // TOURNAMENT and was never a fact about who they were playing with.
  revalidateEventPaths(event.tournament_id, event.id);
  // Both rows exist either way; only one of them is still IN the event when a
  // member withdrew, and that is the number the toast should say.
  return {
    returned: withdrawnPlayerId ? 1 : 2,
    withdrawnName: withdrawnPlayerId ? nameOfHalf(withdrawnPlayerId) : null,
  };
}

export async function removePairFromEvent(pairId: string) {
  const admin = await requireCapability('tournaments.draw.pairs.remove.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('*, event:tournament_events(*)')
    .eq('id', pairId)
    .single();
  if (!pair) throw new Error('Pair not found');

  const event = pair.event as Record<string, unknown>;
  if (event.status !== 'registration') {
    throw new Error('Cannot remove pairs after registration closes');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  const { error } = await adminClient.from('tournament_pairs').delete().eq('id', pairId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  revalidateEventPaths(event.tournament_id as string, pair.event_id as string);
}

export async function checkInPair(pairId: string): Promise<ActionResult> {
  return runAction(() => checkInPairImpl(pairId));
}

async function checkInPairImpl(pairId: string) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select(`${pairContextSelect}, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)`)
    .eq('id', pairId)
    .single();

  const pairCtx = extractEventContext(pair);
  if (pairCtx) await assertTournamentNotSuspended(adminClient, pairCtx.tid);

  // BOTH HALVES, OR NEITHER. A pair with one signature is not half-eligible: the
  // unsigned partner would be on court. The refusal names only the half at
  // fault, so the exec knows whose phone to point at rather than being told the
  // team is broken.
  //
  // Unlike the singles path this cannot proceed without context, because
  // without a tournament id there is nothing to screen against — and a
  // check-in that silently skipped the gate is the one outcome that must not
  // be possible.
  if (!pairCtx) throw new Error('Could not read this pair. Nothing was changed — try again.');
  await assertEventWaiverSigned(adminClient, pairCtx.tid, {
    id: pairId,
    members: pairWaiverMembers(pair as never),
  });

  const { data, error } = await adminClient.from('tournament_pairs')
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: admin.id,
    })
    .eq('id', pairId)
    .select(pairContextSelect)
    .single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // The row is already updated, so this cannot report a failure — but it must
  // not report a plain success either. Without the context there is nothing to
  // revalidate, and since these screens stopped calling router.refresh() a
  // silent skip leaves the desk looking at a board that still says the player is
  // waiting. Say what happened and tell them to reload.
  const ctx = extractEventContext(data);
  if (!ctx) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable — page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(ctx.tid, ctx.eventId);
}

export async function markPairNoShow(pairId: string) {
  await requireCapability('tournaments.draw.noshow.write');
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_pairs')
    .update({ status: 'no_show' })
    .eq('id', pairId)
    .select(pairContextSelect)
    .single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  // The row is already updated, so this cannot report a failure — but it must
  // not report a plain success either. Without the context there is nothing to
  // revalidate, and since these screens stopped calling router.refresh() a
  // silent skip leaves the desk looking at a board that still says the player is
  // waiting. Say what happened and tell them to reload.
  const ctx = extractEventContext(data);
  if (!ctx) {
    Sentry.captureException(new Error('Tournament entry updated but its event context was unreadable — page not revalidated'));
    throw new Error('Saved, but the page could not be refreshed. Reload to see the change.');
  }
  revalidateEventPaths(ctx.tid, ctx.eventId);
}

// ============================================================
// Bulk check-in
// ============================================================

/** What "Check In All Present" reports back when it could not take everybody. */
export interface BulkCheckInResult {
  checkedIn: number;
  /** Empty when the whole field went through. The sentence names the people. */
  skippedForWaiver: string;
}

export async function bulkCheckIn(
  eventId: string,
  type: 'participants' | 'pairs',
): Promise<ActionResult<BulkCheckInResult>> {
  return runAction(() => bulkCheckInImpl(eventId, type));
}

async function bulkCheckInImpl(
  eventId: string,
  type: 'participants' | 'pairs',
): Promise<BulkCheckInResult> {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const table = type === 'pairs' ? 'tournament_pairs' : 'tournament_participants';

  // Read the event BEFORE the update and refuse without it — same reason as
  // checkInParticipant. Checking in a whole field and leaving the board showing
  // everyone as waiting is the failure this is guarding against, and there is no
  // router.refresh() behind it any more.
  const { data: event } = await adminClient.from('tournament_events').select('tournament_id').eq('id', eventId).single();
  if (!event) throw new Error('Could not read this event. Nobody was checked in — try again.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // PARTITION, DO NOT REFUSE WHOLE. This is the button an exec presses with a
  // room full of people in front of them. Failing the whole press because one
  // entrant has not signed would hold up everybody else — the queue at the door
  // this feature exists to prevent, caused by the feature itself. So the ones
  // who may play are checked in, and the ones who may not are named.
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, event.tournament_id);

  let idsToCheckIn: string[] | null = null;
  let skippedForWaiver = '';

  if (requiredHash) {
    const { data: waiting, error: waitingError } = type === 'pairs'
      ? await adminClient.from('tournament_pairs')
        .select('id, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
        .eq('event_id', eventId).eq('status', 'registered')
      : await adminClient.from('tournament_participants')
        .select('id, player_id, player:players!player_id(full_name)')
        .eq('event_id', eventId).eq('status', 'registered');
    // A failed read here must not read as "nobody is waiting" — that would
    // check in zero people and report success — nor may it be allowed to skip
    // the gate. Refuse and say nothing happened.
    if (waitingError) {
      Sentry.captureException(waitingError);
      throw new Error('Could not check who has signed the event waiver. Nobody was checked in — try again.');
    }

    const entries = (waiting ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        members: type === 'pairs'
          ? pairWaiverMembers(r as never)
          : [{ id: r.player_id as string, name: pickName(r.player) ?? 'This player' }],
      };
    });

    const screening = screenForEventWaiver(entries, requiredHash, acceptances);
    idsToCheckIn = screening.allowed;
    skippedForWaiver = eventWaiverRefusal(screening.blocked);

    if (idsToCheckIn.length === 0) {
      // Nothing to write. Still not an error: the exec asked a reasonable
      // question and gets the reason, not a failure.
      if (skippedForWaiver) throw new ExpectedError(skippedForWaiver);
      return { checkedIn: 0, skippedForWaiver: '' };
    }
  }

  // No waiver on this tournament → the original single-statement update, over
  // the whole field, exactly as before.
  let query = adminClient.from(table)
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: admin.id,
    })
    .eq('event_id', eventId)
    .eq('status', 'registered');
  if (idsToCheckIn) query = query.in('id', idsToCheckIn);

  const { data: updated, error } = await query.select('id');

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  revalidateEventPaths(event.tournament_id, eventId);
  return { checkedIn: (updated ?? []).length, skippedForWaiver };
}
