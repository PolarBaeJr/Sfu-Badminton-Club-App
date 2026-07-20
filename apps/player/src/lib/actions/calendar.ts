'use server';

import { randomBytes } from 'crypto';
import { createServiceRoleClient } from '../supabase-server';
import { requirePlayer } from './_shared';

// 24 random bytes -> 48 hex chars; the feed route validates this exact shape.
function newFeedToken(): string {
  return randomBytes(24).toString('hex');
}

// Returns the player's calendar feed token, creating one on first use.
// calendar_feed_tokens has no write policies (owner SELECT only), so writes
// go through the service-role client.
export async function getCalendarFeedToken(): Promise<string> {
  const player = await requirePlayer();
  const serviceClient = createServiceRoleClient();

  const { data: existing } = await serviceClient
    .from('calendar_feed_tokens')
    .select('token')
    .eq('player_id', player.id)
    .maybeSingle();
  if (existing) return existing.token;

  const token = newFeedToken();
  const { error } = await serviceClient
    .from('calendar_feed_tokens')
    .insert({ player_id: player.id, token });
  if (error) {
    // Unique-violation race: a concurrent request created the row first —
    // return its token instead of failing.
    const { data: raced } = await serviceClient
      .from('calendar_feed_tokens')
      .select('token')
      .eq('player_id', player.id)
      .maybeSingle();
    if (raced) return raced.token;
    throw new Error('Could not create calendar feed link');
  }
  return token;
}

// Replaces the token with a fresh one (creating the row if it doesn't exist
// yet), immediately revoking every previously shared feed URL.
export async function regenerateCalendarFeedToken(): Promise<string> {
  const player = await requirePlayer();
  const serviceClient = createServiceRoleClient();

  const token = newFeedToken();
  const { error } = await serviceClient
    .from('calendar_feed_tokens')
    .upsert({ player_id: player.id, token });
  if (error) throw new Error('Could not reset calendar feed link');
  return token;
}
