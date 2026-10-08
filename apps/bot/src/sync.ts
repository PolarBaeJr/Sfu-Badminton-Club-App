// Applying a role diff to one guild, and the sweep that walks every guild.
//
// The governing rule is that NOTHING HERE THROWS ON A PREDICTABLE FAILURE. A
// bot cannot modify a member whose top role outranks its own, so a 403 on
// @Executives is not an incident, it is Tuesday — and a sweep that aborts on
// one leaves every member after it in the list unrepaired. Failures are counted
// and reported; the sweep keeps going.

import type { DiscordApi, RoleCallResult } from './discord-api.js';
import {
  membershipFromRoles,
  roleDiff,
  type DiffOptions,
  type GuildRegistry,
  type GuildRoleMap,
  type ManagedRole,
  type MembershipRole,
} from './roles.js';

export interface SyncOutcome {
  guildId: string;
  /** Roles actually added/removed. */
  added: number;
  removed: number;
  /** Calls Discord refused because the member outranks the bot. */
  forbidden: number;
  /** Calls that failed for any other reason. */
  failed: number;
  /** True when the member is not in this guild — nothing was attempted. */
  absent: boolean;
  /**
   * The membership the member's OWN roles assert in this guild, or null for
   * "they have not picked, they picked two, or this guild has no such roles".
   *
   * Read, never written for an ordinary member: the three membership roles are
   * excluded from the diff above unless the caller is revoking.
   *
   * NOTHING READS THIS ANY MORE. It existed so the sweep could compare what
   * Discord said against the app's stored value and push the difference back,
   * and that write-back is gone: the member's own click is the only writer of
   * membership_type left, and a sweep that reasserted it reverted an exec's
   * correction in the console. Kept because it costs nothing to compute (the
   * roles are already in hand) and because it is what any future report of
   * "what Discord currently claims" would be built from.
   */
  membership: MembershipRole | null;
}

/**
 * Bring one member's roles in one guild into line with what the app says.
 *
 * `desired` is null for somebody who is not linked, which strips every managed
 * role. That is what makes /unlink, a lapsed account and a member the app can
 * no longer resolve all the same code path.
 */
export async function syncMemberInGuild(
  api: DiscordApi,
  guildId: string,
  guildRoles: GuildRoleMap,
  discordUserId: string,
  desired: Set<ManagedRole> | null,
  options: DiffOptions = {}
): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    guildId,
    added: 0,
    removed: 0,
    forbidden: 0,
    failed: 0,
    absent: false,
    membership: null,
  };

  let current: string[] | null;
  try {
    current = await api.getMemberRoles(guildId, discordUserId);
  } catch {
    outcome.failed += 1;
    return outcome;
  }

  if (current === null) {
    outcome.absent = true;
    return outcome;
  }

  // BEFORE the diff is applied, because when the caller is revoking, the diff
  // below is about to take these roles off — and the caller wants to know what
  // the member held, not what is left afterwards. (For an ordinary sweep it
  // makes no difference: nothing below touches them.)
  outcome.membership = membershipFromRoles(guildRoles, current);

  const diff = roleDiff(desired, guildRoles, current, options);

  const tally = (result: RoleCallResult, kind: 'added' | 'removed') => {
    if (result === 'ok') outcome[kind] += 1;
    else if (result === 'forbidden') outcome.forbidden += 1;
    // not_found means the role was deleted in Discord since the registry was
    // written, or the member left mid-sweep. Neither is worth failing over, and
    // both fix themselves on the next pass.
    else if (result === 'failed') outcome.failed += 1;
  };

  // Sequential, not Promise.all: these all hit the same per-guild rate limit
  // bucket, and firing nine at once is the reliable way to get 429ed for a
  // saving of milliseconds nobody is waiting on.
  for (const roleId of diff.add) {
    tally(await api.addRole(guildId, discordUserId, roleId), 'added');
  }
  for (const roleId of diff.remove) {
    tally(await api.removeRole(guildId, discordUserId, roleId), 'removed');
  }

  return outcome;
}

/**
 * The same member across every registered guild.
 *
 * A guild the bot has not been configured for is inert — it is not in the
 * registry, so it is not iterated. Joining a new server is a deliberate config
 * change, never something that happens because an invite was accepted.
 */
export async function syncMemberEverywhere(
  api: DiscordApi,
  registry: GuildRegistry,
  discordUserId: string,
  desired: Set<ManagedRole> | null,
  options: DiffOptions = {}
): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  for (const [guildId, guildRoles] of registry) {
    outcomes.push(
      await syncMemberInGuild(api, guildId, guildRoles, discordUserId, desired, options)
    );
  }
  return outcomes;
}

/** One line per sync, for the logs. Counts, never role ids. */
export function describeOutcomes(discordUserId: string, outcomes: SyncOutcome[]): string {
  const total = outcomes.reduce(
    (acc, o) => ({
      added: acc.added + o.added,
      removed: acc.removed + o.removed,
      forbidden: acc.forbidden + o.forbidden,
      failed: acc.failed + o.failed,
      absent: acc.absent + (o.absent ? 1 : 0),
    }),
    { added: 0, removed: 0, forbidden: 0, failed: 0, absent: 0 }
  );
  return (
    `[sync] ${discordUserId}: +${total.added} -${total.removed}` +
    ` forbidden=${total.forbidden} failed=${total.failed} absent=${total.absent}`
  );
}
