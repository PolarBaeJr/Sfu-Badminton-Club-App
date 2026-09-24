'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ExpectedError, parseOrThrow, readFeatureFlags } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { notifyPlayers } from '../notify';
import { runAction, type ActionResult } from '../action-result';
import { duesFor, loadOutstandingMembers, submissionCapability } from '../fee-submissions';

// E-TRANSFER RECEIPTS (00248): an exec confirms or rejects what a member sent,
// and reminds members who have not sent one.
//
// EVERY EXPORTED PARAMETER IS A CLIENT-CONTROLLED POST FIELD. Ids are
// shape-checked; who may settle a receipt is decided from the fee it points at,
// read here, never from anything the browser says about it. The settling
// itself is one locked RPC (review_fee_submission_confirm), so two execs
// confirming at once cannot both write.

type SubmissionRow = { id: string; club_fee_id: string; player_id: string; status: string };
type FeeRow = { id: string; fee_type: string; tournament_id: string | null; amount_cents: number | null };

const NOT_FOUND = 'That receipt no longer exists.';

const REVIEW_REFUSALS: Record<string, string> = {
  not_found: NOT_FOUND,
  not_pending: 'That receipt has already been reviewed.',
  already_paid: 'That fee is already settled. The receipt was left as it is.',
  no_amount: 'That fee has no amount recorded. Record one before confirming.',
  bad_reason: 'Give a reason of 3 to 500 characters.',
};

/** The submission, its fee, and the capability that settles it, checked. */
async function authorise(id: string) {
  parseOrThrow(z.string().uuid(), id);
  const adminClient = createAdminClient();
  const { data: sub, error } = await adminClient
    .from('fee_submissions')
    .select('id, club_fee_id, player_id, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read that receipt: ${error.message}`);
  const { data: fee, error: feeError } = sub
    ? await adminClient
        .from('club_fees')
        .select('id, fee_type, tournament_id, amount_cents')
        .eq('id', (sub as SubmissionRow).club_fee_id)
        .maybeSingle()
    : { data: null, error: null };
  if (feeError) throw new Error(`Could not read that fee: ${feeError.message}`);
  const capability = submissionCapability((fee as FeeRow | null)?.fee_type);
  // Nothing to find, or a fee no receipt settles: asked of the club-fee
  // capability, so a caller holding nothing learns nothing about which ids
  // exist.
  const actor = await requireCapability(capability ?? 'fees.clubfees.markpaid.write');
  if (!sub || !fee) throw new ExpectedError(NOT_FOUND);
  if (!capability) throw new ExpectedError('This fee is not settled by e-transfer receipt.');
  return { adminClient, actor, sub: sub as SubmissionRow, fee: fee as FeeRow };
}

function revalidate(fee: FeeRow) {
  revalidatePath('/fees');
  if (fee.tournament_id) revalidatePath(`/tournaments/${fee.tournament_id}/fees`);
}

export async function confirmFeeSubmission(id: string): Promise<ActionResult> {
  return runAction(() => confirmImpl(id));
}

async function confirmImpl(id: string): Promise<void> {
  const { adminClient, actor, sub, fee } = await authorise(id);
  const { data, error } = await adminClient.rpc('review_fee_submission_confirm', {
    p_submission_id: sub.id,
    p_actor: actor.id,
  });
  if (error) throw new Error(`The receipt was not confirmed: ${error.message}`);
  if (data !== 'ok') throw new ExpectedError(REVIEW_REFUSALS[data as string] ?? 'The receipt was not confirmed.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_submission_confirmed',
      target_type: 'club_fee',
      target_id: fee.id,
      old_value: { paid: false },
      new_value: { paid: true, method: 'e_transfer', fee_submission_id: sub.id, amount_cents: fee.amount_cents },
      reason: 'E-transfer receipt confirmed',
    },
    { submissionId: sub.id },
  );
  revalidate(fee);
}

export async function rejectFeeSubmission(id: string, reason: string): Promise<ActionResult> {
  return runAction(() => rejectImpl(id, reason));
}

async function rejectImpl(id: string, reason: string): Promise<void> {
  const why = parseOrThrow(
    z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500, 'Keep the reason to 500 characters'),
    reason ?? '',
  );
  const { adminClient, actor, sub, fee } = await authorise(id);
  const { data, error } = await adminClient.rpc('review_fee_submission_reject', {
    p_submission_id: sub.id,
    p_actor: actor.id,
    p_reason: why,
  });
  if (error) throw new Error(`The receipt was not rejected: ${error.message}`);
  if (data !== 'ok') throw new ExpectedError(REVIEW_REFUSALS[data as string] ?? 'The receipt was not rejected.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_submission_rejected',
      target_type: 'club_fee',
      target_id: fee.id,
      old_value: { status: 'submitted' },
      new_value: { status: 'rejected', fee_submission_id: sub.id },
      reason: `E-transfer receipt rejected: ${why}`,
    },
    { submissionId: sub.id },
  );

  // Best-effort by notifyPlayers' own contract: the rejection stands whether
  // or not the bell row commits. In-app only.
  await notifyPlayers(adminClient, [sub.player_id], {
    type: 'general',
    title: 'Your e-transfer receipt was not accepted',
    body: why,
    metadata: { kind: 'fee_submission_rejected', fee_submission_id: sub.id },
  });
  revalidate(fee);
}

