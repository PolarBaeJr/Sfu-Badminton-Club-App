// Web push sender for edge functions. Mirrors packages/shared/src/push/send.ts
// (Deno cannot import the npm workspace) — keep the payload shape in sync with
// the sw.js push handler: { title, body, url }.
import webpush from 'npm:web-push@3.6.7';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export async function sendPushToPlayers(
  supabase: SupabaseClient,
  playerIds: string[],
  payload: PushPayload
): Promise<void> {
  // Push is optional until VAPID keys are configured — no-op gracefully.
  const publicKey = Deno.env.get('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const email = Deno.env.get('VAPID_EMAIL');
  if (!publicKey || !privateKey || !email || playerIds.length === 0) return;

  webpush.setVapidDetails(`mailto:${email}`, publicKey, privateKey);

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh_key, auth_key')
    .in('player_id', playerIds)
    .eq('active', true);

  if (error) {
    console.error('push: failed to load subscriptions:', error.message);
    return;
  }
  if (!subscriptions || subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    (subscriptions as Array<{ id: string; endpoint: string; p256dh_key: string; auth_key: string }>).map(
      async (sub) => {
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
            console.error('push: send failed:', err);
          }
        }
      }
    )
  );
}
