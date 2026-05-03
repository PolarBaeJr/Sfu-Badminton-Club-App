'use server';

import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError, logError } from '@badminton/shared';

export async function createSeason(data: { name: string; start_date: string; end_date?: string }) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: season, error } = await adminClient.from('seasons').insert({
    name: data.name,
    start_date: data.start_date,
    end_date: data.end_date || null,
    active_flag: false,
  }).select().single();

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'season_created',
    target_type: 'season',
    target_id: season.id,
    new_value: data,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'season_created' });
  }

  revalidatePath('/seasons');
}

export async function setActiveSeason(seasonId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  await adminClient.from('seasons').update({ active_flag: false }).neq('id', '00000000-0000-0000-0000-000000000000');

  const { error } = await adminClient.from('seasons').update({ active_flag: true }).eq('id', seasonId);
  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'season_activated',
    target_type: 'season',
    target_id: seasonId,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'season_activated', seasonId });
  }

  revalidatePath('/seasons');
}

export async function endSeason(seasonId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('seasons').update({
    active_flag: false,
    end_date: new Date().toISOString().split('T')[0],
  }).eq('id', seasonId);

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'season_ended',
    target_type: 'season',
    target_id: seasonId,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'season_ended', seasonId });
  }

  revalidatePath('/seasons');
}
