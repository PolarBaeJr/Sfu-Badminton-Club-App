// Invoked on-demand (typically at season end)
// Writes final standings to season_snapshots table

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Get current active season
  const { data: season } = await supabase
    .from('seasons')
    .select('id, name')
    .eq('active_flag', true)
    .single();

  if (!season) {
    return jsonResponse({ error: 'No active season' }, 400);
  }

  // Check if snapshot already exists
  const { data: existing } = await supabase
    .from('season_snapshots')
    .select('id')
    .eq('season_id', season.id)
    .limit(1);

  if (existing && existing.length > 0) {
    return jsonResponse({ error: 'Snapshot already exists for this season' }, 409);
  }

  // Get all ratings with player info (ratings table has no season_id — one row per player)
  const { data: ratings, error } = await supabase
    .from('ratings')
    .select('player_id, singles_elo, doubles_elo, singles_wins, singles_losses, doubles_wins, doubles_losses, singles_provisional, doubles_provisional, singles_matches_played, doubles_matches_played');

  if (error) {
    console.error('capture-season-snapshot error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  // Build ranked snapshots (exclude provisional players from ranking)
  const singlesRanked = [...(ratings ?? [])]
    .filter((r) => !r.singles_provisional)
    .sort((a, b) => b.singles_elo - a.singles_elo);

  const doublesRanked = [...(ratings ?? [])]
    .filter((r) => !r.doubles_provisional)
    .sort((a, b) => b.doubles_elo - a.doubles_elo);

  const snapshots = (ratings ?? []).map((r) => {
    const singlesRank = singlesRanked.findIndex((s) => s.player_id === r.player_id) + 1;
    const doublesRank = doublesRanked.findIndex((s) => s.player_id === r.player_id) + 1;

    return {
      season_id: season.id,
      player_id: r.player_id,
      final_singles_elo: r.singles_elo,
      final_doubles_elo: r.doubles_elo,
      singles_rank: singlesRank || null,
      doubles_rank: doublesRank || null,
      singles_matches_played: r.singles_matches_played,
      doubles_matches_played: r.doubles_matches_played,
      singles_wins: r.singles_wins,
      singles_losses: r.singles_losses,
      doubles_wins: r.doubles_wins,
      doubles_losses: r.doubles_losses,
    };
  });

  if (snapshots.length > 0) {
    const { error: insertError } = await supabase
      .from('season_snapshots')
      .insert(snapshots);

    if (insertError) {
      console.error('capture-season-snapshot insert error:', insertError);
      return jsonResponse({ error: insertError.message }, 500);
    }
  }

  await supabase.from('audit_logs').insert({
    actor_id: null,
    action_type: 'season_snapshot',
    target_type: 'season',
    target_id: season.id,
    old_value: null,
    new_value: { players_captured: snapshots.length },
    reason: `Season snapshot captured for "${season.name}"`,
  });

  console.log(`Captured ${snapshots.length} player snapshots for season ${season.name}`);
  return jsonResponse({ captured: snapshots.length, season: season.name });
});
