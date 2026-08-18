'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { notifyPlayers } from '../notify';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  tournamentCreateSchema,
  tournamentSuspendSchema,
  tournamentStatusUpdateSchema,
  requireActiveSeasonId,
  resolveEventWaiverText,
  ExpectedError,
  isDoublesEvent,
  classifyEventForCompletion,
  selectAllInChunks,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
} from '@badminton/shared';
import type {
  TournamentStatus,
  TournamentEventStatus,
  TournamentEventType,
  EventCompletionBucket,
  CompletableMatch,
} from '@badminton/shared';
// By SUBPATH — node:crypto, server only.
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { finalizeEvent } from '../tournament-actions/finalize';
import { setEventStatus } from '../tournament-actions/events';

export async function createTournament(data: {
  name: string;
  allowed_memberships?: string[];
  start_date: string;
  end_date?: string;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  waiver_text?: string;
  max_events_per_player?: number | null;
}) {
  parseOrThrow(tournamentCreateSchema, data);
  const admin = await requireCapability('tournaments.manage.create.write');
  const adminClient = createAdminClient();

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).maybeSingle();
  // Refuse rather than stamp NULL — see requireActiveSeasonId. A row with no
  // season is invisible to every season total and there is no page that lists
  // the orphans. maybeSingle() so TWO active seasons surface as an error here
  // rather than as a silent "no active season".
  const seasonId = requireActiveSeasonId(activeSeason.data?.id, 'tournament');

  const { data: tournament, error } = await adminClient.from('tournaments').insert({
    name: data.name,
    // Omitted -> leave the column default (all three) rather than writing
    // an empty array, which the CHECK constraint rejects.
    ...(data.allowed_memberships?.length ? { allowed_memberships: data.allowed_memberships } : {}),
    start_date: data.start_date,
    end_date: data.end_date || null,
    event_multiplier: data.event_multiplier,
    placement_bonus_enabled: data.placement_bonus_enabled,
    waiver_text: data.waiver_text?.trim() || null,
    // undefined and null both mean uncapped, and both write NULL. `?? null`
    // rather than a spread, because on the UPDATE path an omitted field has to
    // CLEAR the cap — an exec emptying the box is removing the limit, and a
    // spread would silently leave the old number in place.
    max_events_per_player: data.max_events_per_player ?? null,
    status: 'draft',
    season_id: seasonId,
    created_by: admin.id,
  }).select().single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_created',
    target_type: 'tournament',
    target_id: tournament.id,
    new_value: data,
  });

  revalidatePath('/tournaments');
  return tournament.id;
}

// ============================================================
// COMPLETING A TOURNAMENT: WHAT ITS EVENTS ARE DOING
// ============================================================
//
// A tournament could be marked completed — and archived — with its events left
// sitting in Registration, Check-in, Bracket Generated and Live. The parent row
// said finished, the children said otherwise, and nobody in those events was
// ever given a position, a point or a placement bonus, because only
// finalizeEvent awards those and nothing had called it. `Test Competition 1` is
// archived on production today with a `womens_singles` event live since
// 2026-07-24.
//
// The rule is now: a tournament cannot be closed over the top of unfinished
// events. The exec is told which events and why, and is offered the one action
// that resolves it — finalise each event, then complete.

interface EventCompletionBlocker {
  id: string;
  label: string;
  status: TournamentEventStatus;
  statusLabel: string;
  bucket: EventCompletionBucket;
  incomplete: number;
  matchCount: number;
}

// Named rather than `*`: isRealIncompleteMatch and summariseRedrawBlockers
// between them read exactly these six, and spelling them out is what makes it
// reviewable that the classifier is not being starved of a field it branches
// on. Adding a branch to either means adding a column here.
const COMPLETION_MATCH_COLUMNS =
  'event_id, status, is_bye, elo_snapshot, participant_a_id, participant_b_id, pair_a_id, pair_b_id';

