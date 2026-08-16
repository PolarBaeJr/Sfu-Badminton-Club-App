// Labels, descriptions and per-field metadata for every platform_settings row.
//
// Lifted out of components/platform-settings-form.tsx so that the two screens
// which draw these settings — /accounts (the generic form) and /ratings (its
// own three-column layout) — read ONE description of what each field means.
// Two copies of a hint is how the console ends up telling an officer that the
// starting rating is 800 on one page and 400 on the other.
//
// Deliberately dependency-free: no React, no Supabase. It is imported by a
// client component, a server page and the tests.

export interface PlatformSetting {
  key: string;
  value: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
}

export const SETTING_LABELS: Record<string, string> = {
  challenge_rules: 'Challenge Rules',
  session_caps: 'Session Caps',
  repeat_opponent_caps: 'Repeat Opponent Caps',
  walkover_rules: 'Walkover & No-Show Rules',
  rating_defaults: 'Rating Defaults',
  tournament_bonuses: 'Tournament Bonuses',
  season_settings: 'Season Settings',
  inactivity_rules: 'Inactivity Rules',
  session_attendance: 'Session Attendance',
};

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  challenge_rules: 'Elo range, ladder range, max active challenges, expiry hours',
  session_caps: 'Maximum rated matches per session (singles and doubles)',
  repeat_opponent_caps: 'Maximum rated matches against the same opponent in a rolling window',
  walkover_rules: 'Grace periods, withdrawal thresholds, auto-flag and auto-suspend limits',
  rating_defaults: 'Starting Elo, provisional threshold, K-factors',
  tournament_bonuses: 'Placement bonus amounts for singles and doubles tournaments',
  season_settings: 'Compression factor for end-of-season Elo normalization',
  inactivity_rules: 'Days of inactivity before auto-marking players inactive',
  session_attendance: 'Check-in window and default session duration',
};

export interface FieldMeta {
  label: string;
  hint: string;
  type: 'number' | 'boolean' | 'text';
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
}

