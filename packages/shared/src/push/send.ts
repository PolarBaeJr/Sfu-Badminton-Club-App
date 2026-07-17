import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

// Payload shape consumed by apps/player/public/sw.js push handler.
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

function getVapidConfig(): { publicKey: string; privateKey: string; email: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL;
  if (!publicKey || !privateKey || !email) return null;
  return { publicKey, privateKey, email };
}

export async function sendPushToPlayers(
  supabase: SupabaseClient,
  playerIds: string[],
  payload: PushPayload
): Promise<void> {
  // Push is optional until VAPID keys are configured — no-op gracefully.
  const vapid = getVapidConfig();
  if (!vapid || playerIds.length === 0) return;

  webpush.setVapidDetails(`mailto:${vapid.email}`, vapid.publicKey, vapid.privateKey);

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh_key, auth_key')
    .in('player_id', playerIds)
    .eq('active', true);

  if (error) throw new Error(`Failed to load push subscriptions: ${error.message}`);
  if (!subscriptions || subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
          body
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription is gone — deactivate it (matches push-client.ts unsubscribe).
          await supabase.from('push_subscriptions').update({ active: false }).eq('id', sub.id);
        } else {
          throw err;
        }
      }
    })
  );
}

export async function sendPushToPlayer(
  supabase: SupabaseClient,
  playerId: string,
  payload: PushPayload
): Promise<void> {
  await sendPushToPlayers(supabase, [playerId], payload);
}
