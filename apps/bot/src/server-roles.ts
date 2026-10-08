import { writeServerRoleCatalog } from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';
import type { DiscordRole } from './setup.js';

// TELLING THE APP WHAT ROLES THE SERVER ACTUALLY HAS.
//
// The console's notify picker used to offer the club's nine and nothing else,
// because those are the only roles the database knew about. Every other role in
// the server was unreachable from the console: @Session Pings, @Competitive Team,
// and the skill tiers the owner intends to create. This posts a CATALOGUE of them
// to the app (00229), where the picker reads it.
//
// ONE DIRECTION, AND IT IS THE HARMLESS ONE. Nothing here assigns a role, reads a
// member, or writes anything into the app's own permission model: it is a list of
// names and ids, of the kind every member of the server can already see. The
// no-reading-roles-back rule in roles.ts is about @Executives deciding who is an
// exec, and that rule is untouched.
//
// DELIBERATELY NOT PART OF THE ROLE MAP. A row in `discord_guild_roles` is read
// as "a role the app manages" by three separate paths, one of which is
// `registryFromPayload` in config.ts, which throws on an unmanaged name and takes
// the bot's whole config load with it. Hence a second table and a second route.

export interface ServerRoleSyncResult {
  /** Guilds whose catalogue was written. */
  synced: number;
  /** Roles posted, across every guild. */
  roles: number;
  /** A guild whose roles could not be read or whose write was refused. */
  failed: number;
  /** A guild with nothing offerable, so nothing was posted. */
  skipped: number;
}

/** What the catalogue route takes. Names, not the whole Discord role object. */
export interface CatalogRole {
  roleId: string;
  name: string;
  /**
   * Optional because /setup posts the roles it has just created, whose position
   * `createGuildRole` does not report back. Nothing reads it except an ordering
   * the console does not use yet, so NULL is honest and an invented 0 would not
   * be.
   */
  position?: number;
}

/**
 * The roles worth offering as a mention, out of everything Discord returned.
 *
 * TWO FILTERS, AND THE TWO THAT ARE NOT HERE MATTER MORE THAN THE TWO THAT ARE.
 *
 *  - `@everyone` GOES. Its id is the guild's own id. It also cannot be notified
 *    through the roles list: only `allowed_mentions: { parse: ["everyone"] }`
 *    rings it, and the console's ping line sends `parse: []` (see payloadFor in
 *    outbox.ts), so offering it would draw a chip that rings nobody.
 *  - `managed: true` GOES. Those are Discord's own: a bot's integration role, a
 *    Nitro booster role. Nobody holds them by choice and nobody can be given one.
 *
 * NOT FILTERED ON `position`, deliberately. `planSetup` in setup.ts has an
 * `above_bot` check and copying it here would be the single easiest way to break
 * this feature: hierarchy governs who may ASSIGN a role, never who may MENTION
 * one, and the roles above the bot are typically @Admin and the exec roles, which
 * is most of what an exec wants to notify.
 *
 * NOT FILTERED ON `mentionable` EITHER, for a reason that is easy to get backwards.
 * `mentionable` controls whether ORDINARY MEMBERS may type the mention; a bot with
 * MENTION_EVERYONE mentions any role regardless, and `createGuildRole` makes the
 * club's own nine with `mentionable: false`. Filtering on it would therefore drop
 * the nine roles the picker already offers today.
 */
export function offerableRoles(roles: DiscordRole[], guildId: string): CatalogRole[] {
  return roles
    .filter((role) => role.id !== guildId && role.managed !== true)
    .map((role) => ({ roleId: role.id, name: role.name, position: role.position }));
}

/**
 * Post every guild's catalogue.
 *
 * RIDES THE EXISTING FIVE MINUTE ANNOUNCEMENTS TICK rather than getting a pg_cron
 * job of its own, which is the same call the outbox drain and the session board
 * made and for the same reason: a new cron job needs an owner to run SQL on
 * production, a step that sits undone while the feature looks shipped. The
 * staleness ceiling is therefore one tick. A deleted role leaves the catalogue
 * within five minutes; a role renamed inside the window makes a stale pick fail
 * at send time with the console's own refusal, which tells the exec to reload.
 *
 * ONE GUILD'S FAILURE NEVER ABORTS THE OTHERS, and no Discord or app fault
 * escapes as a throw: the caller counts on that, because it shares a tick with
 * the outbox drain and a 429 here must not cost somebody their message.
 *
 * `loadConfig` IS THE ONE THING THAT CAN STILL THROW, and it is left to. It
 * throws only when the config fetch failed with nothing cached and no
 * DISCORD_GUILDS fallback, which is the state in which the sweep and the outbox
 * are failing too. The tick's own try/catch around this call turns it into a
 * `serverRoles: null` in the response rather than a 500, which is the same answer
 * as any other fault here. Catching it locally would just report "0 guilds
 * synced" over a bot that cannot see its guilds at all.
 */
export async function runServerRoleSync(): Promise<ServerRoleSyncResult> {
  const result: ServerRoleSyncResult = { synced: 0, roles: 0, failed: 0, skipped: 0 };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] server role sync: DISCORD_BOT_TOKEN is not set');
    return result;
  }

  const { registry } = await loadConfig();
  const api = new DiscordApi({ token });

  for (const guildId of registry.keys()) {
    let roles: CatalogRole[];
    try {
      roles = offerableRoles(await api.listGuildRoles(guildId), guildId);
    } catch (error) {
      // NOTHING IS POSTED, which is what keeps the previous catalogue standing.
      // The route replaces a guild's rows outright, so a failed fetch that
      // posted an empty list would empty the picker.
      console.error(`[bot] server role sync: could not read roles for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    if (roles.length === 0) {
      // A server whose only roles are @everyone and the bot's own. There is
      // nothing to offer and nothing to prune against, so it is left alone.
      result.skipped += 1;
      continue;
    }

    try {
      await writeServerRoleCatalog({ guildId, roles });
      result.synced += 1;
      result.roles += roles.length;
    } catch (error) {
      console.error(`[bot] server role sync: could not save the catalogue for ${guildId}:`, error);
      result.failed += 1;
    }
  }

  return result;
}
