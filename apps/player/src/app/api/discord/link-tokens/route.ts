import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { mintDiscordLinkToken } from '@/lib/discord-link';

export const dynamic = 'force-dynamic';

// Mint a one-time /link token.
//
// The APP generates it, not the bot (lib/discord-link.ts says why), and the
// only copy that ever leaves is the one the member is about to click.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

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

  const minted = await mintDiscordLinkToken(
    createServiceRoleClient(),
    discordUserId,
    typeof guildId === 'string' ? guildId : null
  );

  if (!minted.ok) {
    // Named, for the same reason the members read is: until 00165 is applied
    // this table does not exist, and a silent failure here would hand the
    // member a link that can never work.
    console.error('[discord] link token mint failed:', minted.error);
    return NextResponse.json({ error: 'mint_failed', detail: minted.error }, { status: 503 });
  }

  // The ONLY time the plaintext exists outside the mint.
  return NextResponse.json({ token: minted.token, expiresAt: minted.expiresAt.toISOString() });
}
