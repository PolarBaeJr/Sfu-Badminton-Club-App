'use server';

// A TEAM'S CATEGORY in a staged event (00272): what the stage's head starts
// read for it. Set by the organiser on the participants tab.
//
// BEFORE THE TEAM HAS PLAYED a match with head starts (or walked over, been
// walked over, had one disputed, or is on court in one), the desk changes it
// directly, and the change is re-snapshotted onto the team's unplayed matches.
//
// AFTER, it is a REQUEST with a reason (00279). A played score was judged by
// the starts the old category gave, so changing it is a decision about what a
// recorded result means, and it is settled by somebody who may correct a
// recorded result (tournaments.results.edit.write). Approval changes the
// category and refreshes the head starts of the team's OPEN matches only;
// played matches keep their recorded scores, and each can be corrected with
// "Apply the current head start" in Edit result. The requester may cancel.

import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import {
  ExpectedError,
  isDoublesEvent,
  isInProgressMatch,
  isPlayedMatch,
  parseFormatConfig,
} from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
  mustWrite,
  refreshStagedHandicaps,
} from './_internal';

const MIGRATION_MISSING = 'Run migration 00272 first';
const CATEGORY_MIGRATION_MISSING = 'Run migration 00279 first';
const ALREADY_DECIDED = 'This request has already been decided. Reload the page.';
const PAIR_GONE = 'That team is no longer in this event.';
const EVENT_FINALISED = 'This event has been finalised, so its teams cannot change.';
const NOT_STAGED = 'A category applies to teams in a staged doubles event only.';

function isSchemaMissing(error: { code?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '');
}

function isTableMissing(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205'].includes(error.code ?? '');
}

function isRpcMissing(error: { code?: string } | null): boolean {
  return !!error && ['PGRST202', '42883'].includes(error.code ?? '');
}

