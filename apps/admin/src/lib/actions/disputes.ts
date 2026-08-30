'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, disputeResolveSchema, type DisputeResolveInput } from '@badminton/shared';
import { requireCapability } from './_shared';
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

    // THE AUDIT CALL LIVES INSIDE THE BRANCH, not after the if/else, and that
    // placement is the safety property. The unrated branch below writes its
    // dispute_resolved row inside resolve_dispute_unrated, in the same
    // transaction as the resolution; a shared call down here would have to be
    // suppressed for exactly one branch, and a boolean threaded back from SQL
    // to decide it gets you two rows or zero the first time it is misread.
    // Neither is visible from the console. Branch placement cannot be misread.
    //
    // This one stays in TypeScript. resolve_dispute_rated does not write it,
    // and giving it one is a change to the rated path that this migration is
    // not scoped to make — the asymmetry is deliberate and recorded.
    await logAdminAudit(adminClient, {
      actor_id: admin.id,
      action_type: 'dispute_resolved',
      target_type: 'dispute',
      target_id: data.dispute_id,
      new_value: { resolution_type: data.resolution_type },
      reason: data.resolution_note,
    }, { disputeId: data.dispute_id });
  } else {
    // voided / converted_to_casual. ONE TRANSACTION SINCE 00203, the way the
    // rated pair has been since 00178.
    //
    // This branch used to be four steps the server drove in sequence: claim the
    // dispute, mutate the match, close the dispute, audit it. The claim existed
    // precisely because those steps were separable — it stopped a second admin
    // starting the OTHER resolution while the first was mid-flight (00188), and
    // then had to bind the resolution type as well, because a retry after a
    // failed close could otherwise come back as the opposite one and push the
    // match through the other branch (00192).
    //
    // resolve_dispute_unrated holds the dispute row FOR UPDATE from before it
    // reads the status until it commits, so a second admin blocks and finds the
    // work done rather than racing to claim it. claim_dispute_for_resolution is
    // no longer called; it is deliberately left in the database, because
    // dropping a signature the running image still references is what made
    // 00200 order-fragile, and this migration must be applicable BEFORE the
    // image that stops calling it.
    //
    // WHAT THE OPERATOR LOSES, STATED PLAINLY. The second admin used to be told
    // "Another admin is resolving this dispute right now"; they are now told it
    // is already resolved, because by the time they are told anything, it is.
    // The type_conflict warning — "the match may already have been changed that
    // way" — described a state this transaction makes unreachable.
    const { data: outcome, error } = await adminClient.rpc('resolve_dispute_unrated', {
      p_dispute_id: data.dispute_id,
      p_actor_id: admin.id,
      p_resolution_type: data.resolution_type,
      p_resolution_note: data.resolution_note,
    });
    if (error) {
      Sentry.getCurrentScope().setExtras({ disputeId: data.dispute_id, resolution: data.resolution_type });
      throw new Error(error.message);
    }
    // Same shape and same meaning as the rated branch: somebody, possibly an
    // earlier attempt by this same operator, already resolved it. Report that
    // rather than a resolution that did not happen here. No audit row is
    // written for a resolution this call did not perform — and none is written
    // here at all, because resolve_dispute_unrated writes it in the same
    // transaction as the resolution itself. That is the F-002 point.
    if ((outcome as { already_resolved?: boolean } | null)?.already_resolved) {
      revalidatePath('/disputes');
      revalidatePath('/matches');
      return;
    }
  }

  revalidatePath('/disputes');
  revalidatePath('/matches');
}
