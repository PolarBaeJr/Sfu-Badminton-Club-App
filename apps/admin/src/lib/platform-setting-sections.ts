// Which admin section owns which platform_settings row.
//
// This ONE map is the whole split. Moving a section between Ratings and
// Accounts means editing a single line here — no page, layout or nav change.
//
// The division the club owner asked for was "rating settings and account
// settings": knobs that move a player's rating go to Ratings, knobs that govern
// what an account is allowed to do go to Accounts.
//
// Deliberately dependency-free (no React, no Supabase, no '@badminton/shared').
// It is imported by two server pages and by the permissions test; keeping it a
// plain module means nothing here can ever follow an import into the edge
// middleware bundle.
export type PlatformSettingsSection = 'ratings' | 'accounts';

// Declaration order is also RENDER order within each page, so the reading order
// is decided here too rather than by the database's alphabetical `order('key')`.
export const SETTING_SECTION: Record<string, PlatformSettingsSection> = {
  // Ratings — anything that changes a number on the ladder.
  rating_defaults: 'ratings',
  tournament_bonuses: 'ratings',
  season_settings: 'ratings',

  // Accounts — anything that governs what a member's account may do.
  challenge_rules: 'accounts',
  repeat_opponent_caps: 'accounts',
  session_caps: 'accounts',
  walkover_rules: 'accounts',
  inactivity_rules: 'accounts',
  session_attendance: 'accounts',
};

// A platform_settings row added later without a line above must still be
// reachable. Filtering to an exact list would make a new key vanish from the
// console with no error anywhere — the same silent-nothing-happened failure as
// an audit insert nobody checks. It lands on Accounts and SettingsForm's raw
// JSON fallback renders it, which is ugly but visible.
export const DEFAULT_SECTION: PlatformSettingsSection = 'accounts';

export function sectionForSettingKey(key: string): PlatformSettingsSection {
  return SETTING_SECTION[key] ?? DEFAULT_SECTION;
}

/** Rows belonging to one section, in the declaration order above. */
export function settingsForSection<T extends { key: string }>(
  rows: T[],
  section: PlatformSettingsSection
): T[] {
  const order = Object.keys(SETTING_SECTION);
  const rank = (key: string) => {
    const i = order.indexOf(key);
    // Unmapped keys sort last so a surprise row never displaces a known one.
    return i === -1 ? order.length : i;
  };
  return rows
    .filter((row) => sectionForSettingKey(row.key) === section)
    .sort((a, b) => rank(a.key) - rank(b.key));
}