/**
 * Every event of this tournament that is not already `completed`, classified.
 *
 * PAGED, not a bare `.in()`. PGRST_DB_MAX_ROWS is 1000 on production and
 * PostgREST truncates at it SILENTLY — supabase-js resolves rather than
 * rejects — so an unpaged read of a 128 draw's matches comes back short and the
 * rows past the cap are simply never counted as incomplete. A gate that fails
 * open once the draw gets big is worse than no gate at all, because it is the
 * big tournaments whose positions matter.
 */
async function loadEventCompletionBlockers(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
): Promise<EventCompletionBlocker[]> {
  const { data: events, error: eventsError } = await adminClient
    .from('tournament_events')
    .select('id, event_type, status')
    .eq('tournament_id', tournamentId)
    .neq('status', 'completed')
    .order('event_type');
  // NOT swallowed. A failed read arrives as an empty list, and an empty list
  // here reads as "nothing is blocking" — the gate would wave through exactly
  // the tournament it exists to stop.
  if (eventsError) throw new Error(eventsError.message);
  if (!events || events.length === 0) return [];

  const eventIds = events.map((e) => e.id as string);
  const { data: matches, error: matchesError } = await selectAllInChunks<CompletableMatch & { event_id: string }>(
    eventIds,
    (batch, from, to) =>
      adminClient
        .from('tournament_matches')
        .select(COMPLETION_MATCH_COLUMNS)
        .in('event_id', batch)
        .order('event_id')
        .order('id')
        .range(from, to) as never,
  );
  if (matchesError) throw new Error(matchesError.message);

  const byEvent = new Map<string, (CompletableMatch & { event_id: string })[]>();
  for (const m of matches ?? []) {
    const list = byEvent.get(m.event_id);
    if (list) list.push(m);
    else byEvent.set(m.event_id, [m]);
  }

  return events.map((e) => {
    const eventType = e.event_type as TournamentEventType;
    const status = e.status as TournamentEventStatus;
    const eventMatches = byEvent.get(e.id as string) ?? [];
    const counts = classifyEventForCompletion(status, eventMatches, isDoublesEvent(eventType));
    return {
      id: e.id as string,
      label: TOURNAMENT_EVENT_TYPE_LABELS[eventType] ?? eventType,
      status,
      statusLabel: TOURNAMENT_EVENT_STATUS_LABELS[status] ?? status,
      bucket: counts.bucket,
      incomplete: counts.incomplete,
      matchCount: eventMatches.length,
    };
  });
}

/**
 * The refusal the exec reads.
 *
 * It names every event rather than counting them, because the next thing they
 * will do is go and finish one, and "3 events are unfinished" does not say
 * which. The unplayed-match count is included where there is one, since that is
 * the number that decides whether finishing it by hand is five minutes' work or
 * an abandoned draw.
 */
function describeCompletionBlockers(blockers: EventCompletionBlocker[]): string {
  const parts = blockers.map((b) => {
    const detail = b.incomplete > 0 ? `${b.statusLabel}, ${b.incomplete} unplayed` : b.statusLabel;
    return `${b.label} (${detail})`;
  });
  const noun = blockers.length === 1 ? 'event has' : 'events have';
  return `${blockers.length} ${noun} not finished — ${parts.join('; ')}. `
    + 'Finish them individually, or use "Finalise events & complete" to settle them all now.';
}

