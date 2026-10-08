// Working out, from the roles a guild already has, what /setup should adopt and
// what it should create.
//
// Pure: no fetch, no token, no clock — same reason roles.ts is. The interesting
// decisions (does this existing role mean `session_staff`? is this name too
// ambiguous to guess at?) are all made here so they can be tested without a
// guild.

import { MANAGED_ROLES, type ManagedRole } from './roles.js';

/** The subset of Discord's role object this module needs. */
export interface DiscordRole {
  id: string;
  name: string;
  /** Higher is further up the list. A bot can only touch roles below its own. */
  position: number;
  /**
   * True for roles Discord itself owns — a bot's own integration role, a
   * Nitro booster role. Nobody can assign these, including us.
   */
  managed?: boolean;
  /**
   * The role's permission mask, as a DECIMAL STRING — Discord sends it that way
   * because it is 64 bits wide and JSON numbers are not. Read by
   * hasManageEvents; parse it with BigInt, never Number.
   */
  permissions?: string;
}

/**
 * What a managed role is CALLED when we have to create it.
 *
 * Only used for creation. Matching is done on the normalised form below, so a
 * club that already calls it "session-staff" or "SESSION STAFF" keeps its own
 * name and we adopt it rather than making a near-duplicate.
 */
export const DISPLAY_NAMES: Record<ManagedRole, string> = {
  linked: 'Linked',
  session_staff: 'Session Staff',
  vp: 'VP',
  executives: 'Executives',
  competitive: 'Competitive',
  recreation: 'Recreation',
  internal: 'Internal',
  alumni: 'Alumni',
  external: 'External',
};

/**
 * Strip a role name down to something comparable.
 *
 * "Session Staff", "session-staff", "session_staff" and "SessionStaff" are
 * obviously the same role to a human, and a club that already made one should
 * not end up with a second. Case and every separator go.
 */
export function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface MatchedRole {
  role: ManagedRole;
  id: string;
  /** The guild's own name for it, which we keep. */
  name: string;
}

export interface AmbiguousRole {
  role: ManagedRole;
  names: string[];
}

export interface UnusableRole {
  role: ManagedRole;
  name: string;
  reason: 'discord_managed' | 'above_bot';
}

export interface SetupPlan {
  /** Already exists and is usable — adopt its id. */
  matched: MatchedRole[];
  /** Nothing matched — create it. */
  toCreate: ManagedRole[];
  /**
   * More than one existing role claims the same slot. NOT guessed at: picking
   * one at random decides which Discord role the bot hands out to everybody who
   * qualifies, and being wrong there is a permissions incident, not a typo.
   */
  ambiguous: AmbiguousRole[];
  /** Matched, but we cannot use it. Reported so the operator can fix it. */
  unusable: UnusableRole[];
}

/**
 * Decide what to adopt and what to create.
 *
 * `botPosition` is the position of the bot's own highest role. Discord refuses
 * to let a bot assign any role at or above that, so a role matched above the
 * bot is reported as unusable rather than silently wired up to fail on every
 * sweep — which is the single most common way this bot appears to work while
 * changing nothing.
 */
export function planSetup(existing: DiscordRole[], botPosition: number): SetupPlan {
  const byKey = new Map<string, DiscordRole[]>();
  for (const role of existing) {
    // @everyone shares the guild id and is not assignable; it normalises to
    // "everyone" and would never match a managed name anyway, but skipping it
    // keeps the ambiguity report honest.
    if (role.name === '@everyone') continue;
    const key = normalize(role.name);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(role);
    else byKey.set(key, [role]);
  }

  const plan: SetupPlan = { matched: [], toCreate: [], ambiguous: [], unusable: [] };

  for (const managed of MANAGED_ROLES) {
    const candidates = byKey.get(normalize(DISPLAY_NAMES[managed])) ?? [];

    if (candidates.length === 0) {
      plan.toCreate.push(managed);
      continue;
    }
    if (candidates.length > 1) {
      plan.ambiguous.push({ role: managed, names: candidates.map((c) => c.name) });
      continue;
    }

    const role = candidates[0];
    if (!role) continue; // unreachable: length checked above, but the compiler cannot see it
    if (role.managed) {
      plan.unusable.push({ role: managed, name: role.name, reason: 'discord_managed' });
      continue;
    }
    if (role.position >= botPosition) {
      plan.unusable.push({ role: managed, name: role.name, reason: 'above_bot' });
      continue;
    }
    plan.matched.push({ role: managed, id: role.id, name: role.name });
  }

  return plan;
}
