// The three skill tiers onboarding offers, with the starting rating each one
// actually seeds (00127).
//
// Same shape and the same reasoning as challenge-settings.ts and
// checkin-settings.ts: apply_skill_tier_seed reads
// platform_settings.rating_defaults on every call and is the source of truth,
// so anything the screen PRINTS has to come from that row rather than from a
// TypeScript constant. Printing SKILL_TIER_FALLBACK_ELO would show "800" beside
// Intermediate on a club that had moved the key to 900, and the member would be
// told a number they were not given.
//
// platform_settings is readable by any authenticated member (settings_select,
// 00005_rls.sql) and this reads WHOLE ROWS by key, so there is no column-level
// grant involved and none of the 403-renders-as-empty-data failure this repo
// has hit four times. skill_tier on `players` is a different matter and is
// deliberately ungranted — see the migration.
import {
  SKILL_TIERS,
  SKILL_TIER_LABELS,
  SKILL_TIER_DESCRIPTIONS,
  skillTierElo,
  type SkillTier,
} from '@badminton/shared';
import { createServerSupabaseClient } from './supabase-server';

export interface SkillTierOption {
  tier: SkillTier;
  label: string;
  description: string;
  /** The rating this tier seeds, as this club has it configured right now. */
  elo: number;
}

// Minimal shape so either client works — the Supabase clients in this repo are
// constructed untyped, so there is no Database generic to borrow.
type SettingsReader = { from: (table: string) => any };

export async function getSkillTierOptions(client?: SettingsReader): Promise<SkillTierOption[]> {
  let defaults: Record<string, unknown> | null = null;

  try {
    const supabase = client ?? (await createServerSupabaseClient());
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'rating_defaults')
      .maybeSingle();

    // The read failed, or the row is genuinely absent. Fall through with null:
    // skillTierElo(null) reproduces exactly what rating_setting_int() does with
    // a missing key, so the screen and the seed still agree on the number.
    // Falling back beats rendering nothing — a member who cannot see the tiers
    // cannot pick one, and the whole flow stalls on a settings hiccup.
    if (!error) defaults = (data?.value ?? null) as Record<string, unknown> | null;
  } catch {
    defaults = null;
  }

  // Bounds come from the same row, so a tier configured outside the ladder is
  // shown clamped — the same number the seed would actually write, not the
  // unclamped one an admin typed.
  const bounds = defaults
    ? { min: defaults.min_elo as number | null, max: defaults.max_elo as number | null }
    : null;

  return SKILL_TIERS.map((tier) => ({
    tier,
    label: SKILL_TIER_LABELS[tier],
    description: SKILL_TIER_DESCRIPTIONS[tier],
    elo: skillTierElo(tier, defaults, bounds),
  }));
}