/**
 * THE OPT-IN. Settle every unfinished event, then close the tournament.
 *
 * Three treatments, because "finalise everything" cannot be applied blindly —
 * finalizeEvent accepts nothing but a `live` event with every match decided:
 *
 *   finalisable          -> finalizeEvent. Positions, points and placement
 *                           bonuses are awarded exactly as a normal finish.
 *   decided but not live -> stepped to `live`, then finalizeEvent. This is the
 *                           walkover-only draw: every match is settled, but
 *                           nobody ever pressed Go Live, so finalizeEvent would
 *                           refuse it on the status alone. `bracket_generated
 *                           -> live` is a single legal step on both format
 *                           paths (statusStepsFor), and setEventStatus's own
 *                           "no bracket generated" guard is satisfied by
 *                           definition here — there are matches.
 *   anything else        -> closed WITHOUT awards.
 *
 * That last one is the whole reason this is opt-in and not the default. An
 * abandoned half-played draw has no defensible finishing order, so nothing is
 * invented: the event is marked completed, the entrants get no position, and
 * the audit row records that it was force-closed and by whom.
 *
 * Nothing here deletes a match. tournament_matches carries elo_snapshot, the
 * only record that a rated delta was ever applied, so destroying a row is the
 * one route to a permanently wrong ladder.
 */
