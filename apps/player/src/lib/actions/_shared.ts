// Internal helpers for server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files. Keeping them out of the
// 'use server' boundary lets us keep `getPlayerProps` synchronous.
import * as Sentry from '@sentry/nextjs';
import { PostHog } from 'posthog-node';
import { getCurrentPlayer } from '../supabase-server';

let posthogServer: PostHog | null = null;
function getPostHog(): PostHog | null {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  if (!posthogServer) {
    posthogServer = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogServer;
}

export function trackServerEvent(
  playerId: string,
  event: string,
  properties: Record<string, unknown>
) {
  const ph = getPostHog();
  if (!ph) return;
  ph.capture({ distinctId: playerId, event, properties });
}

export async function requirePlayer() {
  const player = await getCurrentPlayer();
  if (!player) {
    // Clear any Sentry user context left over from a previous request handler
    // sharing this Node process — avoids misattributing the next error.
    Sentry.setUser(null);
    throw new Error('Not authenticated');
  }
  if (player.status === 'pending_approval') {
    Sentry.setUser(null);
    throw new Error('Account pending approval');
  }
  if (player.status === 'suspended') {
    Sentry.setUser(null);
    throw new Error('Account suspended');
  }
  Sentry.setUser({ id: player.id });
  return player;
}

export function getPlayerProps(player: Record<string, unknown>) {
  const ratings = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
  return {
    player_id: player.id as string,
    player_status: player.status as string,
    singles_elo: ((ratings as Record<string, unknown>)?.singles_elo as number) ?? 1200,
    doubles_elo: ((ratings as Record<string, unknown>)?.doubles_elo as number) ?? 1200,
  };
}
