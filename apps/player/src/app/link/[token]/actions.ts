'use server';

import {
  hashDiscordLinkToken,
  isDiscordLinkToken,
} from '@badminton/shared';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export interface LinkResult {
  ok: boolean;
  message: string;
}

/**
 * Exchange a link token for a link row, then push the roles out.
 *
 * A SERVER ACTION (POST), never a GET. Discord fetches any URL it is shown in
 * order to build a preview, and this route's whole job is to consume a
 * single-use token — so a GET that consumed would be burned by Discord's own
 * crawler before the member ever tapped it. The page renders a button; this is
 * what the button does.
 */
export async function consumeDiscordLink(token: string): Promise<LinkResult> {
  if (!isDiscordLinkToken(token)) {
    return { ok: false, message: 'That link is not valid. Run /link again in Discord.' };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, message: 'Please sign in first, then open the link again.' };
  }

  // The RPC decides WHICH player row gets linked from auth.uid(), not from
  // anything passed here — see 00165. The token proves which Discord account,
  // the session proves which member, and neither one can name the other.
  const { data, error } = await supabase.rpc('consume_discord_link_token', {
    p_token_hash: await hashDiscordLinkToken(token),
  });

  if (error) {
    // The database raises one deliberately vague message for expired,
    // already-used and never-existed alike, so that a guesser cannot learn
    // that a token string was real. Passed through as-is.
    console.error('[discord] link exchange failed:', error.message);
    return { ok: false, message: error.message };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { linked_discord_user_id: string; displaced_discord_user_id: string | null }
    | undefined;

  if (!row?.linked_discord_user_id) {
    return { ok: false, message: 'That link has expired or has already been used.' };
  }

  // Apply the roles NOW. The tombstone from 00165 guarantees the displaced
  // account is cleaned up eventually, but "eventually" is not what somebody
  // staring at a success screen expects — and until something drives the
  // sweep, eventually may not arrive at all.
  const ids = [row.linked_discord_user_id, row.displaced_discord_user_id].filter(
    (id): id is string => typeof id === 'string'
  );
  const synced = await syncDiscordMembers(ids);

  return {
    ok: true,
    message: synced
      ? 'Your Discord account is connected and your roles have been applied.'
      : // Linked is the part that matters and it is already committed; the
        // roles are the sweep's problem now. Do not report this as a failure.
        'Your Discord account is connected. Your roles will appear shortly.',
  };
}

/** Ask the bot to sync these accounts. Never throws — the link is already made. */
async function syncDiscordMembers(discordUserIds: string[]): Promise<boolean> {
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
      body: JSON.stringify({ discordUserIds }),
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
