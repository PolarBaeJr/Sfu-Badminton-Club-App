// app state -> the set of Discord roles a member should hold.
//
// One direction only. Nothing here ever reads a Discord role and writes it back
// to the app: if it did, anyone who can edit roles in a Discord server would be
// able to promote themselves inside the club, and Discord role edits are not
// audited the way the app's permission changes are. See docs/design/discord-bot.md §5.
//
// This module is deliberately pure — no fetch, no Discord client, no clock. The
// whole of the interesting logic (who gets what, and what a sync should change)
// is decided here so it can be tested without a guild, a token or a database.

/**
 * The roles this bot manages. `admin` is NOT in this list and must never be:
 * it is managed by hand in Discord, it carries a lock icon a bot cannot assign
 * anyway, and `players.role = 'admin'` grants everything on the app side
 * without needing a Discord mirror.
 */
export const MANAGED_ROLES = [
  'linked',
  'session_staff',
  'vp',
  'executives',
  'competitive',
  'recreation',
  'internal',
  'alumni',
  'external',
] as const;

export type ManagedRole = (typeof MANAGED_ROLES)[number];

/**
 * What the app reports about a linked member. Mirrors the payload of
 * `/api/discord/member`; every field is what the APP believes, never what
 * Discord believes.
 */
export interface MemberState {
  status: 'competitive' | 'recreational' | 'pending_approval' | 'suspended';
  membershipType: 'internal' | 'alumni' | 'external';
  isExec: boolean;
  isBanned: boolean;
  /**
   * The heir of the old `players.portfolio`, which was created in 00086 and
   * dropped again in 00087 — the spec's original "VP = portfolio IS NOT NULL"
   * names a column that has not existed since. `custom` is present in the union
   * because it is a storable value, but it is not a VP job; access-level.ts
   * says so in as many words ("`custom` IS NOT A FIFTH VP JOB. It is the empty
   * base"), so it does not earn the role.
   */
  permissionRole: 'finance' | 'tournaments' | 'internal' | 'external' | 'custom' | null;
  /** Resolved app capabilities, already flattened by the app's own resolver. */
  capabilities: string[];
}

// Session staff is the pair, not either half: running check-in needs both the
// attendance write and the token that opens the door. Someone holding only one
// of them is mid-configuration, not staff.
const SESSION_STAFF_CAPABILITIES = [
  'sessions.attendance.write',
  'sessions.checkin.token.write',
];

// The four named jobs, minus `custom` — see MemberState.permissionRole.
const VP_ROLES = ['finance', 'tournaments', 'internal', 'external'];

/**
 * Which managed roles a linked member should hold.
 *
 * Two policies are applied here that the spec did not state outright, both of
 * which follow from its own rule that a role disappears when the app permission
 * behind it does:
 *
 *  - A BANNED member keeps only `linked`. A ban is the club withdrawing access;
 *    leaving them holding `@Internal` would leave the member-only channels open
 *    to exactly the person who was just removed from them.
 *  - A `pending_approval` member gets no membership or team role. Signing up is
 *    not the club letting you in — the same reason the guard refuses a
 *    self-created row that arrives already approved, and the same reason the
 *    owner asked for pending signups to stay off the ladder.
 *
 * Both are visible in the role diff, so getting them wrong is repairable by
 * changing this function and letting the sweep run; neither silently persists.
 */
export function desiredRoles(state: MemberState): Set<ManagedRole> {
  // Linking is a fact about the account, not a permission, so it survives every
  // other condition below — including a ban. It is what tells the sweep that a
  // member is known at all.
  const roles = new Set<ManagedRole>(['linked']);
  if (state.isBanned) return roles;

  const approved = state.status !== 'pending_approval';

  if (state.isExec) roles.add('executives');
  if (state.isExec && state.permissionRole !== null && VP_ROLES.includes(state.permissionRole)) {
    roles.add('vp');
  }
  if (SESSION_STAFF_CAPABILITIES.every((c) => state.capabilities.includes(c))) {
    roles.add('session_staff');
  }

  if (approved && state.status === 'competitive') roles.add('competitive');
  if (approved && state.status === 'recreational') roles.add('recreation');

  if (approved) {
    // membership_type and permission_role BOTH have values called 'internal'
    // and 'external' meaning entirely unrelated things. This switch reads
    // membership_type and nothing else; see the collision note in the spec.
    if (state.membershipType === 'internal') roles.add('internal');
    else if (state.membershipType === 'alumni') roles.add('alumni');
    else if (state.membershipType === 'external') roles.add('external');
  }

  return roles;
}

/** Role IDs for one guild. A role the guild has not configured is absent. */
export type GuildRoleMap = Partial<Record<ManagedRole, string>>;

export type GuildRegistry = Map<string, GuildRoleMap>;

/**
 * Parse DISCORD_GUILDS, which is a JSON object of guild id -> role name -> role id:
 *
 *   {"1234": {"linked": "999", "executives": "888"}}
 *
 * Config, not schema, but deliberately not hardcoded: the bot serves more than
 * one guild and joining another is a config change, not a code change.
 *
 * Unknown role names are REJECTED rather than ignored. A typo'd key that parses
 * silently is a role that never syncs and never reports why, which is the
 * failure mode this whole registry exists to avoid.
 */
export function parseGuildRegistry(raw: string | undefined): GuildRegistry {
  const registry: GuildRegistry = new Map();
  if (!raw || raw.trim() === '') return registry;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DISCORD_GUILDS is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DISCORD_GUILDS must be a JSON object of guild id -> role map');
  }

  for (const [guildId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`DISCORD_GUILDS: guild ${guildId} must map to an object`);
    }
    const roleMap: GuildRoleMap = {};
    for (const [name, id] of Object.entries(value as Record<string, unknown>)) {
      if (!(MANAGED_ROLES as readonly string[]).includes(name)) {
        throw new Error(`DISCORD_GUILDS: guild ${guildId} names an unmanaged role "${name}"`);
      }
      if (typeof id !== 'string' || id === '') {
        throw new Error(`DISCORD_GUILDS: guild ${guildId} role "${name}" must be a role id string`);
      }
      roleMap[name as ManagedRole] = id;
    }
    registry.set(guildId, roleMap);
  }

  return registry;
}

export interface RoleDiff {
  /** Role IDs to add. */
  add: string[];
  /** Role IDs to remove. */
  remove: string[];
}

/**
 * What to change for one member in one guild.
 *
 * `desired` is null for someone who is not linked (or no longer resolves to a
 * player): every managed role comes off, which is what makes `/unlink` and a
 * lapsed account the same code path.
 *
 * ONLY ROLES THIS GUILD HAS CONFIGURED ARE EVER TOUCHED. A role the registry
 * does not name is invisible to the diff, so `Admin`, and every unrelated role
 * the server happens to use, are safe by construction rather than by a
 * blocklist that a future role could fall outside of.
 */
export function roleDiff(
  desired: Set<ManagedRole> | null,
  guildRoles: GuildRoleMap,
  currentRoleIds: readonly string[]
): RoleDiff {
  const held = new Set(currentRoleIds);
  const add: string[] = [];
  const remove: string[] = [];

  for (const role of MANAGED_ROLES) {
    const id = guildRoles[role];
    // A guild missing a given role is a skip, not an error (spec §5).
    if (!id) continue;
    const shouldHold = desired?.has(role) ?? false;
    if (shouldHold && !held.has(id)) add.push(id);
    if (!shouldHold && held.has(id)) remove.push(id);
  }

  return { add, remove };
}
