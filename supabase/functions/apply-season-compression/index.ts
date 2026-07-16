// Invoked on-demand (typically at season end)
// Applies soft Elo compression toward 1200 using configurable factor

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { DEFAULT_ELO } from '../_shared/constants.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'season_settings')
    .single();

  const compressionFactor: number = (setting?.value as Record<string, number>)?.compression_factor ?? 0.15;
  const baseline = DEFAULT_ELO;

  // Get all player ratings (ratings table has no season_id — one row per player)
  const { data: ratings, error } = await supabase
    .from('ratings')
    .select('id, player_id, singles_elo, doubles_elo');

  if (error) {
    console.error('apply-season-compression error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  let updated = 0;

  for (const r of (ratings ?? [])) {
    const newSingles = Math.round(r.singles_elo + compressionFactor * (baseline - r.singles_elo));
    const newDoubles = Math.round(r.doubles_elo + compressionFactor * (baseline - r.doubles_elo));

    if (newSingles !== r.singles_elo || newDoubles !== r.doubles_elo) {
      await supabase
        .from('ratings')
        .update({
          singles_elo: newSingles,
          doubles_elo: newDoubles,
          updated_at: new Date().toISOString(),
        })
        .eq('id', r.id);

      await supabase.from('audit_logs').insert({
        actor_id: null,
        action_type: 'season_compression',
        target_type: 'rating',
        target_id: r.id,
        old_value: { singles_elo: r.singles_elo, doubles_elo: r.doubles_elo },
        new_value: { singles_elo: newSingles, doubles_elo: newDoubles },
        reason: `Season compression applied (factor: ${compressionFactor})`,
      });

      updated++;
    }
  }

  console.log(`Compressed ${updated} ratings`);
  return jsonResponse({ updated, compression_factor: compressionFactor });
});
