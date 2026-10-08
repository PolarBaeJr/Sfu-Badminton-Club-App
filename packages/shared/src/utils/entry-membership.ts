// The two reads the entry rule in ./membership needs: which season an entry
// counts toward, and who has paid that season's club fee.
//
// Shared by every caller that decides or prices an entry (the member's own
// registration, the entry-fee ledger, the Discord list and the console's fee
// screens), because four copies of "which season" is how the page ends up
// promising what the action refuses.
//
// NULL MEANS THE READ FAILED, NEVER "NOBODY PAID". An empty set is a real
// answer (a paid member is then priced and gated as external), so a failure
// that came back as one would quietly refuse or over-charge the whole roster.
// Every caller decides for itself what a failure means: the action fails
// closed, a page renders nothing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { selectInChunks } from './query-chunks';
import { entryMembership, isFeeExempt } from './membership';
import type { MembershipType } from './membership';

/**
 * The season an entry into this tournament counts toward: the tournament's own
 * season, else the active one. `seasonId` null with no error means there is no
 * season at all, which the rule treats as "nothing to have paid for".
 */
export async function resolveEntrySeasonId(
  supabase: SupabaseClient,
  tournamentSeasonId: string | null | undefined,
): Promise<{ seasonId: string | null; error: unknown }> {
  if (tournamentSeasonId) return { seasonId: tournamentSeasonId, error: null };
  const { data, error } = await supabase
    .from('seasons')
    .select('id')
    .eq('active_flag', true)
    .maybeSingle();
  if (error) return { seasonId: null, error };
  return { seasonId: (data as { id: string } | null)?.id ?? null, error: null };
}

/**
 * Which of these players have a paid (or waived) dues row for the season.
 *
 * Name-keyed payments not yet attached to a member do not count, and neither
 * does a receipt still waiting on an exec: only a row with paid_at set.
 * paid_at is filtered here rather than in the query so the read stays the
 * three verbs every mock in the repo already speaks.
 */
export async function loadPaidDues(
  supabase: SupabaseClient,
  seasonId: string | null,
  playerIds: readonly string[],
): Promise<Set<string> | null> {
  const unique = [...new Set(playerIds)].filter(Boolean);
  if (!seasonId || unique.length === 0) return new Set();
  // One dues row per member per season (club_fees_dues_player_season_key), so
  // one row per id and the request-line chunking alone is enough.
  const { data, error } = await selectInChunks<{ player_id: string; paid_at: string | null }>(unique, (ids) =>
    supabase
      .from('club_fees')
      .select('player_id, paid_at')
      .eq('fee_type', 'dues')
      .eq('season_id', seasonId)
      .in('player_id', ids) as never,
  );
  if (error) return null;
  return new Set((data ?? []).filter((r) => r.paid_at != null).map((r) => r.player_id));
}

/**
 * The group each player enters this tournament as, keyed by player id. Null
 * when either read failed.
 */
export async function loadEntryMemberships(
  supabase: SupabaseClient,
  tournamentSeasonId: string | null | undefined,
  players: readonly {
    id: string;
    membership_type?: string | null;
    is_exec?: boolean | null;
    fee_exempt?: boolean | null;
  }[],
): Promise<Map<string, MembershipType> | null> {
  const { seasonId, error } = await resolveEntrySeasonId(supabase, tournamentSeasonId);
  if (error) return null;
  const paid = await loadPaidDues(supabase, seasonId, players.map((p) => p.id));
  if (!paid) return null;
  return new Map(
    players.map((p) => [
      p.id,
      entryMembership({
        stored: p.membership_type,
        exempt: isFeeExempt(p),
        paid: paid.has(p.id),
        hasSeason: seasonId !== null,
      }),
    ]),
  );
}
