// Server-side read of the rating knobs the admin console edits under /ratings.
//
// Same shape and the same reasoning as challenge-settings.ts and
// rating-tiers.ts: apply_match_result (00041/00127) reads
// platform_settings.rating_defaults on EVERY call and is the source of truth
// for what a match actually does to a rating, so anything the screen predicts
// has to come from that row rather than from a TypeScript constant. The
// engine's fallbacks are 80/48 for singles; production runs 64/36. Previewing
// off the constants told a member they stood to gain most of twice what the
// ladder was going to give them.
//
// platform_settings is readable by any authenticated member (settings_select,
// 00005_rls.sql) and this reads a WHOLE ROW by key, so there is no column-level
// grant involved and none of the 403-renders-as-empty-data failure this repo
// has hit four times.
//
// IT FALLS BACK RATHER THAN THROWING, unlike the admin app's getRatingSettings
// (tournament-actions/_internal.ts). That one is on the WRITE path — a failed
// read there would compute a real, reversible delta from the wrong K and
// persist it, so it must abort. This one only draws a "+12 / -9" hint on a
// form; taking the whole New Challenge page down over a settings hiccup would
// cost a member the ability to challenge anybody, to protect a preview.
// previewEloChange(..., null) reproduces exactly the pre-settings numbers, so
// the degraded case is the behaviour this screen shipped with.
import type { RatingSettings } from '@badminton/shared';
import { createServerSupabaseClient } from './supabase-server';

// Minimal shape so either client works — the Supabase clients in this repo are
// constructed untyped, so there is no Database generic to borrow.
type SettingsReader = { from: (table: string) => any };

export async function getRatingSettings(client?: SettingsReader): Promise<RatingSettings | null> {
  try {
    const supabase = client ?? (await createServerSupabaseClient());
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'rating_defaults')
      .maybeSingle();

    if (error) return null;
    // Row genuinely absent: every field of RatingSettings is optional and
    // getKFactor falls back per FIELD, so a null here means "no overrides
    // configured" — which is what rating_setting_int() does with a missing key.
    return (data?.value as RatingSettings | null) ?? null;
  } catch {
    return null;
  }
}