export const FIELD_META: Record<string, Record<string, FieldMeta>> = {
  challenge_rules: {
    elo_range: {
      label: 'Elo range',
      hint: 'Players can only challenge within this many Elo points.',
      type: 'number',
      min: 0,
      step: 1,
    },
    ladder_range: {
      label: 'Ladder range',
      hint: 'Players can only challenge within this many ladder positions.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_active_challenges: {
      label: 'Max active challenges',
      hint: 'Each player can have at most this many open challenges at a time.',
      type: 'number',
      min: 1,
      step: 1,
    },
    challenge_expiry_hours: {
      label: 'Challenge expiry (hours)',
      hint: 'Unanswered challenges expire after this many hours.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  session_caps: {
    max_rated_singles_per_session: {
      label: 'Max rated singles per session',
      hint: 'Rated singles matches one player can play in a single session.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_rated_doubles_per_session: {
      label: 'Max rated doubles per session',
      hint: 'Rated doubles matches one player can play in a single session.',
      type: 'number',
      min: 0,
      step: 1,
    },
  },
  repeat_opponent_caps: {
    max_rated_singles_vs_same_7days: {
      label: 'Rated singles vs same opponent',
      hint: 'Rated singles against the same opponent allowed within the window below.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_rated_doubles_same_combo_7days: {
      label: 'Rated doubles, same combo',
      hint: 'Rated doubles with the same team combination allowed within the window below.',
      type: 'number',
      min: 0,
      step: 1,
    },
    // The window was hardcoded at 7 days and only implied by the key names
    // above, which are kept as-is so existing stored values keep working.
    window_days: {
      label: 'Rolling window (days)',
      hint: 'How far back the two caps above look. Defaults to 7.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  walkover_rules: {
    grace_period_minutes: {
      label: 'Grace period (minutes)',
      hint: 'How long a player can be late before the match can be claimed as a walkover.',
      type: 'number',
      min: 0,
      step: 1,
    },
    admin_review_window_hours: {
      label: 'Admin review window (hours)',
      hint: 'How long admins have to review a reported walkover before it stands.',
      type: 'number',
      min: 0,
      step: 1,
    },
    late_withdrawal_threshold_hours: {
      label: 'Late withdrawal threshold (hours)',
      hint: 'Withdrawing closer to the session than this counts as a late withdrawal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    no_show_auto_flag_threshold: {
      label: 'No-show auto-flag',
      hint: 'No-shows within the rolling window before a player is flagged for review.',
      type: 'number',
      min: 1,
      step: 1,
    },
    no_show_auto_flag_rolling_days: {
      label: 'No-show rolling window (days)',
      hint: 'How many days back no-shows are counted.',
      type: 'number',
      min: 1,
      step: 1,
    },
    no_show_auto_suspend_threshold: {
      label: 'No-show auto-suspend',
      hint: 'No-shows within the rolling window before a player is automatically suspended.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  rating_defaults: {
    default_elo: {
      label: 'Starting rating',
      // Three jobs, one number, on purpose — see 00055. Saying only "assigned
      // to new players" hid the fact that editing this also moves the floor a
      // season reset compresses everyone toward.
      hint: 'Assigned to every new member on approval. It is also the bottom of the ladder: a full season reset writes this value, and a soft reset compresses every rating toward it.',
      type: 'number',
      min: 0,
      step: 1,
    },
    sweep_margin_multiplier: {
      label: 'Sweep bonus multiplier',
      hint: 'Extra rating movement when a multi-game match ends in a sweep (2-0). Applies to both players — the winner gains this much more, the loser drops this much more. 1.0 turns margin scaling off. Matches that go the distance are never scaled.',
      type: 'number',
      min: 1,
      max: 2,
      step: 0.05,
    },
    max_elo: {
      label: 'Maximum Elo',
      hint: 'Rating ceiling. At the cap a win gains nothing while the loser still drops in full, so ratings leak out of the ladder — keep this well clear of your strongest player.',
      type: 'number',
      min: 1,
      step: 50,
    },
    min_elo: {
      label: 'Minimum Elo',
      hint: 'Rating floor. Applied the same way as the ceiling, in reverse.',
      type: 'number',
      min: 0,
      step: 50,
    },
    provisional_threshold: {
      label: 'Placement matches',
      hint: 'Rated matches a member must complete before their rating counts as established. Until then they move on the provisional K-factors below, so a new member settles quickly.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_k_provisional: {
      label: 'Singles K (provisional)',
      hint: "How fast a provisional player's singles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    singles_k_established: {
      label: 'Singles K (established)',
      hint: "How fast an established player's singles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    doubles_k_provisional: {
      label: 'Doubles K (provisional)',
      hint: "How fast a provisional player's doubles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    doubles_k_established: {
      label: 'Doubles K (established)',
      hint: "How fast an established player's doubles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    provisional_k_enabled: {
      label: 'Provisional K-factors',
      // Names the consequence, not the mechanism. Switching this off is the
      // decision on this page most likely to be made without realising what it
      // does, so the hint says what stops happening — including the interaction
      // with the skill tiers, which is not obvious from either field alone.
      hint: 'On: new members move on the higher provisional K-factors until they have played their placement matches, so a wrong starting rating corrects itself in a few matches. Off: everybody moves on the established K-factors from their first match, and a member who understated their skill level at signup takes far longer to be found out.',
      type: 'boolean',
    },
    tier_beginner_elo: {
      label: 'Beginner starting rating',
      hint: 'Assigned to a member who picks Beginner at signup. Normally the same as the starting rating above, so the tier changes nothing for a true beginner.',
      type: 'number',
      min: 0,
      step: 50,
    },
    tier_intermediate_elo: {
      label: 'Intermediate starting rating',
      hint: 'Assigned to a member who picks Intermediate at signup.',
      type: 'number',
      min: 0,
      step: 50,
    },
    tier_advanced_elo: {
      label: 'Advanced starting rating',
      hint: 'Assigned to a member who picks Advanced at signup. Only ever seeds a rating that has never moved — a member claiming a roster row you already rated keeps the rating you gave them.',
      type: 'number',
      min: 0,
      step: 50,
    },
  },
  tournament_bonuses: {
    enabled: {
      label: 'Bonuses enabled',
      hint: 'Award bonus Elo for tournament placements.',
      type: 'boolean',
    },
    singles_champion: {
      label: 'Singles champion',
      hint: 'Bonus Elo for winning a singles tournament.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_finalist: {
      label: 'Singles finalist',
      hint: 'Bonus Elo for reaching a singles final.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_semifinalist: {
      label: 'Singles semifinalist',
      hint: 'Bonus Elo for reaching a singles semifinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_quarterfinalist: {
      label: 'Singles quarterfinalist',
      hint: 'Bonus Elo for reaching a singles quarterfinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_champion: {
      label: 'Doubles champion',
      hint: 'Bonus Elo for winning a doubles tournament.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_finalist: {
      label: 'Doubles finalist',
      hint: 'Bonus Elo for reaching a doubles final.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_semifinalist: {
      label: 'Doubles semifinalist',
      hint: 'Bonus Elo for reaching a doubles semifinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_quarterfinalist: {
      label: 'Doubles quarterfinalist',
      hint: 'Bonus Elo for reaching a doubles quarterfinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
  },
  season_settings: {
    // The tier band the soft reset refuses to drop anyone below, and the
    // ladder floor everything compresses toward. Both were hardcoded in
    // activate_season until 00055.
    tier_size: {
      label: 'Tier size (Elo points)',
      hint: 'Soft reset never drops a player below the bottom of the tier they earned. The ladder floor itself is the starting rating above.',
      type: 'number',
      min: 1,
      step: 25,
    },
    soft_compression_enabled: {
      label: 'Soft compression',
      hint: 'Pull every rating toward the average at season end.',
      type: 'boolean',
    },
    compression_factor: {
      label: 'Compression factor',
      hint: 'How strongly season-end ratings are pulled toward the average (0 to 1).',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
    },
  },
  inactivity_rules: {
    inactive_threshold_days: {
      label: 'Inactive threshold (days)',
      hint: 'Days without playing before a player is automatically marked inactive.',
      type: 'number',
      min: 1,
      step: 1,
    },
    purge_after_days: {
      label: 'Erase personal details after (days)',
      hint: 'Days a membership stays inactive before its personal details (name, email, phone, photo, bio) are permanently erased. Match history and ratings are kept under an anonymous name. Signing in resets this. This number is also what the inactivity email promises, so changing it changes the notice members receive.',
      type: 'number',
      // 30 days is the floor on purpose: anything shorter would erase people
      // faster than the 30-day grace window we give members who explicitly
      // ASKED to be deleted, which would be incoherent.
      min: 30,
      step: 1,
    },
  },
  session_attendance: {
    checkin_opens_minutes_before: {
      label: 'Check-in opens (minutes before)',
      hint: 'Minutes before the session start that self check-in opens. Leave empty to let players check in any time.',
      type: 'number',
      min: 0,
      step: 1,
      nullable: true,
    },
    default_duration_minutes: {
      label: 'Default session duration (minutes)',
      hint: 'Used to decide when check-in closes for sessions without an end time.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
};
