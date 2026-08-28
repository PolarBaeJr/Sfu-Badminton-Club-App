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
import { requireCapability } from './_shared';

// The club-fee marker: fee_exempt exempts a member from the club fee. It does
// not affect gameplay, ratings or leaderboards — it only controls the
// fee-collection list.
//
// IT USED TO WRITE is_exec AS WELL, and that made this a second way to hand
// somebody the console: is_exec is one of the three columns admin_access_level
// resolves a level from. Console access is now set in exactly one place —
// /permissions, through setConsoleAccess, which refuses a self-edit, refuses a
// non-admin touching an admin, checks grant closure both before and after, and
// demands a reason — and none of that was reachable from a fee screen. An exec
// who also needs to stop paying is now two decisions in two places, which is
// what they always were.
export async function updatePlayerFlags(playerId: string, flags: PlayerFlagsInput) {
  parseOrThrow(playerFlagsSchema, flags);
  const admin = await requireCapability('fees.playerflags.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient
    .from('players')
    .select('fee_exempt')
    .eq('id', playerId)
    .single();

  const { error } = await adminClient
    .from('players')
    .update({ fee_exempt: flags.fee_exempt })
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
  const admin = await requireCapability('fees.clubfees.markpaid.write');
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

  // READ, THEN UPDATE OR INSERT — no upsert. This used to be
  // .upsert(…, { onConflict: 'player_id,season_id' }) against
  // club_fees_player_id_season_id_key, and 00094 replaced that constraint with
  // a PARTIAL unique index (… WHERE fee_type = 'dues'), because a member who
  // enters two tournaments in one season is two rows in the same table.
  // PostgREST emits ON CONFLICT (cols) with no index predicate, so a partial
  // index cannot be inferred as the arbiter and the upsert would fail outright.
  //
  // The shape is waiveFee's, a few lines below, for the same reasons it gives:
  // the 23505 branch turns the race into a message rather than a crash.
  //
  // AND NOW THE READ IS WIDE, for the rest of what waiveFee's comment says. It
  // records a production incident about overwriting a recorded payment and
  // guards against it, and this function — twenty lines above it, over the same
  // table, the same row, the same partial index — had the identical hole: the
  // update below replaces amount_cents/method/reference unconditionally, and the
  // audit entry carried no old_value, so a $100 dues row rewritten as $80 lost
  // the $100 in both places at once. Not part of the report that produced the
  // waiver fix; it is the same defect and the same three lines close it.
  const { data: existing } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method, reference')
    .eq('player_id', input.player_id)
    .eq('season_id', input.season_id)
    .eq('fee_type', 'dues')
    .maybeSingle();

  // Refuse rather than overwrite. Reversing a season fee is markFeeUnpaid, which
  // keeps the amount and audits it; /fees renders "Mark Unpaid" for a paid row
  // and "Remove waiver" for a waived one, so the Mark Paid dialog is never
  // offered over either and no rendered control reaches this branch.
  //
  // A waived row is refused on paid_at alone — see the matching note in
  // tournament-fees.ts. waiveFee may re-waive a waiver because that destroys
  // nothing; recording a PAYMENT over a waiver replaces the club's decision not
  // to charge, and that decision is a fact of its own.
  if (existing?.paid_at) {
    throw new ExpectedError(
      `That fee is already recorded as ${isWaivedFee(existing) ? 'waived' : `paid ($${((existing.amount_cents ?? 0) / 100).toFixed(2)})`}. ` +
        'Mark it unpaid first if you really mean to record a different payment.',
    );
  }

  const payment = {
    paid_at: new Date().toISOString(),
    marked_by: admin.id,
    amount_cents: amountCents,
    method: input.method ?? null,
    reference: input.reference ?? null,
  };

  let fee: { id: string };
  if (existing) {
    const { data: updated, error } = await adminClient
      .from('club_fees')
      .update(payment)
      .eq('id', existing.id)
      // Only while it is STILL unpaid. The refusal above read a row that another
      // desk may have paid since — the exact race waiveFee's second comment
      // describes — and matching no row is not an error in PostgREST, so the
      // count below is what turns the loss into a message.
      .is('paid_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) {
      throw new ExpectedError(
        'That fee was recorded as paid while you were marking it — most likely another desk got there first. ' +
        'Reload and check before recording it again.',
      );
    }
    fee = updated;
  } else {
    const { data: inserted, error } = await adminClient
      .from('club_fees')
      .insert({
        player_id: input.player_id,
        season_id: input.season_id,
        // Explicit rather than left to the column default. This is the club's
        // season fee, and a row that reached the table without saying so would
        // be indistinguishable from an entry fee to every reader that filters.
        fee_type: 'dues',
        ...payment,
      })
      .select('id')
      .single();
    if (error) {
      // Somebody recorded this member's dues between the read and the insert.
      if (error.code === '23505') {
        throw new ExpectedError(
          'A fee was recorded for this member while you were marking it paid. Reload and check before trying again.',
        );
      }
      throw new Error(error.message);
    }
    fee = inserted;
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_paid',
    target_type: 'club_fee',
    target_id: fee.id,
    // Null on the insert path, where nothing preceded this. fee_waived and
    // fee_marked_unpaid both carry the previous row; this is the third writer of
    // the same columns and was the only one that did not.
    old_value: existing ?? null,
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
  const admin = await requireCapability('fees.clubfees.waive.write');
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
    // Dues only. Waiving is a decision about the SEASON FEE; since 00094 the
    // same table also holds this member's entry fees and reinstatements, and
    // without this filter maybeSingle() would throw the moment they had one.
    .eq('fee_type', 'dues')
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
        fee_type: 'dues',
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
  const admin = await requireCapability('fees.clubfees.markunpaid.write');
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method')
    .eq('player_id', playerId)
    .eq('season_id', seasonId)
    // Dues only — this is the /fees roster's Unpaid button, and reversing a
    // season fee must never reach into an entry fee or a reinstatement.
    .eq('fee_type', 'dues')
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  // Keep the row — only clear the payment fields.
  //
  // COMPARE AND SWAP ON THE PAYMENT STATE WE READ. `WHERE id = ...` alone made
  // this a blind write: with two operators on the roster, A opening Mark Unpaid
  // and B recording a corrected payment in between meant A's delayed update
  // erased B's payment — and A's audit row recorded the OLD value, so nothing
  // in the trail showed that a newer payment had been destroyed.
  const unpaidQuery = adminClient
    .from('club_fees')
    .update({ paid_at: null, marked_by: null, method: null })
    .eq('id', oldFee.id);
  const { data: cleared, error } = await (
    oldFee.paid_at === null ? unpaidQuery.is('paid_at', null) : unpaidQuery.eq('paid_at', oldFee.paid_at)
  ).select('id');
  if (error) throw new Error(error.message);
  // Zero rows means the predicate no longer held: somebody changed the payment
  // after the read. Refuse rather than retry — the operator has to see the
  // current state before deciding again.
  if (!cleared || cleared.length === 0) {
    throw new Error('This fee was changed by someone else while you were working on it. Reload and try again.');
  }

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
  const admin = await requireCapability('fees.clubfees.addmanual.write');
  const adminClient = createAdminClient();

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .insert({
      player_id: null,
      manual_name: input.manual_name,
      season_id: input.season_id,
      // A manual entry is somebody paying their SEASON FEE without an account.
      // Entry fees and reinstatements always have a real player row — the shape
      // CHECK in 00094 refuses a manual_name on either — so 'dues' is the only
      // legal value here, said out loud rather than left to the default.
      fee_type: 'dues',
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
  const admin = await requireCapability('fees.clubfees.removemanual.write');
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, manual_name, season_id, amount_cents, paid_at, method')
    .eq('id', id)
    // Manual dues only. This action deletes a row outright, and the id comes
    // from a rendered table — so the filter is what stops a stale or crafted id
    // from destroying an entry fee or a reinstatement through the one control
    // on this page that does not merely edit.
    .eq('fee_type', 'dues')
    .not('manual_name', 'is', null)
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
