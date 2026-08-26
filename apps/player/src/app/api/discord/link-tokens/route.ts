import { NextResponse } from 'next/server';
import {
  DISCORD_LINK_TOKEN_TTL_MINUTES,
  getClientIp,
  hashDiscordLinkToken,
  rateLimit,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Mint a one-time /link token.
//
// The APP generates it, not the bot. The bot could perfectly well produce 32
// random bytes itself, but then the token would exist in two processes and the
// hashing would have two call sites; here the plaintext is created, hashed and
// handed back in a single function, and the only copy that ever leaves is the
// one the member is about to click.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  // Tighter than the members read: this one writes a row per call, and the
  // caller is a single bot process rather than a crowd.
  const limited = rateLimit(`discord:link-tokens:${ip}`, 30, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { discordUserId, guildId } = (body ?? {}) as {
    discordUserId?: unknown;
    guildId?: unknown;
  };

  // Discord snowflakes are digit strings. Checked because this value is stored
  // and later compared against the id of whoever ran the command.
  if (typeof discordUserId !== 'string' || !/^\d{5,25}$/.test(discordUserId)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (guildId !== undefined && guildId !== null && typeof guildId !== 'string') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // ALREADY CONNECTED? Refuse before minting.
  //
  // Checked against the database, not against the Discord role: the role is
  // derived from this table by the sweep and can drift (somebody removes it by
  // hand, a sweep fails), so the role answers "what does Discord show" while
  // this answers "is this account connected", which is the actual question.
  //
  // Keyed on the CALLING Discord account, which is what keeps the documented
  // account-move working. 00165 allows re-linking to replace the row, and the
  // way somebody moves to a new Discord account is to run /link from the NEW
  // one -- that account has no row here, so it is not blocked. Only re-running
  // /link on an account that is already connected is, and for that the honest
  // answer is /unlink first.
  //
  // Not a security control. consume_discord_link_token re-checks ownership and
  // raises if the account belongs to a different member; this exists so the
  // member is told plainly instead of being handed a token that cannot work.
  const existing = await createServiceRoleClient()
    .from('player_discord_links')
    .select('discord_user_id')
    .eq('discord_user_id', discordUserId)
    .maybeSingle();

  if (existing.error) {
    // Named for the same reason the mint failure is: a silent failure here
    // would fall through and hand out a token on a table read that did not work.
    console.error('[discord] link precheck failed:', existing.error.message);
    return NextResponse.json(
      { error: 'precheck_failed', detail: existing.error.message },
      { status: 503 }
    );
  }

  if (existing.data) {
    return NextResponse.json({ error: 'already_linked' }, { status: 409 });
  }

  // 32 bytes, matching DISCORD_LINK_TOKEN_REGEX. crypto.getRandomValues rather
  // than Math.random for the obvious reason: this string is the entire proof
  // that the person on the website is the person who ran the command.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const expiresAt = new Date(Date.now() + DISCORD_LINK_TOKEN_TTL_MINUTES * 60_000);

  const { error } = await createServiceRoleClient()
    .from('discord_link_tokens')
    .insert({
      token_hash: await hashDiscordLinkToken(token),
      discord_user_id: discordUserId,
      guild_id: typeof guildId === 'string' ? guildId : null,
      expires_at: expiresAt.toISOString(),
    });

  if (error) {
    // Named, for the same reason the members read is: until 00165 is applied
    // this table does not exist, and a silent failure here would hand the
    // member a link that can never work.
    console.error('[discord] link token mint failed:', error.message);
    return NextResponse.json({ error: 'mint_failed', detail: error.message }, { status: 503 });
  }

  // The ONLY time the plaintext exists outside this function.
  return NextResponse.json({ token, expiresAt: expiresAt.toISOString() });
}
