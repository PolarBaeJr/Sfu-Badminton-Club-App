'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError } from '@badminton/shared';

export async function confirmWalkover(walkoverId: string, notes: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.rpc('apply_walkover_result', {
    p_walkover_id: walkoverId,
    p_admin_id: admin.id,
    p_admin_notes: notes,
  });

  if (error) {
    Sentry.captureException(new Error(`Walkover confirmation failed: ${error.message}`), {
      extra: { walkoverId },
    });
    throw toClientError(error, 'admin.action');
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'walkover_confirmed',
    target_type: 'walkover',
    target_id: walkoverId,
    reason: notes,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'walkover_confirmed', walkoverId },
    });
  }

  revalidatePath('/walkovers');
  revalidatePath('/matches');
}

export async function rejectWalkover(walkoverId: string, notes: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: walkover } = await adminClient.from('walkovers').select('*').eq('id', walkoverId).single();

  const { error } = await adminClient
    .from('walkovers')
    .update({
      status: 'rejected',
      admin_confirmed_by: admin.id,
      admin_confirmed_at: new Date().toISOString(),
      admin_notes: notes,
    })
    .eq('id', walkoverId);

  if (error) throw toClientError(error, 'admin.action');

  if (walkover) {
    await adminClient
      .from('challenges')
      .update({ status: 'accepted' })
      .eq('id', walkover.challenge_id);
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'walkover_rejected',
    target_type: 'walkover',
    target_id: walkoverId,
    reason: notes,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'walkover_rejected', walkoverId },
    });
  }

  revalidatePath('/walkovers');
}
