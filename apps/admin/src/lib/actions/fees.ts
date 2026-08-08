'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  feeMarkSchema,
  feeWaiveSchema,
  manualFeeSchema,
  playerFlagsSchema,
  ExpectedError,
  type FeeMarkInput,
  type FeeWaiveInput,
  type ManualFeeInput,
  type PlayerFlagsInput,
} from '@badminton/shared';
import { isWaivedFee } from '../fee-status';
import { getAdminPlayer } from './_shared';

// Club-admin markers: is_exec (executive team) and fee_exempt (exempted from
// the club fee). Neither affects gameplay, ratings, or leaderboards — they
// only control the fee-collection list.
export async function updatePlayerFlags(playerId: string, flags: PlayerFlagsInput) {
  parseOrThrow(playerFlagsSchema, flags);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient
    .from('players')
    .select('is_exec, fee_exempt')
    .eq('id', playerId)
    .single();

  const { error } = await adminClient
    .from('players')
    .update({ is_exec: flags.is_exec, fee_exempt: flags.fee_exempt })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_flags_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    new_value: flags,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
  revalidatePath('/fees');
}

export async function markFeePaid(input: FeeMarkInput) {
  parseOrThrow(feeMarkSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Snapshot the amount: use the explicit input if given, else fall back to the
  // season's per-status fee (competitive vs recreational) so the paid row
  // records what was actually owed.
  let amountCents = input.amount_cents ?? null;
  if (amountCents == null) {
    const [{ data: player }, { data: season }] = await Promise.all([
      adminClient.from('players').select('status').eq('id', input.player_id).single(),
      adminClient
        .from('seasons')
        .select('competitive_fee_cents, recreational_fee_cents')
        .eq('id', input.season_id)
        .single(),
    ]);
    amountCents =
      player?.status === 'competitive'
        ? season?.competitive_fee_cents ?? null
        : season?.recreational_fee_cents ?? null;
  }

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .upsert({
      player_id: input.player_id,
      season_id: input.season_id,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
    }, { onConflict: 'player_id,season_id' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_paid',
    target_type: 'club_fee',
    target_id: fee.id,
    new_value: {
      player_id: input.player_id,
      season_id: input.season_id,
      amount_cents: amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

// One-time waiver of the season fee: recorded as a paid row with
// amount_cents 0 and method 'waived' so income sums stay correct.
// Un-waiving is just markFeeUnpaid.
export async function waiveFee(input: FeeWaiveInput) {
  parseOrThrow(feeWaiveSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Read before writing. The upsert below sets amount_cents to 0, so running it
  // over a row that records a real payment silently erases how much was
  // collected — and the audit entry, written without an old_value, kept no copy
  // of it either. There is a fee_waived row on production with an empty
  // old_value for exactly this reason.
  //
  // Refuse rather than overwrite: reversing a payment is markFeeUnpaid, which
  // preserves the amount and audits it. Re-waiving an already-waived row is
  // still allowed — it is idempotent and destroys nothing.
  const { data: existing } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method, reference')
    .eq('player_id', input.player_id)
    .eq('season_id', input.season_id)
    .maybeSingle();

  if (existing?.paid_at && !isWaivedFee(existing)) {
    throw new ExpectedError(
      `That fee is already recorded as paid ($${((existing.amount_cents ?? 0) / 100).toFixed(2)}). ` +
        'Mark it unpaid first if you really mean to waive it — waiving would overwrite the amount with $0.00.',
    );
  }

  // The check above ran against a row that was read a moment ago, and an upsert
  // will happily overwrite whatever is there now. Two desks working the same
  // roster — one recording a $100 payment, one waiving the fee — both saw an
  // unpaid row, and the waiver landed second and replaced a real payment with
  // $0/waived. The refusal above is the message; this is what makes it true.
  //
  // Written as an UPDATE of the unpaid row plus an INSERT for the no-row case,
  // because an upsert cannot carry a condition on the row it is replacing.
  let feeId: string | undefined;
  if (existing) {
    const { data: updated, error: updateError } = await adminClient
      .from('club_fees')
      .update({
        paid_at: new Date().toISOString(),
        marked_by: admin.id,
        amount_cents: 0,
        method: 'waived',
      })
      .eq('id', existing.id)
      // Only while it is STILL unpaid, or still a waiver being re-waived.
      .or('paid_at.is.null,method.eq.waived')
      .select('id')
      .maybeSingle();
    if (updateError) throw new Error(updateError.message);
    if (!updated) {
      throw new ExpectedError(
        'That fee was paid while you were waiving it — most likely another desk got there first. ' +
        'Reload and check before waiving it again.',
      );
    }
    feeId = updated.id;
  } else {
    const { data: inserted, error: insertError } = await adminClient
      .from('club_fees')
      .insert({
        player_id: input.player_id,
        season_id: input.season_id,
        paid_at: new Date().toISOString(),
        marked_by: admin.id,
        amount_cents: 0,
        method: 'waived',
      })
      .select('id')
      .single();
    // 23505 means somebody inserted a fee for this player and season in the
    // window between the read and this insert — which is exactly the payment
    // this must not overwrite.
    if (insertError) {
      if (insertError.code === '23505') {
        throw new ExpectedError(
          'A fee was recorded for this player while you were waiving it. Reload and check before waiving it again.',
        );
      }
      throw new Error(insertError.message);
    }
    feeId = inserted.id;
  }
  const fee = { id: feeId as string };

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_waived',
    target_type: 'club_fee',
    target_id: fee.id,
    old_value: existing ?? null,
    new_value: {
      player_id: input.player_id,
      season_id: input.season_id,
      amount_cents: 0,
      method: 'waived',
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

export async function markFeeUnpaid(playerId: string, seasonId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method')
    .eq('player_id', playerId)
    .eq('season_id', seasonId)
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  // Keep the row — only clear the payment fields.
  const { error } = await adminClient
    .from('club_fees')
    .update({ paid_at: null, marked_by: null, method: null })
    .eq('id', oldFee.id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_unpaid',
    target_type: 'club_fee',
    target_id: oldFee.id,
    old_value: oldFee,
    new_value: { paid_at: null, marked_by: null, method: null },
  }, { playerId });

  revalidatePath('/fees');
}

// Manual entry: record a club-fee payment for someone who paid without an
// account (a name, no player row). Inserted already-paid against the season.
export async function addManualFee(input: ManualFeeInput) {
  parseOrThrow(manualFeeSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .insert({
      player_id: null,
      manual_name: input.manual_name,
      season_id: input.season_id,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
      reference: input.reference ?? null,
    })
    .select('id')
    .single();
  // club_fees_manual_name_season_key (00065). Manual rows sit outside
  // club_fees_player_id_season_id_key because player_id is NULL there, so until
  // that index existed a double-submit filed the same payment twice and the
  // season income figure — a plain SUM over paid rows — counted it twice.
  if (error?.code === '23505') {
    throw new ExpectedError(
      `A manual fee for "${input.manual_name}" is already recorded for this season. ` +
        'If this is a different person with the same name, add something to tell them apart.',
    );
  }
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'manual_fee_added',
    target_type: 'club_fee',
    target_id: fee.id,
    new_value: {
      manual_name: input.manual_name,
      season_id: input.season_id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  });

  revalidatePath('/fees');
}

export async function removeManualFee(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, manual_name, season_id, amount_cents, paid_at, method')
    .eq('id', id)
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  const { error } = await adminClient.from('club_fees').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'manual_fee_removed',
    target_type: 'club_fee',
    target_id: id,
    old_value: oldFee,
  });

  revalidatePath('/fees');
}
