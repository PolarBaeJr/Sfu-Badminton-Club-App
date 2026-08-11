'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { notifyPlayers } from '../notify';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  tournamentCreateSchema,
  tournamentSuspendSchema,
  requireActiveSeasonId,
  resolveEventWaiverText,
} from '@badminton/shared';
// By SUBPATH — node:crypto, server only.
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import { requireCapability } from './_shared';

export async function createTournament(data: {
  name: string;
  scope: string;
  allowed_memberships?: string[];
  type: string;
  format: string;
  start_date: string;
  end_date?: string;
  bracket_size: number;
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
    scope: data.scope,
    // Omitted -> leave the column default (all three) rather than writing
    // an empty array, which the CHECK constraint rejects.
    ...(data.allowed_memberships?.length ? { allowed_memberships: data.allowed_memberships } : {}),
    type: data.type,
    format: data.format,
    start_date: data.start_date,
    end_date: data.end_date || null,
    bracket_size: data.bracket_size,
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

export async function updateTournamentStatus(tournamentId: string, status: string) {
  const admin = await requireCapability('tournaments.manage.status.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status, name').eq('id', tournamentId).single();

  // An explicit status change also lifts any suspension, so completing a
  // suspended tournament doesn't leave it flagged as paused.
  const { error } = await adminClient.from('tournaments')
    .update({ status, suspended_at: null, suspension_reason: null })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_status_changed',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old?.status },
    new_value: { status },
  }, { tournamentId });

  // Registration opens when a tournament goes draft→active: tell every
  // eligible member so they can sign up. Rare + important, so push too.
  if (status === 'active' && old?.status !== 'active') {
    const { data: players } = await adminClient
      .from('players')
      .select('id')
      .in('status', ['competitive', 'recreational']);
    const playerIds = (players ?? []).map((p) => p.id).filter((id) => id !== admin.id);
    const name = old?.name ?? 'A tournament';
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

export async function updateTournament(tournamentId: string, data: {
  name: string;
  scope: string;
  allowed_memberships?: string[];
  type: string;
  format: string;
  start_date: string;
  end_date?: string;
  bracket_size: number;
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
    scope: data.scope,
    // Omitted -> leave the column default (all three) rather than writing
    // an empty array, which the CHECK constraint rejects.
    ...(data.allowed_memberships?.length ? { allowed_memberships: data.allowed_memberships } : {}),
    type: data.type,
    format: data.format,
    start_date: data.start_date,
    end_date: data.end_date || null,
    bracket_size: data.bracket_size,
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

export async function archiveTournament(tournamentId: string) {
  const admin = await requireCapability('tournaments.manage.archive.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();

  // Archiving lifts any suspension (same rationale as updateTournamentStatus).
  const { error } = await adminClient.from('tournaments')
    .update({ status: 'archived', suspended_at: null, suspension_reason: null })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_archived',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old?.status },
    new_value: { status: 'archived' },
  }, { tournamentId });

  revalidatePath('/tournaments');
}

export async function deleteTournament(tournamentId: string) {
  const admin = await requireCapability('tournaments.manage.delete.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('*').eq('id', tournamentId).single();

  // Delete related data first
  await adminClient.from('tournament_participants').delete().eq('tournament_id', tournamentId);
  await adminClient.from('tournament_events').delete().eq('tournament_id', tournamentId);

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

export async function removeTournamentParticipant(participantId: string, tournamentId: string) {
  const admin = await requireCapability('tournaments.draw.participants.remove.write');
  const adminClient = createAdminClient();

  // Try new table name first, fall back to old if migration hasn't run
  const { error: err1 } = await adminClient.from('legacy_tournament_participants').delete().eq('id', participantId);
  if (err1) {
    const { error: err2 } = await adminClient.from('tournament_participants').delete().eq('id', participantId);
    if (err2) throw new Error(err2.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_participant_removed',
    target_type: 'tournament',
    target_id: tournamentId,
    new_value: { participant_id: participantId },
  }, { tournamentId });

  revalidatePath(`/tournaments/${tournamentId}`);
}
