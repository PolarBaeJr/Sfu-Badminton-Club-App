// Where the bot's runtime configuration comes from, and what happens when it
// cannot be reached.
//
// The guild/role map and the audit channel live in the DATABASE, read through
// the app, because they change while the code stands still: a role is created,
// the audit channel moves, the club adds a second server. Behind env each of
// those needs a compose recreate on the Pi — and the dashboard's auto-updater
// rebuilds a container by cloning the previous one's env rather than re-reading
// env_file, so an env edit is the one change most likely to silently not land.
//
// ---- THE FAILURE POLICY, WHICH IS THE WHOLE POINT OF THIS FILE ----
//
// A config fetch can fail. What must NEVER happen is that a failure is read as
// "no guilds configured", because an empty registry is not inert: `desiredRoles`
// is applied per guild, so zero guilds means the sweep walks every linked member
// and does nothing, then reports success. The roles stay wrong and the log says
// it worked.
//
// So the order is:
//
//   1. A successful fetch wins, and is remembered.
//   2. A failed fetch falls back to the LAST SUCCESSFUL one, however old. A
//      slightly stale role map is enormously better than none, and role ids
//      change on the order of never.
//   3. With no successful fetch ever, fall back to DISCORD_GUILDS /
//      DISCORD_AUDIT_CHANNEL_ID in the env. This is the bootstrap path: it lets
//      the bot come up and be useful before 00167 is applied, and it is why
//      those two env vars still exist.
//   4. With none of the above, THROW. The caller turns that into a 500 and a
//      log line; it must not become a quiet sweep over nothing.
//
// A fetch that SUCCEEDS but describes zero guilds is treated as a failure and
// enters the ladder at step 2. "No guilds" is not a configuration this bot can
// be in: with none, there is nothing for it to manage. Accepting it as valid is
// indistinguishable, from the outside, from a sweep that worked.

import { fetchBotConfig } from './api.js';
import { MANAGED_ROLES, parseGuildRegistry, type GuildRegistry, type GuildRoleMap, type ManagedRole } from './roles.js';

export interface BotConfig {
  registry: GuildRegistry;
  auditChannelId: string | undefined;
}

// Short, because the cost of being stale is a role landing a minute late and
// the cost of a fetch is one in-cluster request. Deliberately NOT zero: a burst
// of interactions should not become a burst of config reads.
const CACHE_TTL_MS = 60_000;

let cached: { value: BotConfig; at: number } | null = null;

/** Test seam. Also used by /sync, which has no reason to accept a stale map. */
export function invalidateConfigCache(): void {
  cached = null;
}

/**
 * The registry the API payload describes.
 *
 * Role names are re-checked here even though 00167 has a CHECK constraint doing
 * the same job. The app is a separate deployment that could be older or newer
 * than this bot, and an unknown role name arriving from it is a bug worth
 * surfacing rather than a key to drop on the floor.
 */
function registryFromPayload(
  guilds: { guildId: string; roles: Record<string, string> }[]
): GuildRegistry {
  const registry: GuildRegistry = new Map();
  for (const guild of guilds) {
    const roleMap: GuildRoleMap = {};
    for (const [name, id] of Object.entries(guild.roles)) {
      if (!(MANAGED_ROLES as readonly string[]).includes(name)) {
        throw new Error(`config: guild ${guild.guildId} names an unmanaged role "${name}"`);
      }
      if (typeof id !== 'string' || id === '') {
        throw new Error(`config: guild ${guild.guildId} role "${name}" has no role id`);
      }
      roleMap[name as ManagedRole] = id;
    }
    // Skipped rather than registered empty — see the API route: a guild with no
    // roles would otherwise mean "manage this server, apply nothing", which
    // strips every managed role from everybody in it.
    if (Object.keys(roleMap).length > 0) registry.set(guild.guildId, roleMap);
  }
  return registry;
}

/** The env fallback. Only reached before the first successful fetch. */
function configFromEnv(): BotConfig | null {
  const raw = process.env.DISCORD_GUILDS;
  const channel = process.env.DISCORD_AUDIT_CHANNEL_ID;
  if (!raw || raw.trim() === '') return null;
  return {
    registry: parseGuildRegistry(raw),
    auditChannelId: channel && channel.trim() !== '' ? channel : undefined,
  };
}

/**
 * The bot's configuration, freshest-available.
 *
 * `force` skips the cache — used by the sweep, which runs nightly and has no
 * reason to act on a map read a minute ago.
 */
export async function loadConfig(
  options: { force?: boolean } = {},
  log: (line: string) => void = console.error,
  now: () => number = Date.now
): Promise<BotConfig> {
  if (!options.force && cached && now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const payload = await fetchBotConfig();
    const registry = registryFromPayload(payload.guilds);
    // A SUCCESSFUL fetch that describes zero guilds is not a valid config, and
    // this is the hole the ladder above did not cover: every branch of it
    // guards a fetch that FAILED, so an empty-but-successful read went straight
    // through, cached itself, and let the sweep run over nothing and report
    // ok: true. That is the precise outcome the header of this file says must
    // never happen.
    //
    // It is not hypothetical. The prod-to-staging snapshot drops the public
    // schema nightly, which takes discord_guilds with it — so on staging this
    // state arrives on its own, roughly every morning, without anyone changing
    // a line of code.
    //
    // Treated as a failure rather than thrown on directly, so it inherits the
    // ladder: a previously good registry still wins over it, which is exactly
    // right when the tables were wiped out from under a running bot.
    if (registry.size === 0) {
      throw new Error('config: the app returned no usable guilds');
    }
    const value: BotConfig = {
      registry,
      auditChannelId: payload.auditChannelId ?? undefined,
    };
    cached = { value, at: now() };
    return value;
  } catch (error) {
    if (cached) {
      // Stale, and said out loud. Silence here would let a config endpoint that
      // has been broken for a week look exactly like one that is working.
      log(`[config] fetch failed, using the last good copy: ${String(error)}`);
      return cached.value;
    }
    const fallback = configFromEnv();
    if (fallback) {
      log(`[config] fetch failed and nothing cached, falling back to env: ${String(error)}`);
      return fallback;
    }
    // Nothing to stand on. Throwing is the point: the alternative is an empty
    // registry, which sweeps every member, changes nothing, and reports success.
    throw new Error(
      `cannot load bot config and no DISCORD_GUILDS fallback is set: ${String(error)}`
    );
  }
}