/**
 * Reminds the named members to pay and send a receipt. The ids only say whom
 * the exec meant; who is actually reminded is decided again here from the
 * same list the page draws (loadOutstandingMembers), so a member who paid,
 * sent a receipt, or was reminded in the last three days since the page
 * rendered is skipped. In-app only: no email, no push, no Discord.
 */
export async function remindUnpaidMembers(playerIds: string[]): Promise<ActionResult<{ sent: number; skipped: number }>> {
  return runAction(() => remindImpl(playerIds));
}

async function remindImpl(playerIds: string[]): Promise<{ sent: number; skipped: number }> {
  const actor = await requireCapability('fees.clubfees.markpaid.write');
  const ids = parseOrThrow(z.array(z.string().uuid()).min(1, 'Pick someone to remind').max(1000), playerIds);
  const adminClient = createAdminClient();

  // The reminder sends members to /membership to pay. With either switch off
  // there is no pay form there to reach, so nobody is reminded.
  const flags = await readFeatureFlags(adminClient);
  if (!flags.fees || !flags.membership) {
    throw new ExpectedError('Turn on the fees and membership switches before reminding members to pay.');
  }

  const { data: season, error: seasonError } = await adminClient
    .from('seasons')
    .select('id, name, active_flag, competitive_fee_cents, recreational_fee_cents')
    .eq('active_flag', true)
    .maybeSingle();
  if (seasonError) throw new Error(`Could not read the season: ${seasonError.message}`);
  if (!season) throw new ExpectedError('Reminders need a running season.');

  const now = new Date();
  const wanted = new Set(ids);
  const members = (await loadOutstandingMembers(adminClient, season, now)).filter(
    (m) => wanted.has(m.id) && m.decision.remind,
  );
  if (members.length === 0) {
    throw new ExpectedError('Nobody here is due a reminder: they have paid, sent a receipt, or were reminded in the last 3 days.');
  }

  const { delivered } = await notifyPlayers(adminClient, members.map((m) => m.id), {
    type: 'general',
    title: 'A reminder to pay your club fees',
    body: 'You have fees unpaid. Pay by e-transfer on the Membership page and upload your receipt.',
    metadata: { kind: 'fee_payment_reminder' },
  });
  if (delivered.length === 0) throw new Error('The reminders could not be sent. Try again.');

  // Stamped only for members the bell row reached, so a failed send never
  // starts somebody's cooldown.
  const reached = new Set(delivered);
  const stamp = now.toISOString();
  const feeIds: string[] = [];
  for (const m of members.filter((x) => reached.has(x.id))) {
    for (const line of m.lines) {
      if (line.feeId) {
        feeIds.push(line.feeId);
        continue;
      }
      // This season's dues, with no row yet: filed now, priced by status the
      // way /fees prices it, so the reminder has somewhere to be recorded.
      const { error } = await adminClient.from('club_fees').insert({
        player_id: m.id,
        season_id: season.id,
        fee_type: 'dues',
        amount_cents: duesFor(m.status, season),
        payment_reminded_at: stamp,
      });
      if (error?.code === '23505') {
        await adminClient
          .from('club_fees')
          .update({ payment_reminded_at: stamp })
          .eq('player_id', m.id)
          .eq('season_id', season.id)
          .eq('fee_type', 'dues')
          .is('paid_at', null);
      } else if (error) {
        console.error('[fees] could not record a dues reminder:', error.message);
      }
    }
  }
  if (feeIds.length > 0) {
    const { error } = await adminClient
      .from('club_fees')
      .update({ payment_reminded_at: stamp })
      .in('id', feeIds)
      .is('paid_at', null);
    if (error) console.error('[fees] could not record reminder times:', error.message);
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_payment_reminders_sent',
      target_type: 'season',
      target_id: season.id,
      new_value: { count: delivered.length, player_ids: delivered },
      reason: `Payment reminder sent to ${delivered.length} ${delivered.length === 1 ? 'member' : 'members'}`,
    },
    { seasonId: season.id },
  );

  revalidatePath('/fees');
  return { sent: delivered.length, skipped: ids.length - delivered.length };
}
