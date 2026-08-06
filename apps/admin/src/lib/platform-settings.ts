// Server-side reads of platform_settings sections that the app (rather than
// Postgres) enforces.
//
// Fetched per call rather than cached, for the same reason getRatingSettings()
// in tournament-actions/_internal.ts is: finalising an event is not a hot path,
// and a cache is how a mid-tournament settings change ends up applying to some
// matches and not others.
import {
  parseTournamentBonusSettings,
  FALLBACK_TOURNAMENT_BONUS_SETTINGS,
  type TournamentBonusSettings,
} from '@badminton/shared';

// Minimal structural shape so any of the Supabase clients in this repo fits —
// they are all constructed untyped, so there is no Database generic to borrow.
type SettingsReader = { from: (table: string) => any };

export type { TournamentBonusSettings };

/**
 * Read platform_settings.tournament_bonuses.
 *
 * Pass the service-role client: the settings_select RLS policy is `TO
 * authenticated`, and these callers are server actions / server components
 * already holding an admin client.
 *
 * On a query error we return the constants rather than the parser's
 * missing-row result, because a failed read tells us nothing about what is
 * configured, and guessing "disabled" would silently stop awarding bonuses.
 */
export async function getTournamentBonusSettings(
  client: SettingsReader
): Promise<TournamentBonusSettings> {
  try {
    const { data, error } = await client
      .from('platform_settings')
      .select('value')
      .eq('key', 'tournament_bonuses')
      .maybeSingle();
    if (error) return FALLBACK_TOURNAMENT_BONUS_SETTINGS;
    return parseTournamentBonusSettings(data?.value ?? null);
  } catch {
    return FALLBACK_TOURNAMENT_BONUS_SETTINGS;
  }
}
