'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, reliabilityAdjustSchema, type ReliabilityAdjustInput } from '@badminton/shared';
import { requireCapability } from './_shared';

export async function adjustReliability(input: ReliabilityAdjustInput) {
  const data = parseOrThrow(reliabilityAdjustSchema, input);
  const admin = await requireCapability('players.reliability.write');
  const adminClient = createAdminClient();

  const { data: oldRow } = await adminClient
    .from('reliability_metrics')
    .select('no_shows, late_cancellations, early_withdrawals, walkover_flag')
    .eq('player_id', data.player_id)
    .maybeSingle();

  const newValues = {
    no_shows: data.no_shows,
    late_cancellations: data.late_cancellations,
    early_withdrawals: data.early_withdrawals,
    walkover_flag: data.walkover_flag,
  };

  // The check_noshow_threshold trigger fires when no_shows increases
  // (auto-flag at 3, auto-suspend at 5) — intentional. Lowering no_shows does
  // NOT auto-unflag, which is why walkover_flag is an explicit input here.
  const { error } = await adminClient
    .from('reliability_metrics')
    .upsert(
      {
        player_id: data.player_id,
        ...newValues,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'player_id' }
    );

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'reliability_adjusted',
    target_type: 'player',
    target_id: data.player_id,
    old_value: oldRow,
    new_value: newValues,
    reason: data.reason,
  }, { playerId: data.player_id });

  revalidatePath('/players');
  revalidatePath(`/players/${data.player_id}`);
}
