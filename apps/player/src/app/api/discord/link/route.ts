import { NextResponse } from 'next/server';
import { getClientIp, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// /unlink, from the bot's side.
//
// Deleting the row is all this does; the trigger from 00165 turns that delete
// into a revocation tombstone, so the roles are guaranteed to come off even if
// the bot dies immediately after this call. The bot then strips them straight
// away as the fast path, which is why the response says whether a link actually
// existed — an /unlink from somebody who was never linked must not report
// success, and must not leave a tombstone chasing an account we never touched.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:unlink:${ip}`, 30, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { discordUserId } = (body ?? {}) as { discordUserId?: unknown };
  if (typeof discordUserId !== 'string' || !/^\d{5,25}$/.test(discordUserId)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // BY DISCORD ID, never by player id. The bot only ever knows who ran the
  // command, and that is exactly the right authority: it can unlink the caller
  // and nobody else. There is no parameter here that could name another member.
  const { data, error } = await createServiceRoleClient()
    .from('player_discord_links')
    .delete()
    .eq('discord_user_id', discordUserId)
    .select('discord_user_id');

  if (error) {
    console.error('[discord] unlink failed:', error.message);
    return NextResponse.json({ error: 'unlink_failed', detail: error.message }, { status: 503 });
  }

  return NextResponse.json({ unlinked: (data ?? []).length > 0 });
}
