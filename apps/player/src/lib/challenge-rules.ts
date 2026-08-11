// The club's challenge rules, and the derivations the /challenges list needs
// from them.
//
// These rules are ENFORCED IN THE DATABASE, not here. validate_challenge_creation
// (00048, extended by 00053) reads challenge_rules out of platform_settings on
// every call, and challenges.expires_at carries a column DEFAULT built from the
// same section. So everything below is display only, and its one job is to agree
// with the gate — the "the button was there and the server said no" class of bug
// is exactly what a second, drifting copy of a limit produces.
//
// packages/shared exports MAX_ACTIVE_CHALLENGES = 3 and CHALLENGE_EXPIRY_HOURS = 72,
// and NOTHING reads them — they predate 00048 making the caps configurable and
// are now a snapshot of one club's settings, not the rules. They are deliberately
// not used here; the defaults below instead repeat the ones the SQL itself falls
// back to, so a missing settings row renders what the gate would actually do.

export interface ChallengeRules {
  /** challenge_rules.max_active_challenges — open challenges you may have issued at once. */
  maxActive: number;
  /** challenge_rules.challenge_expiry_hours — how long an unanswered challenge stands. */
  expiryHours: number;
  /** challenge_rules.elo_range — 0 means "no Elo limit", matching the SQL's 9999 sentinel. */
  eloRange: number;
  /** challenge_rules.ladder_range — positions apart you may reach on the ladder. */
  ladderRange: number;
}

// The same numbers platform_setting_int() is called with in 00048/00053. Changing
// one here without changing it there reintroduces the drift this file exists to
// avoid.
export const FALLBACK_CHALLENGE_RULES: ChallengeRules = {
  maxActive: 3,
  expiryHours: 72,
  eloRange: 9999,
  ladderRange: 50,
};

/**
 * Reads one integer out of a platform_settings JSON blob the way
 * platform_setting_int() does: a missing key, a null, an empty string or
 * anything that will not parse falls back rather than resolving to 0. Resolving
 * to 0 is the dangerous failure — a max of 0 would tell every member they are
 * out of challenges.
 */
