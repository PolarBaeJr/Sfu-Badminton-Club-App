'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  banSchema,
  reinstatementSchema,
  type BanInput,
  type ReinstatementInput,
} from '@badminton/shared';
import { getExecOrAdmin } from './_shared';
import { ExpectedError } from '@badminton/shared';
import { isAdminActor } from '../player-field-access';

// Ban/unban is exec work — the club owner named it explicitly. Note that this
// writes is_banned, which the guard_player_privileged_columns trigger also
// lists; that trigger returns early when auth.uid() IS NULL, and this runs on
// the service-role client, so it never fires here. The gate is this function.
export async function banPlayer(input: BanInput) {
  parseOrThrow(banSchema, input);
  const actor = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('players')
    .update({
      is_banned: true,
      banned_at: new Date().toISOString(),
      banned_by: actor.id,
      ban_reason: input.reason,
    })
    .eq('id', input.player_id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_banned',
    target_type: 'player',
    target_id: input.player_id,
    new_value: { reason: input.reason },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');
}

export async function reinstatePlayer(input: ReinstatementInput) {
  const parsed = parseOrThrow(reinstatementSchema, input);
  const actor = await getExecOrAdmin();
  // Lifting the ban is exec work; recording what was collected for it is not.
  // This inserts a reinstatement_fees row and revalidates /fees, which is
  // admin-only in the same access map — so an exec reinstates for free and an
  // admin records the money. Rejected rather than dropped: a silently ignored
  // amount would leave the ledger short with nothing to show for it.
  if (!isAdminActor(actor) && (parsed.amount_cents !== undefined || parsed.method !== undefined || parsed.reference !== undefined)) {
    throw new ExpectedError('Admin access required to record a reinstatement fee');
  }
  const adminClient = createAdminClient();

  // Snapshot the ban before touching it: banned_at identifies which ban this
  // fee settles (00065) and ban_reason is copied onto the record before it is
  // cleared.
  const { data: player } = await adminClient
    .from('players')
    .select('is_banned, banned_at, ban_reason')
    .eq('id', input.player_id)
    .single();
  if (!player) throw new ExpectedError('That member no longer exists.');

  // There was no precondition here at all, so the Unban button could file a
  // reinstatement fee — real money in the season ledger — for a ban that never
  // happened. rosterActionsFor already tries not to offer Unban in that case;
  // this is the guarantee rather than the suggestion, and it is also what stops
  // a sequential double-click from charging twice.
  if (!player.is_banned) {
    throw new ExpectedError('That member is not banned, so there is nothing to reinstate.');
  }

  // Lift the ban FIRST, then record the money. The old order inserted the fee
  // up front, so a failure on the update left the member charged AND still
  // banned — the worst of the two possible half-states, and invisible until
  // someone reconciled the ledger. This way the bad outcome is "unbanned but
  // the payment was not recorded", which is visible on /fees and fixable.
  const { error } = await adminClient
    .from('players')
    .update({
      is_banned: false,
      banned_at: null,
      banned_by: null,
      ban_reason: null,
    })
    .eq('id', input.player_id);
  if (error) throw new Error(error.message);

  // Falls back to now() only if the row was banned without a banned_at, which
  // banPlayer never does; the column is NOT NULL.
  const banStartedAt = player.banned_at ?? new Date().toISOString();

  const { data: fee, error: feeError } = await adminClient
    .from('reinstatement_fees')
    .insert({
      player_id: input.player_id,
      amount_cents: input.amount_cents ?? null,
      paid_at: new Date().toISOString(),
      marked_by: actor.id,
      method: input.method ?? null,
      reference: input.reference ?? null,
      ban_reason: player.ban_reason ?? null,
      ban_started_at: banStartedAt,
    })
    .select('id')
    .single();

  // Audited before the fee error is raised: the ban really was lifted, and that
  // has to be on the record whether or not the money row landed.
  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_reinstated',
    target_type: 'player',
    target_id: input.player_id,
    old_value: { is_banned: true, banned_at: player.banned_at, ban_reason: player.ban_reason },
    new_value: {
      reinstatement_fee_id: fee?.id ?? null,
      fee_recorded: !feeError,
      ban_started_at: banStartedAt,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');

  if (feeError) {
    // reinstatement_fees_player_ban_key (00065): two admins submitting the same
    // reinstatement at once both read is_banned = true, so the precondition
    // above cannot separate them — they snapshot the same banned_at and the
    // index does. The member is unbanned either way; only the duplicate charge
    // is refused.
    if (feeError.code === '23505') {
      throw new ExpectedError(
        'The ban was lifted, but a reinstatement fee for it had already been recorded — this one was not charged again.',
      );
    }
    throw new Error(feeError.message);
  }
}