async function completeTournamentWithEventsImpl(tournamentId: string, target: TournamentStatus) {
  if (target !== 'completed' && target !== 'archived') {
    throw new ExpectedError('This action only completes or archives a tournament.');
  }
  const admin = await requireCapability('tournaments.manage.status.write');
  const adminClient = createAdminClient();

  const blockers = await loadEventCompletionBlockers(adminClient, tournamentId);

  const finalized: string[] = [];
  const closed: string[] = [];

  // SEQUENTIAL ON PURPOSE. finalizeEvent writes ratings and placement points;
  // running several at once against the same players is exactly the shape the
  // advisory lock in the rating RPCs exists to serialise, and doing it in the
  // app instead means a failure stops the run at a known point rather than
  // halfway through four concurrent ones.
  for (const b of blockers) {
    if (b.bucket === 'finalisable') {
      await finalizeEvent(b.id);
      finalized.push(b.label);
      continue;
    }

    // Decided, but never taken live. Walk it the one step and finalise it
    // properly rather than closing it unawarded — the entrants played (or were
    // walked over), so they have earned their positions.
    if (b.incomplete === 0 && b.matchCount > 0 && b.status === 'bracket_generated') {
      await setEventStatus(b.id, 'live');
      await finalizeEvent(b.id);
      finalized.push(b.label);
      continue;
    }

    // FORCE-CLOSED, no awards. Written directly rather than through
    // setEventStatus because that action is forward-only and one step at a
    // time by design — `registration -> completed` is not a transition it can
    // express, and loosening it would also loosen the path a redraw walks.
    const { error, count } = await adminClient
      .from('tournament_events')
      .update({ status: 'completed', updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('id', b.id)
      .eq('status', b.status);
    if (error) throw new Error(error.message);
    if (count === 0) {
      throw new ExpectedError(
        `${b.label} changed while the tournament was being completed — reload and try again.`,
      );
    }

    await logAdminAudit(adminClient, {
      actor_id: admin.id,
      action_type: 'tournament_event_force_completed',
      target_type: 'tournament_event',
      target_id: b.id,
      old_value: { status: b.status, incomplete_matches: b.incomplete },
      new_value: { status: 'completed', awarded: false },
    }, { tournamentId });
    closed.push(b.label);
  }

  // Delegated rather than inlined, so the tournament row is closed by the same
  // guarded write as always — including its own re-check of the blockers, which
  // is now a genuine post-condition on the loop above.
  if (target === 'archived') await archiveTournamentImpl(tournamentId);
  else await updateTournamentStatusImpl(tournamentId, 'completed');

  return { finalized, closed };
}

export async function completeTournamentWithEvents(
  tournamentId: string,
  target: TournamentStatus,
): Promise<ActionResult<{ finalized: string[]; closed: string[] }>> {
  return runAction(() => completeTournamentWithEventsImpl(tournamentId, target));
}

async function updateTournamentStatusImpl(tournamentId: string, status: TournamentStatus) {
  // VALIDATED FIRST, exactly as suspendTournament does. The parameter was
  // `status: string` and went straight into `.update({ status })`, so anything
  // a caller sent reached the column.
  parseOrThrow(tournamentStatusUpdateSchema, { tournament_id: tournamentId, status });
  const admin = await requireCapability('tournaments.manage.status.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status, name').eq('id', tournamentId).single();
  // Without this the predicate below reads `.eq('status', undefined)`, which is
  // a malformed filter rather than a filter that matches nothing.
  if (!old) throw new ExpectedError('Tournament not found');

  // A tournament is not finished while its events are not. Closing the parent
  // row over the top of a live event is what left events showing as 'Live' on a
  // completed tournament, with no entrant ever given a position or a point.
  // completeTournamentWithEvents is the path that actually settles them.
  if (status === 'completed' || status === 'archived') {
    const blockers = await loadEventCompletionBlockers(adminClient, tournamentId);
    if (blockers.length > 0) throw new ExpectedError(describeCompletionBlockers(blockers));
  }

  // CONDITIONAL ON THE STATUS THIS REQUEST READ. Two clicks — or two execs —
  // both read `draft`, both wrote `active`, and both then ran the fan-out below:
  // every eligible member got "Tournament registration open" twice, in-app and
  // as a push. PostgREST reports "matched no rows" as SUCCESS, so the count is
  // the only way the loser of that race finds out it did not fire.
  //
  // An explicit status change also lifts any suspension, so completing a
  // suspended tournament doesn't leave it flagged as paused.
  const { error, count } = await adminClient.from('tournaments')
    .update({ status, suspended_at: null, suspension_reason: null }, { count: 'exact' })
    .eq('id', tournamentId)
    .eq('status', old.status);
  if (error) throw new Error(error.message);
  if (count === 0) {
    throw new ExpectedError('This tournament changed while you were changing it — reload to see where it is.');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_status_changed',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old.status },
    new_value: { status },
  }, { tournamentId });

  // Registration opens when a tournament goes draft→active: tell every
  // eligible member so they can sign up. Rare + important, so push too.
  //
  // This guard catches the SEQUENTIAL double-click (the second request reads
  // 'active' and says nothing); the predicate on the UPDATE above catches the
  // CONCURRENT one, where both requests read 'draft'.
  if (status === 'active' && old.status !== 'active') {
    const { data: players } = await adminClient
      .from('players')
      .select('id')
      .in('status', ['competitive', 'recreational']);
    const playerIds = (players ?? []).map((p) => p.id).filter((id) => id !== admin.id);
    const name = old.name ?? 'A tournament';
    await notifyPlayers(
      adminClient,
      playerIds,
      {
        type: 'general',
        title: 'Tournament registration open',
        body: `${name} is open for sign-ups.`,
        metadata: { tournament_id: tournamentId, kind: 'tournament_registration' },
      },
      { title: 'Tournament registration open', body: `${name} is open for sign-ups.`, url: `/tournaments/${tournamentId}` },
      'tournaments',
    );
  }

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

// Public entry point. Next.js replaces anything thrown out of a Server Action
// in production with a generic message, so the refusal — "three events have not
// finished", "this tournament changed while you were changing it" — comes back
// as a value instead, and runAction keeps it out of Sentry. Without this every
// one of them renders as "An error occurred in the Server Components render".
export async function updateTournamentStatus(
  tournamentId: string,
  status: TournamentStatus,
): Promise<ActionResult<void>> {
  return runAction(async () => { await updateTournamentStatusImpl(tournamentId, status); });
}

export async function updateTournament(tournamentId: string, data: {
  name: string;
  allowed_memberships?: string[];
  start_date: string;
  end_date?: string;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  waiver_text?: string;
  max_events_per_player?: number | null;
}) {
  const admin = await requireCapability('tournaments.manage.update.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('*').eq('id', tournamentId).single();

  // EDITING THE WAIVER UN-SIGNS EVERYONE WHO SIGNED THE OLD WORDING, because an
  // acceptance is pinned to a hash of the exact text (00015). That is correct —
  // it is the only defensible reading of a signed document — but it is silent,
  // and doing it mid-tournament turns a checked-in-able field into a blocked
  // one. Recorded on the audit row so that "why did forty people stop being
  // able to check in at 6pm" has an answer.
  //
  // The exec is WARNED before this point, in the dialog, using
  // eventWaiverEditImpact below. This is the record that it happened.
  const invalidated = await countInvalidatedAcceptances(
    adminClient, tournamentId, old?.waiver_text as string | null | undefined, data.waiver_text,
  );

  const { error } = await adminClient.from('tournaments').update({
    name: data.name,
    // Omitted -> leave the column default (all three) rather than writing
    // an empty array, which the CHECK constraint rejects.
    ...(data.allowed_memberships?.length ? { allowed_memberships: data.allowed_memberships } : {}),
    start_date: data.start_date,
    end_date: data.end_date || null,
    event_multiplier: data.event_multiplier,
    placement_bonus_enabled: data.placement_bonus_enabled,
    waiver_text: data.waiver_text?.trim() || null,
    // undefined and null both mean uncapped, and both write NULL. `?? null`
    // rather than a spread, because on the UPDATE path an omitted field has to
    // CLEAR the cap — an exec emptying the box is removing the limit, and a
    // spread would silently leave the old number in place.
    max_events_per_player: data.max_events_per_player ?? null,
  }).eq('id', tournamentId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_updated',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: old,
    new_value: invalidated > 0 ? { ...data, event_waiver_acceptances_invalidated: invalidated } : data,
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

/**
 * How many current acceptances a proposed change to `waiver_text` would throw
 * away. Zero when the text is unchanged, and zero when there is no new text —
 * clearing the box removes the requirement entirely, so nobody is left unsigned.
 *
 * Never throws: this is advisory, and an edit must not fail because a count
 * could not be taken.
 */
async function countInvalidatedAcceptances(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  oldText: string | null | undefined,
  newText: string | null | undefined,
): Promise<number> {
  try {
    const before = resolveEventWaiverText({ waiver_text: oldText });
    const after = resolveEventWaiverText({ waiver_text: newText });
    // No waiver before, or the same words after (trimmed, exactly as the hash
    // sees them): nothing is invalidated. A whitespace-only edit is deliberately
    // free, because eventWaiverHash trims too.
    if (!before || before === after) return 0;
    // Clearing it entirely is not an invalidation — there is no longer anything
    // to be unsigned against.
    if (!after) return 0;

    const oldHash = eventWaiverHash(before);
    const { count } = await adminClient
      .from('event_waiver_acceptances')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .eq('waiver_hash', oldHash);
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * What the exec is told BEFORE they save. Read-only, and gated on the same
 * capability that owns the edit itself — this is a preview of one action's
 * consequence, not a second door, so it does not get a capability of its own.
 */
export async function eventWaiverEditImpact(
  tournamentId: string,
  newWaiverText: string,
): Promise<{ invalidated: number }> {
  await requireCapability('tournaments.manage.update.write');
  const adminClient = createAdminClient();
  const { data: current } = await adminClient
    .from('tournaments')
    .select('waiver_text')
    .eq('id', tournamentId)
    .maybeSingle();
  return {
    invalidated: await countInvalidatedAcceptances(
      adminClient, tournamentId, current?.waiver_text as string | null | undefined, newWaiverText,
    ),
  };
}

export async function suspendTournament(tournamentId: string, reason: string) {
  parseOrThrow(tournamentSuspendSchema, { tournament_id: tournamentId, reason });
  const admin = await requireCapability('tournaments.manage.suspend.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments')
    .select('status, suspended_at').eq('id', tournamentId).single();
  if (!old) throw new Error('Tournament not found');
  if (old.status !== 'active' || old.suspended_at) {
    throw new Error('Only an active, non-suspended tournament can be suspended');
  }

  const suspendedAt = new Date().toISOString();
  const { error } = await adminClient.from('tournaments')
    .update({ suspended_at: suspendedAt, suspension_reason: reason })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_suspended',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { suspended_at: null, suspension_reason: null },
    new_value: { suspended_at: suspendedAt, suspension_reason: reason },
    reason,
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function resumeTournament(tournamentId: string) {
  const admin = await requireCapability('tournaments.manage.resume.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments')
    .select('suspended_at, suspension_reason').eq('id', tournamentId).single();
  if (!old) throw new Error('Tournament not found');
  if (!old.suspended_at) throw new Error('Tournament is not suspended');

  const { error } = await adminClient.from('tournaments')
    .update({ suspended_at: null, suspension_reason: null })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_resumed',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { suspended_at: old.suspended_at, suspension_reason: old.suspension_reason },
    new_value: { suspended_at: null, suspension_reason: null },
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

async function archiveTournamentImpl(tournamentId: string) {
  const admin = await requireCapability('tournaments.manage.archive.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();
  // Same reason as updateTournamentStatus: `.eq('status', undefined)` is a
  // malformed filter, not one that matches nothing.
  if (!old) throw new ExpectedError('Tournament not found');

  // Archiving is a completion too — an archived tournament with a live event in
  // it is the same lie a completed one is.
  const blockers = await loadEventCompletionBlockers(adminClient, tournamentId);
  if (blockers.length > 0) throw new ExpectedError(describeCompletionBlockers(blockers));

  // CONDITIONAL ON THE STATUS THIS REQUEST READ, for the reason spelled out on
  // updateTournamentStatus: PostgREST reports "matched no rows" as success, so
  // without the count the loser of a race would go on to write an audit row
  // claiming it archived the tournament.
  //
  // Archiving lifts any suspension (same rationale as updateTournamentStatus).
  const { error, count } = await adminClient.from('tournaments')
    .update({ status: 'archived', suspended_at: null, suspension_reason: null }, { count: 'exact' })
    .eq('id', tournamentId)
    .eq('status', old.status);
  if (error) throw new Error(error.message);
  if (count === 0) {
    throw new ExpectedError('This tournament changed while you were changing it — reload to see where it is.');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_archived',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old.status },
    new_value: { status: 'archived' },
  }, { tournamentId });

  revalidatePath('/tournaments');
}

// Public entry point, for the same reason updateTournamentStatus has one.
export async function archiveTournament(tournamentId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await archiveTournamentImpl(tournamentId); });
}

export async function deleteTournament(tournamentId: string) {
  const admin = await requireCapability('tournaments.manage.delete.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('*').eq('id', tournamentId).single();

  // DELETING THE EVENTS IS ENOUGH, and it is the only statement here that ever
  // did anything.
  //
  // This used to begin with a delete against `tournament_participants` filtered
  // on `tournament_id` — a column that table does not have (it hangs off an
  // EVENT, via `event_id`; `tournament_id` belongs to the unrelated
  // `legacy_tournament_participants`). PostgREST answered 42703 every time and
  // the bare `await` threw the error away, so the line had never once deleted a
  // row. It read like the statement that clears a tournament's entrants, which
  // is worse than not being there at all.
  //
  // What actually clears them is the cascade, verified against production:
  // tournament_participants, tournament_pairs and tournament_matches all
  // reference tournament_events(id) ON DELETE CASCADE. So removing the events
  // removes the entrants, the pairs and the draw with them.
  const { error: eventsError } = await adminClient
    .from('tournament_events')
    .delete()
    .eq('tournament_id', tournamentId);
  // Checked, unlike before: if this fails the cascade never runs, and deleting
  // the tournament row below would then fail its own FK — or worse, succeed and
  // orphan every event. Better to stop here and say so.
  if (eventsError) throw new Error(eventsError.message);

  const { error } = await adminClient.from('tournaments').delete().eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_deleted',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: old,
  }, { tournamentId });

  revalidatePath('/tournaments');
}
