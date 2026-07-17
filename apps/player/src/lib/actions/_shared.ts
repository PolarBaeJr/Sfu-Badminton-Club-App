// Internal helpers for server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files. Keeping them out of the
// 'use server' boundary lets us keep `getPlayerProps` synchronous.
import * as Sentry from '@sentry/nextjs';
import { PostHog } from 'posthog-node';
import { sendPushToPlayers, type PushPayload } from '@badminton/shared/src/push/send';
import { getCurrentPlayer, createServiceRoleClient } from '../supabase-server';

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

interface NotificationRow {
  player_id: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

// Inserts in-app notification rows and (optionally) fires web push to the same
// players. Both are best-effort: failures go to Sentry, never fail the action.
// Both use the service-role client: notifications RLS has no INSERT policy for
// authenticated users (we insert rows for *other* players), and
// push_subscriptions RLS only lets players read their own rows.
export async function notifyPlayers(
  notificationRows: NotificationRow[],
  pushPayload?: PushPayload
) {
  if (notificationRows.length === 0) return;

  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient.from('notifications').insert(notificationRows);
  if (error) {
    Sentry.captureException(new Error(`Notification insert failed: ${error.message}`), {
      extra: { type: notificationRows[0]?.type, playerIds: notificationRows.map((r) => r.player_id) },
    });
  }

  if (pushPayload) {
    const playerIds = notificationRows.map((r) => r.player_id);
    sendPushToPlayers(serviceClient, playerIds, pushPayload).catch((err) => {
      Sentry.captureException(err, { extra: { push: notificationRows[0]?.type, playerIds } });
    });
  }
}

export function getPlayerProps(player: Record<string, unknown>) {
  const ratings = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
  return {
    player_id: player.id as string,
    player_status: player.status as string,
    singles_elo: ((ratings as Record<string, unknown>)?.singles_elo as number) ?? 400,
    doubles_elo: ((ratings as Record<string, unknown>)?.doubles_elo as number) ?? 400,
  };
}
