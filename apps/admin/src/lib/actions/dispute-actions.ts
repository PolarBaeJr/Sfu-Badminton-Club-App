'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import type { DisputeResolveInput } from '@badminton/shared';
import { toClientError } from '@badminton/shared';
import { voidMatch, convertMatchToCasual } from './match-actions';

export async function resolveDispute(data: DisputeResolveInput) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: dispute } = await adminClient
    .from('disputes')
    .select('*, matches(*)')
    .eq('id', data.dispute_id)
    .single();

  if (!dispute) throw new Error('Dispute not found');

  if (data.resolution_type === 'voided') {
    await voidMatch(dispute.match_id, data.resolution_note);
  } else if (data.resolution_type === 'converted_to_casual') {
    await convertMatchToCasual(dispute.match_id, data.resolution_note);
  } else if (data.resolution_type === 'accepted') {
    const { error } = await adminClient.rpc('apply_match_result', {
      p_match_id: dispute.match_id,
      p_confirmed_by: admin.id,
    });
    if (error) {
      Sentry.captureException(new Error(`Match confirmation failed during dispute resolution: ${error.message}`), {
        extra: { disputeId: data.dispute_id, matchId: dispute.match_id },
      });
      throw toClientError(error, 'admin.action');
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

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'dispute_resolved',
    target_type: 'dispute',
    target_id: data.dispute_id,
    new_value: { resolution_type: data.resolution_type },
    reason: data.resolution_note,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'dispute_resolved', disputeId: data.dispute_id },
    });
  }

  revalidatePath('/disputes');
  revalidatePath('/matches');
}
