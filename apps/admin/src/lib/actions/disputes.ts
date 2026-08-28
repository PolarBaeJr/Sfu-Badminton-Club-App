'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, disputeResolveSchema, ExpectedError, type DisputeResolveInput } from '@badminton/shared';
import { requireCapability } from './_shared';
import { voidMatch, convertMatchToCasual } from './matches';
import { runAction, type ActionResult } from '../action-result';

export async function resolveDispute(data: DisputeResolveInput): Promise<ActionResult<void>> {
  return runAction(() => resolveDisputeImpl(data));
}

async function resolveDisputeImpl(data: DisputeResolveInput) {
  parseOrThrow(disputeResolveSchema, data);
  const admin = await requireCapability('disputes.resolve.write');
  const adminClient = createAdminClient();

  // ATOMICITY LIVES IN THE DATABASE NOW (00178).
  //
  // This used to be three or four independent statements: restore the match to
  // pending_confirmation, apply the result, close the dispute. Step one
  // unconditionally re-armed the precondition step two checks, so a retry after
  // a lost response did not bounce off "already confirmed" — it set the match
  // back to pending and applied the whole result a second time, permanently
  // doubling both players' matches played, wins, points, games, streak, rating
  // delta and head-to-head. One transaction, and an idempotence key on the
  // dispute row, is the only thing that actually closes that.
  if (data.resolution_type === 'accepted' || data.resolution_type === 'edited') {
    if (data.resolution_type === 'edited'
        && (!data.edited_winner_side || !data.edited_games || data.edited_games.length === 0)) {
      throw new Error('Edited resolution requires winner_side and games');
    }

    const { data: outcome, error } = await adminClient.rpc('resolve_dispute_rated', {
      p_dispute_id: data.dispute_id,
      p_admin_id: admin.id,
      p_resolution_type: data.resolution_type,
      p_resolution_note: data.resolution_note ?? null,
      p_winner_side: data.edited_winner_side ?? null,
      p_games: data.edited_games ?? null,
    });
    if (error) {
      // Context on the scope, not a second captureException: runAction already
      // reports whatever this throws, so capturing here filed every failure
      // twice. The thrown message stays the raw one so the admin's toast still
      // says what actually went wrong.
      Sentry.getCurrentScope().setExtras({ disputeId: data.dispute_id, resolution: data.resolution_type });
      throw new Error(error.message);
    }
    // Someone — or an earlier attempt by this same operator — already resolved
    // it. Say so rather than reporting a resolution that did not happen here,
    // and do not write a second audit row for one resolution.
    if ((outcome as { already_resolved?: boolean } | null)?.already_resolved) {
      revalidatePath('/disputes');
      revalidatePath('/matches');
      return;
    }
  } else {
    // voided / converted_to_casual. Neither applies a rating, so neither can
    // double-count one, but both must still be single-entry: claim the dispute
    // before doing the work so a retry cannot run the reversal twice.
    const { data: claim, error: claimErr } = await adminClient.rpc('claim_dispute_for_resolution', {
      p_dispute_id: data.dispute_id,
      // WHO is claiming, because without it the claim excluded nobody (00188).
      // The old one-argument form moved the dispute to under_review and
      // returned claimed = true even when it was ALREADY under_review, so two
      // admins pressing Void and Convert to casual at the same moment both got
      // a claim and both went on to do their conflicting work.
      p_actor_id: admin.id,
    });
    if (claimErr) throw new Error(claimErr.message);
    const claimed = claim as {
      claimed?: boolean;
      already_resolved?: boolean;
      held_by_other?: boolean;
      match_id?: string;
    } | null;
    if (claimed?.already_resolved) {
      revalidatePath('/disputes');
      revalidatePath('/matches');
      return;
    }
    // Somebody else is inside the claim window. Say so rather than proceeding:
    // the two resolutions this branch serves are not commutative, and the
    // second one to land would reverse or reclassify a match the first already
    // dealt with.
    if (claimed?.held_by_other) {
      throw new ExpectedError(
        'Another admin is resolving this dispute right now. Reload the page in a few minutes to see how it was settled.'
      );
    }
    const matchId = claimed?.match_id;
    if (!matchId) throw new Error('Dispute not found');

    if (data.resolution_type === 'voided') {
      const r = await voidMatch(matchId, data.resolution_note);
      if (!r.ok) throw new Error(r.error);
    } else {
      const r = await convertMatchToCasual(matchId, data.resolution_note);
      if (!r.ok) throw new Error(r.error);
    }

    const { error } = await adminClient
      .from('disputes')
      .update({
        status: 'resolved',
        resolution_type: data.resolution_type,
        resolution_note: data.resolution_note,
        resolved_by: admin.id,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', data.dispute_id);
    if (error) throw new Error(error.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'dispute_resolved',
    target_type: 'dispute',
    target_id: data.dispute_id,
    new_value: { resolution_type: data.resolution_type },
    reason: data.resolution_note,
  }, { disputeId: data.dispute_id });

  revalidatePath('/disputes');
  revalidatePath('/matches');
}
