'use server';

import { revalidatePath } from 'next/cache';
import {
  ExpectedError,
  feeSubmissionSchema,
  isPlausibleReference,
  normaliseReference,
  parseOrThrow,
  type FeeSubmissionInput,
} from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import { assertFeatureOn } from '../feature-gate';
import { seasonFeeFor } from '../member-fees';
import { getMembershipPayments } from '../club-socials';
import { requirePlayer, runAction, type ActionResult } from './_shared';

// A MEMBER SENDS A PAYMENT RECEIPT (00248, 00253).
//
// The browser has already uploaded the screenshot to fee-proofs under the
// member's own folder; this files the row that points at it. EVERY INPUT IS A
// CLIENT-CONTROLLED POST FIELD, and only five are read: which fee (feeId, or
// duesSeasonId for dues with no row yet), the reference, the path, and the
// method the browser read off the screenshot. player_id and the dues amount
// come from the server.
//
// The method is a hint for the exec, and clamped here: only dues are sold on
// the SFU Rec website, so every other line is stored as an e-transfer, and
// paying one needs the club's e-transfer address to be set. A dues receipt
// keeps the browser's answer, or NULL when it could not tell.
//
// Service role for every write: fee_submissions has no INSERT grant or policy
// for members, and a dues row may have to be created.

export async function submitFeeSubmission(input: FeeSubmissionInput): Promise<ActionResult> {
  return runAction(() => submitFeeSubmissionImpl(input));
}

async function removeUpload(path: string | null) {
  if (!path) return;
  const { error } = await createServiceRoleClient().storage.from('fee-proofs').remove([path]);
  if (error) console.error('[membership] could not remove an orphaned receipt upload:', error.message);
}

async function submitFeeSubmissionImpl(input: FeeSubmissionInput): Promise<void> {
  const player = await requirePlayer();
  await assertFeatureOn('fees', player);

  // The path is checked before anything else, so a crafted one is refused
  // without being removed: it may name somebody else's object.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new ExpectedError('Not authenticated');
  const path = typeof input?.screenshotPath === 'string' ? input.screenshotPath : '';
  if (!path.startsWith(`${user.id}/`) || path.includes('..')) {
    throw new ExpectedError('That screenshot could not be attached');
  }

  try {
    const parsed = parseOrThrow(feeSubmissionSchema, input);
    const reference = normaliseReference(parsed.reference);

    // Everything is checked before duesFee, which may write.
    const admin = createServiceRoleClient();
    const existing = parsed.feeId ? await payableFee(admin, parsed.feeId, player.id) : null;
    const feeType = existing?.fee_type ?? 'dues';
    const method = feeType === 'dues' ? (parsed.detectedMethod ?? null) : 'e_transfer';
    if (feeType !== 'dues' && !(await getMembershipPayments()).etransferEmail) {
      throw new ExpectedError('Ask an exec how to pay this one.');
    }
    if (!isPlausibleReference(reference, method)) {
      throw new ExpectedError(
        `The reference is ${method === 'e_transfer' ? 6 : 4} to 32 letters, digits or hyphens, with no spaces`,
      );
    }
    const feeId = existing
      ? existing.id
      : await duesFee(admin, parsed.duesSeasonId as string, player);

    const { error } = await admin.from('fee_submissions').insert({
      club_fee_id: feeId,
      player_id: player.id,
      reference,
      screenshot_path: path,
      method,
    });
    if (error?.code === '23505') {
      throw new ExpectedError('You already have a submission waiting for this fee.');
    }
    if (error) throw new Error(`The receipt was not saved: ${error.message}`);
  } catch (err) {
    await removeUpload(path);
    throw err;
  }

  revalidatePath('/membership');
  revalidatePath('/feed');
}

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

/** An existing fee row: the member's own, unpaid, and not a reinstatement. */
async function payableFee(
  admin: ServiceClient,
  feeId: string,
  playerId: string,
): Promise<{ id: string; fee_type: string }> {
  const { data: fee, error } = await admin
    .from('club_fees')
    .select('id, player_id, fee_type, paid_at, amount_cents')
    .eq('id', feeId)
    .maybeSingle();
  if (error) throw new Error(`Could not read that fee: ${error.message}`);
  if (!fee || fee.player_id !== playerId) throw new ExpectedError('That fee is not one of yours.');
  if (fee.fee_type === 'reinstatement') {
    throw new ExpectedError('A reinstatement fee is settled with an exec, not by receipt.');
  }
  if (fee.paid_at) throw new ExpectedError('That fee is already settled.');
  if (fee.amount_cents == null) {
    throw new ExpectedError('That fee has no amount recorded yet. Ask an exec how much to send.');
  }
  return { id: fee.id as string, fee_type: fee.fee_type as string };
}

/**
 * This season's dues, found or created. Only the active season, never for an
 * exec or fee-exempt member, priced by players.status exactly as the page shows
 * it. Read, insert, and on a unique violation read again: another tab or an
 * exec may have filed the row in between.
 */
async function duesFee(
  admin: ServiceClient,
  seasonId: string,
  player: { id: string; status?: string | null; is_exec?: boolean | null; fee_exempt?: boolean | null },
): Promise<string> {
  if (player.is_exec || player.fee_exempt) {
    throw new ExpectedError('You are not charged club dues, so there is nothing to pay.');
  }
  const { data: season, error: seasonError } = await admin
    .from('seasons')
    .select('id, competitive_fee_cents, recreational_fee_cents')
    .eq('id', seasonId)
    .eq('active_flag', true)
    .maybeSingle();
  if (seasonError) throw new Error(`Could not read the season: ${seasonError.message}`);
  if (!season) throw new ExpectedError('Dues can only be paid for the season that is running.');

  const find = async () => {
    const { data, error } = await admin
      .from('club_fees')
      .select('id, paid_at, amount_cents')
      .eq('player_id', player.id)
      .eq('season_id', seasonId)
      .eq('fee_type', 'dues')
      .maybeSingle();
    if (error) throw new Error(`Could not read your dues: ${error.message}`);
    return data as { id: string; paid_at: string | null; amount_cents: number | null } | null;
  };

  let row = await find();
  if (!row) {
    const { data, error } = await admin
      .from('club_fees')
      .insert({
        player_id: player.id,
        season_id: seasonId,
        fee_type: 'dues',
        amount_cents: seasonFeeFor(player.status, season),
      })
      .select('id, paid_at, amount_cents')
      .single();
    if (error?.code === '23505') row = await find();
    else if (error) throw new Error(`Could not record your dues: ${error.message}`);
    else row = data as { id: string; paid_at: string | null; amount_cents: number | null };
  }
  if (!row) throw new Error('Your dues row could not be found after it was created.');
  if (row.paid_at) throw new ExpectedError('Your dues for this season are already settled.');
  // An unpaid dues row an exec filed with no amount: price it the way the page
  // does, or the confirm could never settle it.
  if (row.amount_cents == null) {
    const { error } = await admin
      .from('club_fees')
      .update({ amount_cents: seasonFeeFor(player.status, season) })
      .eq('id', row.id)
      .is('paid_at', null)
      .is('amount_cents', null);
    if (error) throw new Error(`Could not price your dues: ${error.message}`);
  }
  return row.id;
}
