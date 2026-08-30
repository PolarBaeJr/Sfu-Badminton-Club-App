// Server-side reads of platform_settings sections that the app (rather than
// Postgres) enforces.
//
// Fetched per call rather than cached, for the same reason getRatingSettings()
// in tournament-actions/_internal.ts is: finalising an event is not a hot path,
// and a cache is how a mid-tournament settings change ends up applying to some
// matches and not others.
import {
  parseTournamentBonusSettings,
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
 * THROWS ON A FAILED READ. A missing row and a failed read are different
 * facts and this draws the line between them: no row means nobody has
 * configured the section, which is a real state with a real answer (the
 * constants), whereas an error means the configuration is simply unknown.
 *
 * It used to return the constants for BOTH, and the constants have
 * `enabled: true`. So a permission error, a dropped connection or a
 * PostgREST schema-cache miss read as "bonuses are on" and paid every
 * placement bonus on the event. Ratings are irreversible here — there is no
 * unpay — so the direction that costs nothing is refusing. An officer who
 * sees "could not read the bonus settings" reloads; a club that finds out
 * six weeks later that a settings blip awarded a tournament's worth of
 * bonuses has nothing to undo it with.
 *
 * Callers that only DISPLAY the settings want the opposite of this — see
 * readTournamentBonusSettingsForDisplay below.
 */
export async function getTournamentBonusSettings(
  client: SettingsReader
): Promise<TournamentBonusSettings> {
  const { data, error } = await client
    .from('platform_settings')
    .select('value')
    .eq('key', 'tournament_bonuses')
    .maybeSingle();
  if (error) {
    throw new Error(
      `The platform bonus settings could not be read (${error.message}), ` +
      `so there is no way to tell whether placement bonuses are switched on.`
    );
  }
  return parseTournamentBonusSettings(data?.value ?? null);
}

/**
 * The same read for a caller that is rendering the settings rather than
 * enforcing them, which returns null instead of throwing.
 *
 * A failed read must not take down the page that merely wants to SHOW the
 * figures. Its consumer's contract is already "null when not fetched, and
 * never a default object" — handing back the constants on a failed read is
 * precisely the lie the enforcement path above refuses to tell, so absent is
 * the honest answer here too, and the tab it feeds simply does not render.
 */
export async function readTournamentBonusSettingsForDisplay(
  client: SettingsReader
): Promise<TournamentBonusSettings | null> {
  try {
    return await getTournamentBonusSettings(client);
  } catch {
    return null;
  }
}
