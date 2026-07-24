'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { getAdminPlayer } from './_shared';
import { runAction, type ActionResult } from '../action-result';

export async function confirmWalkover(walkoverId: string, notes: string): Promise<ActionResult<void>> {
  return runAction(() => confirmWalkoverImpl(walkoverId, notes));
}

async function confirmWalkoverImpl(walkoverId: string, notes: string) {
  const admin = await getAdminPlayer();
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
    throw new Error(error.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'walkover_confirmed',
    target_type: 'walkover',
    target_id: walkoverId,
    reason: notes,
  }, { walkoverId });

  revalidatePath('/walkovers');
  revalidatePath('/matches');
}

export async function rejectWalkover(walkoverId: string, notes: string): Promise<ActionResult<void>> {
  return runAction(() => rejectWalkoverImpl(walkoverId, notes));
}

async function rejectWalkoverImpl(walkoverId: string, notes: string) {
  const admin = await getAdminPlayer();
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

  if (error) throw new Error(error.message);

  // Restore challenge status
  if (walkover) {
    await adminClient
      .from('challenges')
      .update({ status: 'accepted' })
      .eq('id', walkover.challenge_id);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'walkover_rejected',
    target_type: 'walkover',
    target_id: walkoverId,
    reason: notes,
  }, { walkoverId });

  revalidatePath('/walkovers');
}
