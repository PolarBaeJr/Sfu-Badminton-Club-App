// Server-side read of the check-in window tunables.
//
// session_checkin_open() (00008_richer_attendance.sql:56-58) reads these out
// of platform_settings on every call and is the enforcement source of truth.
// The TypeScript constants are only a fallback snapshot, so anything rendered
// from them can disagree with what the RLS gate will actually allow — that is
// how the "Check In button shows but the server rejects it" class of bug
// happens. Server callers fetch the real row instead.
//
// platform_settings is readable by any authenticated member
// (settings_select, 00005_rls.sql:343), so the ordinary user-session client
// is enough; no service-role escalation needed.
import {
  parseCheckinSettings,
  FALLBACK_CHECKIN_SETTINGS,
  type CheckinSettings,
} from '@badminton/shared';
import { createServerSupabaseClient } from './supabase-server';

// Minimal shape so either client works. The Supabase clients in this repo are
// constructed untyped, so there is no Database generic to borrow here.
type SettingsReader = { from: (table: string) => any };

// Pass a client explicitly from contexts with no user session — the calendar
// feed route is token-authenticated and uses the service-role client, where
// the `TO authenticated` settings_select policy would otherwise deny the read
// and silently drop us to the fallback.
export async function getCheckinSettings(client?: SettingsReader): Promise<CheckinSettings> {
  try {
    const supabase = client ?? (await createServerSupabaseClient());
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'session_attendance')
      .maybeSingle();

    // Query failed: we cannot know the real values, so use the prod snapshot
    // rather than silently switching everyone to the 00008 seed.
    if (error) return FALLBACK_CHECKIN_SETTINGS;

    // Row genuinely absent: parseCheckinSettings(null) reproduces exactly what
    // the SQL does with a missing row (duration COALESCEs to 120, opens-before
    // is NULL = no opening edge), so client and gate still agree.
    return parseCheckinSettings(data?.value ?? null);
  } catch {
    return FALLBACK_CHECKIN_SETTINGS;
  }
}