/** What approve_pair_category_request answers when it refuses, in the desk's words. */
function categoryRequestRefusal(reason: unknown): string {
  switch (reason) {
    case 'not_found':
    case 'not_pending':
      return ALREADY_DECIDED;
    case 'stale_category':
      return 'The team\'s category changed after this was asked for. Decline it and ask again.';
    case 'unknown_category':
      return 'That category is no longer one of this event\'s.';
    case 'pair_gone':
      return PAIR_GONE;
    case 'event_completed':
      return EVENT_FINALISED;
    case 'not_staged':
      return NOT_STAGED;
    default:
      return 'This category change could not be approved. Reload the page and try again.';
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The team, its event and the event's config, with every refusal a category
 * change of either kind shares, and the team's own staged matches.
 */
async function loadPairForCategory(adminClient: AdminClient, pairId: string) {
  const { data: pair, error: pairError } = await adminClient.from('tournament_pairs')
    .select('id, event_id, pair_name, team_category')
    .eq('id', pairId)
    .maybeSingle();
  if (isSchemaMissing(pairError)) throw new ExpectedError(MIGRATION_MISSING);
  if (pairError) throw new Error(`Could not read the team: ${pairError.message}`);
  if (!pair) throw new ExpectedError(PAIR_GONE);

  const { data: event, error: eventError } = await adminClient.from('tournament_events')
    .select('*').eq('id', pair.event_id).maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new Error('Event not found');
  if (event.format !== 'staged' || !isDoublesEvent(event.event_type)) {
    throw new ExpectedError(NOT_STAGED);
  }
  if (event.status === 'completed') throw new ExpectedError(EVENT_FINALISED);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const cfg = parseFormatConfig(event.format_config);
  if (!cfg) throw new ExpectedError('This event\'s stages are not set out correctly. Fix them in the event settings first.');

  const { data: rows, error: matchError } = await adminClient.from('tournament_matches')
    .select('id, stage, status, is_bye, pair_a_id, pair_b_id')
    .eq('event_id', event.id)
    .not('stage', 'is', null);
  if (matchError) throw new Error(`Could not read the event's matches: ${matchError.message}`);
  const own = (rows ?? []).filter((m) => m.pair_a_id === pairId || m.pair_b_id === pairId);
  const handicapped = (stage: number | null) => stage != null && cfg.stages[stage - 1]?.scoring.handicap === true;
  const open = own.filter((m) => handicapped(m.stage) && (m.status === 'pending' || m.status === 'ready'));

  return { pair, event, cfg, own, handicapped, open };
}

/**
 * Has the team a match with head starts that is decided (completed, walkover,
 * disputed) or on court. A bye is neither, by isPlayedMatch's own rule.
 */
function hasPlayedWithHeadStarts(ctx: Awaited<ReturnType<typeof loadPairForCategory>>): boolean {
  return ctx.own.some((m) => ctx.handicapped(m.stage) && (isPlayedMatch(m) || isInProgressMatch(m)));
}

function chosenCategory(category: unknown): string | null {
  if (category != null && typeof category !== 'string') throw new ExpectedError('Choose a category from the list.');
  return typeof category === 'string' && category.trim() !== '' ? category.trim() : null;
}

/** Set (or clear, with null) the category of one team in a staged event. */
export async function setPairCategory(
  pairId: string,
  category: string | null,
): Promise<ActionResult<{ changed: boolean; rehandicapped: number; requestRequired?: true }>> {
  return runAction(() => setPairCategoryImpl(pairId, category));
}

async function setPairCategoryImpl(
  pairId: unknown,
  category: unknown,
): Promise<{ changed: boolean; rehandicapped: number; requestRequired?: true }> {
  const admin = await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  if (typeof pairId !== 'string' || pairId.length === 0) throw new ExpectedError(PAIR_GONE);
  const next = chosenCategory(category);

  const ctx = await loadPairForCategory(adminClient, pairId);
  const { pair, event, cfg, open } = ctx;
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  if (next !== null && !cfg.categories.some((c) => c.key === next)) {
    throw new ExpectedError(`"${next}" is not a category of this event.`);
  }

  const from = (pair.team_category as string | null) ?? null;
  if (from === next) return { changed: false, rehandicapped: 0 };

  // A request already waiting is the decision in progress: a direct change now
  // would make it stale underneath whoever is about to approve it. No table
  // means no request can exist.
  const { data: pending, error: pendingError } = await adminClient.from('tournament_category_requests')
    .select('id')
    .eq('pair_id', pairId)
    .eq('status', 'pending')
    .maybeSingle();
  if (pendingError && !isTableMissing(pendingError)) {
    throw new Error(`Could not check for a waiting category change: ${pendingError.message}`);
  }
  if (pending) {
    throw new ExpectedError('A category change for this team is waiting for approval. Cancel or decide it first.');
  }

  if (hasPlayedWithHeadStarts(ctx)) return { changed: false, rehandicapped: 0, requestRequired: true };

  await mustWrite(
    'Setting the team\'s category',
    adminClient.from('tournament_pairs').update({ team_category: next }).eq('id', pairId).select('id'),
  );

  for (const m of open) {
    await refreshStagedHandicaps(adminClient, m.id, true, { onlyOpen: true });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'pair_category_changed',
    performed_by: admin.id,
    details: { pair_id: pairId, from, to: next, rehandicapped: open.length },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  return { changed: true, rehandicapped: open.length };
}

/** Ask for a team's category to change after it has played with head starts (00279). */
export async function requestPairCategoryChange(
  pairId: string,
  category: string | null,
  reason: string,
): Promise<ActionResult<{ requested: boolean }>> {
  return runAction(() => requestPairCategoryChangeImpl(pairId, category, reason));
}

async function requestPairCategoryChangeImpl(pairId: unknown, category: unknown, reason: unknown) {
  const admin = await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  if (typeof pairId !== 'string' || pairId.length === 0) throw new ExpectedError(PAIR_GONE);
  const next = chosenCategory(category);

  const ctx = await loadPairForCategory(adminClient, pairId);
  const { pair, event, cfg } = ctx;
  if (next !== null && !cfg.categories.some((c) => c.key === next)) {
    throw new ExpectedError(`"${next}" is not a category of this event.`);
  }

  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why === '') throw new ExpectedError('Give a reason for the change.');
  if (why.length > 500) throw new ExpectedError('Keep the reason under 500 characters.');

  const from = (pair.team_category as string | null) ?? null;
  if (from === next) return { requested: false };
  if (!hasPlayedWithHeadStarts(ctx)) {
    throw new ExpectedError('This team has not played with head starts yet, so change its category directly.');
  }

  const { data: created, error } = await adminClient.from('tournament_category_requests')
    .insert({
      event_id: event.id,
      pair_id: pairId,
      from_category: from,
      to_category: next,
      reason: why,
      requested_by: admin.id,
    })
    .select('id')
    .single();
  if (error?.code === '23505') {
    throw new ExpectedError('This team already has a category change waiting for approval.');
  }
  if (isTableMissing(error)) throw new ExpectedError(CATEGORY_MIGRATION_MISSING);
  if (error) throw new Error(`Could not save the category change request: ${error.message}`);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'pair_category_change_requested',
    performed_by: admin.id,
    details: { request_id: created?.id ?? null, pair_id: pairId, from, to: next, reason: why },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  return { requested: true };
}

/** Approve a waiting category change: the category moves, open matches get the new head starts. */
export async function approvePairCategoryRequest(
  requestId: string,
): Promise<ActionResult<{ rehandicapped: number }>> {
  return runAction(() => approvePairCategoryRequestImpl(requestId));
}

async function approvePairCategoryRequestImpl(requestId: unknown) {
  const admin = await requireCapability('tournaments.results.edit.write');
  const adminClient = createAdminClient();

  if (typeof requestId !== 'string' || requestId.length === 0) throw new ExpectedError(ALREADY_DECIDED);

  const { data: request, error: readError } = await adminClient.from('tournament_category_requests')
    .select('id, event_id, pair_id, from_category, to_category, status, requested_by')
    .eq('id', requestId)
    .maybeSingle();
  if (isTableMissing(readError)) throw new ExpectedError(CATEGORY_MIGRATION_MISSING);
  if (readError) throw new Error(`Could not read the category change request: ${readError.message}`);
  if (!request || request.status !== 'pending') throw new ExpectedError(ALREADY_DECIDED);

  // No draw-lock refusal here, unlike setPairCategory: the lock freezes the
  // entry list, and this decides about matches already played.
  const ctx = await loadPairForCategory(adminClient, request.pair_id);
  const { event, open } = ctx;

  const { data, error } = await adminClient.rpc('approve_pair_category_request', {
    p_request_id: requestId,
    p_actor: admin.id,
  });
  if (isRpcMissing(error)) throw new ExpectedError(CATEGORY_MIGRATION_MISSING);
  if (error) throw new Error(`Could not approve the category change: ${error.message}`);
  const result = data as { ok?: boolean; reason?: string; from?: string | null; to?: string | null; requested_by?: string | null } | null;
  if (!result?.ok) throw new ExpectedError(categoryRequestRefusal(result?.reason));

  // The approval has COMMITTED by here. A refresh that fails must not read as
  // a failed approval, or the approver presses it again and is told it has
  // already been decided. So the audit row is written either way, and the
  // error says what landed.
  let refreshed = 0;
  let refreshError: unknown = null;
  for (const m of open) {
    try {
      await refreshStagedHandicaps(adminClient, m.id, true, { onlyOpen: true });
      refreshed += 1;
    } catch (err) {
      refreshError = err;
      break;
    }
  }

  const requestedBy = result.requested_by ?? (request.requested_by as string | null) ?? null;
  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'pair_category_change_approved',
    performed_by: admin.id,
    details: {
      request_id: requestId,
      pair_id: request.pair_id,
      from: result.from ?? null,
      to: result.to ?? null,
      rehandicapped: refreshed,
      requested_by: requestedBy,
      self_approved: requestedBy === admin.id,
      ...(refreshError ? { refresh_failed: true } : {}),
    },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  if (refreshError) {
    const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
    throw new Error(
      `The category change WAS approved and saved, but updating the head starts on the team's open matches failed: ${detail}. ` +
      'Reload the page and check those matches before they are played.',
    );
  }
  return { rehandicapped: refreshed };
}

/** Decline a waiting category change. Nothing about the team moves. */
export async function declinePairCategoryRequest(requestId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await declinePairCategoryRequestImpl(requestId); });
}

