'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, disputeResolveSchema, type DisputeResolveInput } from '@badminton/shared';
import { getAdminPlayer } from './_shared';
import { voidMatch, convertMatchToCasual } from './matches';

export async function resolveDispute(data: DisputeResolveInput) {
  parseOrThrow(disputeResolveSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: dispute } = await adminClient
    .from('disputes')
    .select('*, matches(*)')
    .eq('id', data.dispute_id)
    .single();

  if (!dispute) throw new Error('Dispute not found');

  // Handle resolution
  if (data.resolution_type === 'voided') {
    await voidMatch(dispute.match_id, data.resolution_note);
  } else if (data.resolution_type === 'converted_to_casual') {
    await convertMatchToCasual(dispute.match_id, data.resolution_note);
  } else if (data.resolution_type === 'accepted') {
    // The match was disputed (never confirmed); apply_match_result requires
    // pending_confirmation, so restore that state before applying the result.
    const { error: stErr } = await adminClient
      .from('matches')
      .update({ result_status: 'pending_confirmation' })
      .eq('id', dispute.match_id);
    if (stErr) throw new Error(`Failed to restore match state: ${stErr.message}`);
    // Apply the result as-is
    const { error } = await adminClient.rpc('apply_match_result', {
      p_match_id: dispute.match_id,
      p_confirmed_by: admin.id,
    });
    if (error) {
      Sentry.captureException(new Error(`Match confirmation failed during dispute resolution: ${error.message}`), {
        extra: { disputeId: data.dispute_id, matchId: dispute.match_id },
      });
      throw new Error(error.message);
    }
  } else if (data.resolution_type === 'edited') {
    if (!data.edited_winner_side || !data.edited_games || data.edited_games.length === 0) {
      throw new Error('Edited resolution requires winner_side and games');
    }
    // Replace match_games with the admin's corrected scores, then re-apply.
    // The match was disputed (never confirmed), so no reverse step is needed.
    const { error: delErr } = await adminClient.from('match_games').delete().eq('match_id', dispute.match_id);
    if (delErr) throw new Error(`Failed to clear games: ${delErr.message}`);

    const { error: insErr } = await adminClient.from('match_games').insert(
      data.edited_games.map((g) => ({
        match_id: dispute.match_id,
        game_number: g.game_number,
        side_a_score: g.side_a_score,
        side_b_score: g.side_b_score,
      }))
    );
    if (insErr) throw new Error(`Failed to write corrected games: ${insErr.message}`);

    const scoreSummary = data.edited_games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', ');
    const { error: matchErr } = await adminClient
      .from('matches')
      .update({
        winner_side: data.edited_winner_side,
        score_summary: scoreSummary,
        result_status: 'pending_confirmation',
      })
      .eq('id', dispute.match_id);
    if (matchErr) throw new Error(`Failed to update match: ${matchErr.message}`);

    const { error: applyErr } = await adminClient.rpc('apply_match_result', {
      p_match_id: dispute.match_id,
      p_confirmed_by: admin.id,
    });
    if (applyErr) {
      Sentry.captureException(new Error(`Match confirmation failed during edited dispute resolution: ${applyErr.message}`), {
        extra: { disputeId: data.dispute_id, matchId: dispute.match_id },
      });
      throw new Error(applyErr.message);
    }
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
