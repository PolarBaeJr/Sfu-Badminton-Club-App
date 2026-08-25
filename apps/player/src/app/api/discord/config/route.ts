import { NextResponse } from 'next/server';
import { getClientIp, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

/** A guild the bot should manage, and the role ids to use in it. */
interface GuildConfig {
  guildId: string;
  roles: Record<string, string>;
}

// The bot's runtime configuration: which servers it manages, which role ids map
// to which managed role, and where to write the audit log.
//
// These live in the database rather than the bot's env because they change
// while the code stands still — somebody creates a role, moves the audit
// channel, or the club adds a second server. Behind env each of those needs a
// compose recreate on the Pi, and the dashboard's auto-updater rebuilds a
// container by CLONING the previous one's env rather than re-reading env_file,
// so an env edit is exactly the change that has silently failed to land before.
//
// Service-role and service-secret gated, same as /api/discord/members: there is
// no member session behind a bot request, and nothing here is any member's
// business.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  // Looser than the members limit: the bot reads this before every operation,
  // including each interaction, where members is only read by a sweep.
  const limited = rateLimit(`discord:config:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const [guildsResult, rolesResult, settingsResult] = await Promise.all([
    supabase.from('discord_guilds').select('guild_id, enabled'),
    supabase.from('discord_guild_roles').select('guild_id, role_name, role_id'),
    supabase.from('discord_settings').select('key, value'),
  ]);

  // ALL THREE are named rather than swallowed, and the reason is the one that
  // has bitten this project repeatedly: a failed PostgREST read arrives as an
  // EMPTY LIST, never an exception. Without these branches an unmigrated
  // database would answer "no guilds configured", the bot would report a
  // successful sweep over zero servers, and nothing anywhere would say why.
  for (const [what, result] of [
    ['guilds', guildsResult],
    ['roles', rolesResult],
    ['settings', settingsResult],
  ] as const) {
    if (result.error) {
      console.error(`[discord] config ${what} read failed:`, result.error.message);
      return NextResponse.json(
        { error: 'config_unavailable', detail: result.error.message },
        { status: 503 }
      );
    }
  }

  const enabled = new Set(
    (guildsResult.data ?? []).filter((g) => g.enabled).map((g) => g.guild_id)
  );

  const byGuild = new Map<string, Record<string, string>>();
  for (const row of rolesResult.data ?? []) {
    // A role row for a disabled or deleted guild is skipped rather than
    // resurrecting it. `enabled` is how a server is parked without losing the
    // nine role ids somebody typed in off Discord's UI.
    if (!enabled.has(row.guild_id)) continue;
    const roles = byGuild.get(row.guild_id) ?? {};
    roles[row.role_name] = row.role_id;
    byGuild.set(row.guild_id, roles);
  }

  const guilds: GuildConfig[] = [...enabled]
    // A guild with no roles yet is omitted, not sent as an empty map. The bot
    // treats an empty role map as "manage this server, apply nothing", which
    // would strip every managed role from everybody in it.
    .filter((guildId) => byGuild.has(guildId))
    .map((guildId) => ({ guildId, roles: byGuild.get(guildId) ?? {} }));

  const settings = new Map((settingsResult.data ?? []).map((s) => [s.key, s.value]));

  return NextResponse.json({
    guilds,
    auditChannelId: settings.get('audit_channel_id') ?? null,
  });
}