async function declinePairCategoryRequestImpl(requestId: unknown) {
  const admin = await requireCapability('tournaments.results.edit.write');
  const adminClient = createAdminClient();

  if (typeof requestId !== 'string' || requestId.length === 0) throw new ExpectedError(ALREADY_DECIDED);

  const { data: rows, error } = await adminClient.from('tournament_category_requests')
    .update({ status: 'declined', resolved_by: admin.id, resolved_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id, event_id, pair_id, from_category, to_category, requested_by');
  if (isTableMissing(error)) throw new ExpectedError(CATEGORY_MIGRATION_MISSING);
  if (error) throw new Error(`Could not decline the category change: ${error.message}`);
  const row = rows?.[0];
  if (!row) throw new ExpectedError(ALREADY_DECIDED);

  const tournamentId = await tournamentOf(adminClient, row.event_id);
  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: row.event_id,
    action: 'pair_category_change_declined',
    performed_by: admin.id,
    details: { request_id: row.id, pair_id: row.pair_id, from: row.from_category, to: row.to_category, requested_by: row.requested_by },
  });
  if (tournamentId) revalidateEventPaths(tournamentId, row.event_id);
}

/** Withdraw a category change you asked for, before it is decided. */
export async function cancelPairCategoryRequest(requestId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await cancelPairCategoryRequestImpl(requestId); });
}

