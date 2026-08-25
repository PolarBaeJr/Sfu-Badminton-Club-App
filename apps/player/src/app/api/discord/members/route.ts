import { NextResponse } from 'next/server';
import {
  accessLevelFor,
  effectiveCapabilities,
  getClientIp,
  rateLimit,
  resolvePermissions,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Every linked member, and what the app currently believes about them.
//
// The reconciliation sweep's input, and the ONE place the app decides what a
// Discord role means. The bot turns this into role ids; it never decides who
// deserves one. That split is the core rule of the whole design — Discord
// authenticates the person through the link, the app controls everything else.
//
// SERVICE ROLE, deliberately. There is no member session behind a sweep, and
// the rows it needs (every member's status and permissions) are exactly what a
// member must not be able to read about everyone else. The endpoint is instead
// gated on the shared service secret, which is why isAuthorizedDiscordService
// fails closed when that secret is unset.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:members:${ip}`, 12, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('player_discord_links')
    .select(
      'discord_user_id, player_id, players!inner(status, membership_type, is_exec, is_trainer, is_banned, role, permission_role, permission_grants, permission_revokes)'
    );

  if (error) {
    // NAMED, not swallowed. Until 00165 is applied this table does not exist,
    // and a failed PostgREST read arrives as an empty list rather than an
    // exception — so without this branch an unmigrated database would report
    // "0 linked members" and the sweep would look like a quiet success while
    // silently doing nothing.
    console.error('[discord] members read failed:', error.message);
    return NextResponse.json(
      { error: 'members_unavailable', detail: error.message },
      { status: 503 }
    );
  }

  const members = (data ?? []).map((row) => {
    // createServiceRoleClient is not generic over Database, so the embedded
    // row arrives as any. Annotated once, here, at the boundary.
    const link = row as unknown as {
      discord_user_id: string;
      players: {
        status: string;
        membership_type: string | null;
        is_exec: boolean | null;
        is_trainer: boolean | null;
        is_banned: boolean | null;
        role: string | null;
        permission_role: string | null;
        permission_grants: string[] | null;
        permission_revokes: string[] | null;
      } | null;
    };

    const player = link.players;
    if (!player) return { discordUserId: link.discord_user_id, state: null };

    // The SAME resolver the console gates on, not a reimplementation of it.
    // A second copy of these rules is a second thing to keep in step, and the
    // failure would be silent: a Discord role that outlives the permission.
    const level = accessLevelFor(player);
    const permissions = resolvePermissions(
      level,
      player.permission_role,
      player.permission_grants ?? [],
      player.permission_revokes ?? []
    );

    return {
      discordUserId: link.discord_user_id,
      state: {
        status: player.status,
        // Mirrors formatMembershipType's fallback: a null membership_type is an
        // ordinary internal member, which is what the column's default says.
        membershipType: player.membership_type ?? 'internal',
        isExec: player.is_exec ?? false,
        isBanned: player.is_banned ?? false,
        permissionRole: player.permission_role,
        capabilities: [...effectiveCapabilities(level, permissions)],
      },
    };
  });

  return NextResponse.json({ members });
}