function settingInt(value: unknown, key: string, fallback: number): number {
  if (!value || typeof value !== 'object') return fallback;
  const raw = (value as Record<string, unknown>)[key];
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function parseChallengeRules(value: unknown): ChallengeRules {
  return {
    maxActive: settingInt(value, 'max_active_challenges', FALLBACK_CHALLENGE_RULES.maxActive),
    expiryHours: settingInt(value, 'challenge_expiry_hours', FALLBACK_CHALLENGE_RULES.expiryHours),
    eloRange: settingInt(value, 'elo_range', FALLBACK_CHALLENGE_RULES.eloRange),
    ladderRange: settingInt(value, 'ladder_range', FALLBACK_CHALLENGE_RULES.ladderRange),
  };
}

// ─────────────────────────────────────────────────────────────
// Expiry
// ─────────────────────────────────────────────────────────────

/**
 * The statuses an expiry can still bite on. Everything else has been answered
 * one way or another, and a completed match from March should not carry
 * "expired 5 months ago" — the date is true and the sentence is noise.
 *
 * 'accepted' is excluded on purpose. Both sides have said yes; expires_at is a
 * deadline for ANSWERING, and nothing in the schema expires an agreed match.
 */
const EXPIRABLE_STATUSES = new Set(['proposed', 'partially_confirmed']);

export type ExpiryKind = 'none' | 'expired' | 'urgent' | 'open';

export interface ExpiryState {
  kind: ExpiryKind;
  /** Whole hours remaining, negative once past. `null` when kind is 'none'. */
  hoursLeft: number | null;
  /** Ready to render, or `null` when there is nothing to say. */
  label: string | null;
}

/** Under this many hours left, the deadline stops being background information. */
const URGENT_HOURS = 12;

/**
 * What to say about a challenge's deadline.
 *
 * The sweep is HOURLY, not instant: supabase/functions/expire-challenges flips
 * proposed and partially_confirmed rows past expires_at to 'expired' on a cron.
 * So for up to an hour a row can be genuinely past its deadline while its status
 * still reads Proposed, and the card renders both — a countdown that reached
 * zero, beside the status the database is actually holding. Neither is a lie and
 * the honest version is to show them together; the alternative is a card that
 * says Proposed with no hint that the clock has run out.
 */
export function expiryState(
  expiresAt: string | null | undefined,
  status: string,
  now: number = Date.now(),
): ExpiryState {
  if (!expiresAt || !EXPIRABLE_STATUSES.has(status)) {
    return { kind: 'none', hoursLeft: null, label: null };
  }

  const deadline = new Date(expiresAt).getTime();
  if (!Number.isFinite(deadline)) return { kind: 'none', hoursLeft: null, label: null };

  const msLeft = deadline - now;
  // Truncated, not rounded: with 90 minutes left "1h" is a promise the clock can
  // keep and "2h" is not.
  const hoursLeft = Math.trunc(msLeft / 3_600_000);

  if (msLeft <= 0) return { kind: 'expired', hoursLeft, label: 'Expired' };

  if (msLeft < 3_600_000) {
    const minutes = Math.max(1, Math.floor(msLeft / 60_000));
    return { kind: 'urgent', hoursLeft, label: `${minutes}m left` };
  }
  if (hoursLeft < URGENT_HOURS) {
    return { kind: 'urgent', hoursLeft, label: `${hoursLeft}h left` };
  }
  if (hoursLeft < 48) {
    return { kind: 'open', hoursLeft, label: `${hoursLeft}h left` };
  }
  return { kind: 'open', hoursLeft, label: `${Math.floor(hoursLeft / 24)}d left` };
}

// ─────────────────────────────────────────────────────────────
// The active-challenge quota
// ─────────────────────────────────────────────────────────────

/**
 * The statuses validate_challenge_creation counts against
 * challenge_rules.max_active_challenges. Copied from the SQL rather than
 * reasoned out, because a quota meter that counts a different set from the gate
 * is worse than no meter: it would read "2 of 3" on the screen that just
 * refused you.
 */
const QUOTA_STATUSES = new Set(['proposed', 'partially_confirmed', 'accepted']);

export interface ChallengeQuota {
  used: number;
  max: number;
  /** True when the next attempt would be refused by validate_challenge_creation. */
  full: boolean;
  /** Fraction 0–1 for the capacity bar, clamped so an over-quota state stays drawable. */
  ratio: number;
}

/**
 * How much of the member's own quota is spent.
 *
 * Only challenges THEY created count, because the SQL counts `created_by =
 * p_creator_id`. Being challenged by four people does not use up your allowance,
 * and a meter that said otherwise would be telling members to stop accepting.
 */
export function challengeQuota(
  challenges: { created_by: string; status: string }[],
  viewerId: string,
  max: number,
): ChallengeQuota {
  const used = challenges.filter(
    (c) => c.created_by === viewerId && QUOTA_STATUSES.has(c.status),
  ).length;
  // A max of 0 or less cannot be divided by, and would come from a settings row
  // somebody typed a 0 into. Treat the bar as full rather than rendering NaN.
  const ratio = max > 0 ? Math.min(1, used / max) : 1;
  return { used, max, full: used >= max, ratio };
}

// ─────────────────────────────────────────────────────────────
// Name + handle
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Which sections a challenge belongs in
// ─────────────────────────────────────────────────────────────

/**
 * Over. Nothing here is waiting on anybody, and none of it belongs in a live
 * section.
 *
 * 'expired' is the one this list was missing, and it is why the split moved out
 * of the page and into a tested function. The hourly sweep (see expiryState)
 * writes that status, but the old filters only excluded completed, walkover,
 * rejected and cancelled — so a lapsed challenge kept sitting under "Your
 * challenges" looking live, and one the viewer had never answered stayed pinned
 * at the top of the screen asking for a reply that no longer means anything.
 */
const TERMINAL_STATUSES = new Set([
  'completed',
  'walkover_confirmed',
  'rejected',
  'cancelled',
  'expired',
]);

export interface PartitionableChallenge {
  status: string;
  created_by: string;
  /** The VIEWER's own row in challenge_participants, not the challenge's. */
  confirmation_status: string;
}

export interface ChallengePartition<T> {
  incoming: T[];
  active: T[];
  outgoing: T[];
  archived: T[];
}

/**
 * The four buckets the list is grouped into.
 *
 * A challenge can land in more than one, and that is deliberate: a
 * partially_confirmed one the viewer has not answered is both the thing most
 * needing their attention and a live match in progress, and dropping it from
 * "Active" to avoid the repeat would hide it from the section a member scans
 * for "what am I playing". The pinned copy is the call to action; the other is
 * context.
 *
 * 'disputed' and 'walkover_pending' are deliberately in neither terminal nor
 * incoming: they are live, unresolved, and land in Active or Your challenges
 * where somebody will see them.
 */
export function partitionChallenges<T extends { challenge: PartitionableChallenge }>(
  rows: T[],
  viewerId: string,
): ChallengePartition<T> {
  const live = (r: T) => !TERMINAL_STATUSES.has(r.challenge.status);
  return {
    incoming: rows.filter(
      (r) => live(r) && r.challenge.created_by !== viewerId && r.challenge.confirmation_status === 'pending',
    ),
    active: rows.filter((r) => ['accepted', 'partially_confirmed'].includes(r.challenge.status)),
    outgoing: rows.filter((r) => live(r) && r.challenge.created_by === viewerId),
    archived: rows.filter((r) => TERMINAL_STATUSES.has(r.challenge.status)),
  };
}

/**
 * The search key for a challenge: every name on it, and every handle.
 *
 * Both, never one or the other. The handle travels BESIDE the name everywhere
 * this app shows a person — the rule 00092 wrote into get_leaderboard() — and
 * the ladder's search box already accepts either, so a member who found someone
 * by "@kiera" there and cannot find them here has hit a bug, not a limitation.
 *
 * The leading '@' is deliberately not stored. filterRowsByPlayers matches on
 * substrings, so the bare handle answers both "kiera" and "@kiera", while
 * storing "@kiera" would answer only the second.
 */
export function challengeSearchKeys(
  people: ({ full_name?: string | null; handle?: string | null } | null | undefined)[],
): string[] {
  const keys = people.flatMap((p) => [p?.full_name?.trim(), p?.handle?.trim()]);
  return Array.from(new Set(keys.filter((k): k is string => Boolean(k))));
}