async function cancelPairCategoryRequestImpl(requestId: unknown) {
  const admin = await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  if (typeof requestId !== 'string' || requestId.length === 0) throw new ExpectedError(ALREADY_DECIDED);

  const { data: rows, error } = await adminClient.from('tournament_category_requests')
    .update({ status: 'cancelled', resolved_by: admin.id, resolved_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending')
    .eq('requested_by', admin.id)
    .select('id, event_id, pair_id, from_category, to_category, requested_by');
  if (isTableMissing(error)) throw new ExpectedError(CATEGORY_MIGRATION_MISSING);
  if (error) throw new Error(`Could not cancel the category change: ${error.message}`);
  const row = rows?.[0];
  if (!row) {
    const { data: existing, error: readError } = await adminClient.from('tournament_category_requests')
      .select('status, requested_by')
      .eq('id', requestId)
      .maybeSingle();
    if (readError) throw new Error(`Could not read the category change request: ${readError.message}`);
    if (existing && existing.status === 'pending' && existing.requested_by !== admin.id) {
      throw new ExpectedError('Only the person who asked can cancel this request.');
    }
    throw new ExpectedError(ALREADY_DECIDED);
  }

  const tournamentId = await tournamentOf(adminClient, row.event_id);
  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: row.event_id,
    action: 'pair_category_change_cancelled',
    performed_by: admin.id,
    details: { request_id: row.id, pair_id: row.pair_id, from: row.from_category, to: row.to_category, requested_by: row.requested_by },
  });
  if (tournamentId) revalidateEventPaths(tournamentId, row.event_id);
}

/** The tournament a request's event belongs to, for its trail row and the refresh. */
async function tournamentOf(adminClient: AdminClient, eventId: string): Promise<string | undefined> {
  const { data: event } = await adminClient.from('tournament_events')
    .select('tournament_id').eq('id', eventId).maybeSingle();
  return (event?.tournament_id as string | undefined) ?? undefined;
}
