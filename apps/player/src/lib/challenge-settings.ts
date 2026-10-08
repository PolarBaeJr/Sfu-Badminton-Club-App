// Server-side read of the challenge rules the admin console edits under
// Accounts -> Challenge Rules.
//
// Same shape and the same reasoning as checkin-settings.ts, and for the same
// reason: validate_challenge_creation (00048/00053) reads platform_settings on
// every call and is the enforcement source of truth, so anything the screen
// prints has to come from that row and not from a TypeScript constant. Printing
// a hardcoded "3 active challenges" would contradict the console the moment
// somebody raised the cap.
//
// platform_settings is readable by any authenticated member (settings_select,
// 00005_rls.sql), so the ordinary user-session client is enough.
import { parseChallengeRules, FALLBACK_CHALLENGE_RULES, type ChallengeRules } from './challenge-rules';
import { createServerSupabaseClient } from './supabase-server';

// Minimal shape so either client works — the Supabase clients in this repo are
// constructed untyped, so there is no Database generic to borrow.
type SettingsReader = { from: (table: string) => any };

export async function getChallengeRules(client?: SettingsReader): Promise<ChallengeRules> {
  try {
    const supabase = client ?? (await createServerSupabaseClient());
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'challenge_rules')
      .maybeSingle();

    // The read failed, so we cannot know the club's numbers. Fall back rather
    // than render zeroes — a "0 of 0" quota would tell every member they are out
    // of challenges when the gate would happily accept one.
    if (error) return FALLBACK_CHALLENGE_RULES;

    // Row genuinely absent: parseChallengeRules(null) reproduces exactly what
    // platform_setting_int() does with a missing section, so screen and gate
    // still agree.
    return parseChallengeRules(data?.value ?? null);
  } catch {
    return FALLBACK_CHALLENGE_RULES;
  }
}
