'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  banSchema,
  reinstatementSchema,
  reinstatementPaymentSchema,
  type BanInput,
  type ReinstatementInput,
  type ReinstatementPaymentInput,
} from '@badminton/shared';
import { getExecOrAdmin, getAdminPlayer } from './_shared';
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

  // Which season this money counts toward. Stamped from the active season
  // rather than inferred from paid_at later: a reinstatement taken in the gap
  // before a term opens is for that term, and date-bucketing put it in no
  // season at all — a real $20 payment sat invisible in every income figure
  // because it was paid three weeks before the season it belonged to started.
  //
  // Null when nothing is active. Between terms is exactly when a lapsed member
  // comes back, and recording the payment unattached beats refusing it.
  const { data: activeSeason } = await adminClient
    .from('seasons')
    .select('id')
    .eq('active_flag', true)
    .maybeSingle();

  // Was the money settled, or is it simply unknown?
  //
  // The row used to be written with paid_at = now() no matter who filed it, so
  // an exec unban — the dialog hides the payment fields from execs entirely —
  // produced a row that claimed a payment had been taken and recorded its
  // amount as nothing. It counted as $0 in the season income and could never
  // be corrected: reinstatePlayer refuses a second call because the member is
  // no longer banned, and reinstatement_fees_player_ban_key (00065) refuses a
  // second row for the same ban. Real money, permanently booked as zero.
  //
  // An admin SAW the amount box and left it blank, which the dialog spells out
  // as "leave blank for a free reinstatement" — that is a decision, so record
  // it as one: $0, paid. An exec was never shown the box, so nothing is known
  // — leave amount_cents and paid_at null. A null paid_at is what every other
  // ledger in this app already means by "not settled" (markTournamentFeeUnpaid
  // clears exactly those fields), so it is excluded from season income rather
  // than counted as zero, and recordReinstatementPayment below fills it in.
  const paymentRecorded = isAdminActor(actor);
  const amountCents = paymentRecorded ? (input.amount_cents ?? 0) : null;

  const { data: fee, error: feeError } = await adminClient
    .from('reinstatement_fees')
    .insert({
      player_id: input.player_id,
      amount_cents: amountCents,
      paid_at: paymentRecorded ? new Date().toISOString() : null,
      marked_by: actor.id,
      method: input.method ?? null,
      reference: input.reference ?? null,
      ban_reason: player.ban_reason ?? null,
      ban_started_at: banStartedAt,
      season_id: activeSeason?.id ?? null,
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
      payment_recorded: paymentRecorded,
      ban_started_at: banStartedAt,
      amount_cents: amountCents,
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

/**
 * Record the money for a reinstatement that has already happened.
 *
 * This is the missing half of the exec/admin split above. An exec lifts the
 * ban, the member hands over $20, and until now there was no way for anyone to
 * ever attach that $20 to the club's books: reinstatePlayer refuses to run
 * again because the member is no longer banned, and 00065's
 * (player_id, ban_started_at) index refuses a second row for the same ban.
 *
 * Which is also why the fix is an update and not "skip the placeholder row".
 * The row IS the ban episode: reinstatePlayer clears players.banned_at, and
 * reinstatement_fees.ban_started_at is NOT NULL with no default precisely so
 * that nothing can invent one later (00065). Once the row is gone the ban
 * identity is gone with it, and a later insert becomes impossible to key. So
 * the row is written unconditionally and the payment fields are filled in here.
 *
 * Admin-only, matching /fees in the access map and the payment fields in the
 * unban dialog — an exec who could fill this in would be recording money.
 */
export async function recordReinstatementPayment(input: ReinstatementPaymentInput) {
  const parsed = parseOrThrow(reinstatementPaymentSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: fee } = await adminClient
    .from('reinstatement_fees')
    .select('id, player_id, amount_cents, paid_at, method, reference, season_id')
    .eq('id', parsed.fee_id)
    .maybeSingle();
  if (!fee) throw new ExpectedError('That reinstatement no longer exists.');

  // Deliberately not an editor for money that is already on the books. This
  // action exists to close a gap, not to make the ledger rewritable: a figure
  // that has been recorded is corrected by an admin who can see the audit
  // trail, not silently overwritten from a list. amount_cents IS NULL is
  // exactly "nobody has said what was collected" — including the rows written
  // before this split existed.
  if (fee.amount_cents != null) {
    throw new ExpectedError('That reinstatement already has a recorded amount.');
  }

  // Only fill a blank. A row written between terms has no season and its money
  // would otherwise stay out of every income figure — the gap 00069 exists to
  // close — but a row that already names a season keeps it: the payment counts
  // toward the season the reinstatement was granted in, not whichever season
  // happens to be active when the paperwork catches up.
  let seasonId = fee.season_id;
  if (seasonId == null) {
    const { data: activeSeason } = await adminClient
      .from('seasons')
      .select('id')
      .eq('active_flag', true)
      .maybeSingle();
    seasonId = activeSeason?.id ?? null;
  }

  const { error } = await adminClient
    .from('reinstatement_fees')
    .update({
      amount_cents: parsed.amount_cents,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      method: parsed.method ?? null,
      reference: parsed.reference ?? null,
      season_id: seasonId,
    })
    .eq('id', parsed.fee_id)
    // Re-checked in the WHERE clause, not just in the read above: two admins
    // recording the same payment from two open tabs would both pass the check
    // and the second would overwrite the first. This way the second update
    // matches no row.
    .is('amount_cents', null);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'reinstatement_payment_recorded',
    target_type: 'player',
    target_id: fee.player_id,
    old_value: { amount_cents: null, paid_at: fee.paid_at, method: fee.method, reference: fee.reference },
    new_value: {
      reinstatement_fee_id: fee.id,
      amount_cents: parsed.amount_cents,
      method: parsed.method ?? null,
      reference: parsed.reference ?? null,
      season_id: seasonId,
    },
  }, { playerId: fee.player_id });

  revalidatePath('/fees');
}
