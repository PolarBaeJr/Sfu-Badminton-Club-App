'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, termSchema, type TermInput } from '@badminton/shared';
import { getAdminPlayer } from './_shared';

export async function createTerm(input: TermInput): Promise<string> {
  parseOrThrow(termSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // One active term at a time: if this new term is active, clear the others first.
  if (input.active) {
    await adminClient.from('terms').update({ active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
  }

  const { data: term, error } = await adminClient
    .from('terms')
    .insert({
      label: input.label,
      season: input.season,
      year: input.year,
      default_fee_cents: input.default_fee_cents,
      active: input.active,
      sort_order: input.sort_order,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'term_created',
    target_type: 'term',
    target_id: term.id,
    new_value: input,
  });

  revalidatePath('/fees');
  return term.id as string;
}

export async function updateTerm(id: string, input: Partial<TermInput>) {
  parseOrThrow(termSchema.partial(), input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('terms').select('*').eq('id', id).single();

  const { error } = await adminClient.from('terms').update(input).eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'term_updated',
    target_type: 'term',
    target_id: id,
    old_value: old,
    new_value: input,
  });

  revalidatePath('/fees');
}

export async function setActiveTerm(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // One active term at a time: clear active on every other term, then set it here.
  await adminClient.from('terms').update({ active: false }).neq('id', id);

  const { error } = await adminClient.from('terms').update({ active: true }).eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'term_activated',
    target_type: 'term',
    target_id: id,
  });

  revalidatePath('/fees');
}

export async function deleteTerm(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('terms').select('*').eq('id', id).single();

  const { error } = await adminClient.from('terms').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'term_deleted',
    target_type: 'term',
    target_id: id,
    old_value: old,
  });

  revalidatePath('/fees');
}
