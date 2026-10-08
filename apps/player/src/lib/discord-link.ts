import { DISCORD_LINK_TOKEN_TTL_MINUTES, hashDiscordLinkToken } from '@badminton/shared';
import type { createServiceRoleClient } from '@/lib/supabase-server';

// The two halves of connecting a Discord account that more than one door
// needs: minting a /link token (the link-tokens route, and Discord /signup,
// which links the account it has just created) and asking the bot to apply
// roles once a link is made (the /link page, and Discord /signup). A plain
// module, not a 'use server' one, so neither is reachable as a Server Action.

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

/**
 * Mint a one-time link token and store its hash. The plaintext is returned
 * once and never stored.
 *
 * The APP generates it, not the bot. The bot could perfectly well produce 32
 * random bytes itself, but then the token would exist in two processes and the
 * hashing would have two call sites; here the plaintext is created, hashed and
 * handed back in a single function.
 */
export async function mintDiscordLinkToken(
  supabase: ServiceClient,
  discordUserId: string,
  guildId: string | null
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: string }> {
  // 32 bytes, matching DISCORD_LINK_TOKEN_REGEX. crypto.getRandomValues rather
  // than Math.random for the obvious reason: this string is the entire proof
  // that the person on the website is the person who ran the command.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const expiresAt = new Date(Date.now() + DISCORD_LINK_TOKEN_TTL_MINUTES * 60_000);

  const { error } = await supabase
    .from('discord_link_tokens')
    .insert({
      token_hash: await hashDiscordLinkToken(token),
      discord_user_id: discordUserId,
      guild_id: guildId,
      expires_at: expiresAt.toISOString(),
    });

  if (error) return { ok: false, error: error.message };
  return { ok: true, token, expiresAt };
}

/**
 * Ask the bot to sync these accounts. Never throws: the link is already made.
 *
 * `reason` only titles the bot's audit entry. It is passed so the log reads
 * "Account linked" for the one moment that actually is a link, rather than
 * filing every connection under the generic resync the sweep also uses.
 */
export async function syncDiscordMembers(
  discordUserIds: string[],
  reason: 'linked' | 'resynced'
): Promise<boolean> {
  const base = process.env.DISCORD_BOT_URL;
  const secret = process.env.DISCORD_SERVICE_SECRET;
  if (!base || !secret) {
    console.error('[discord] cannot sync: DISCORD_BOT_URL or DISCORD_SERVICE_SECRET unset');
    return false;
  }

  try {
    const response = await fetch(new URL('/sync-member', base), {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ discordUserIds, reason }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error('[discord] sync-member ->', response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[discord] sync-member failed:', error);
    return false;
  }
}
