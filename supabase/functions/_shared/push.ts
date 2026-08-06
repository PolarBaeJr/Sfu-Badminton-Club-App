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

// Mirrors NotificationCategory in packages/shared/src/utils/notifications.ts.
export type NotificationCategory =
  | 'challenges'
  | 'matches'
  | 'sessions'
  | 'tournaments'
  | 'announcements';

// Mirrors isPushCategoryEnabled. OPT-IN since migration 00058: a category is on
// only when stored as exactly `true`, so an empty {} means send nothing.
//
// A mirror, like the sender itself, because Deno cannot import the npm
// workspace. It is deliberately kept in THIS file — one copy for all three edge
// functions rather than the same test written at each call site, which is how
// two of them would end up disagreeing.
function isPushCategoryEnabled(preferences: unknown, category: NotificationCategory): boolean {
  if (!preferences || typeof preferences !== 'object') return false;
  return (preferences as Record<string, unknown>)[category] === true;
}

// Drop players who have not opted into this category's push. Without this an
// edge function pushes to everyone regardless of their settings — the per-
// category toggles in the members' app are only real if every sender honours
// them, and this file is the one push path that is not the apps' notifyPlayers.
async function filterByCategory(
  supabase: SupabaseClient,
  playerIds: string[],
  category: NotificationCategory
): Promise<string[]> {
  const { data, error } = await supabase
    .from('players')
    .select('id, notification_preferences')
    .in('id', playerIds);
  // Fail CLOSED. Under opt-in, "we could not read the preferences" is not a
  // licence to push to people who may have said no.
  if (error || !data) {
    console.error('push: failed to load notification preferences:', error?.message);
    return [];
  }
  return (data as Array<{ id: string; notification_preferences: unknown }>)
    .filter((p) => isPushCategoryEnabled(p.notification_preferences, category))
    .map((p) => p.id);
}

export async function sendPushToPlayers(
  supabase: SupabaseClient,
  playerIds: string[],
  payload: PushPayload,
  category?: NotificationCategory
): Promise<void> {
  // Push is optional until VAPID keys are configured — no-op gracefully.
  const publicKey = Deno.env.get('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const email = Deno.env.get('VAPID_EMAIL');
  if (!publicKey || !privateKey || !email || playerIds.length === 0) return;

  const recipients = category
    ? await filterByCategory(supabase, playerIds, category)
    : playerIds;
  if (recipients.length === 0) return;

  webpush.setVapidDetails(`mailto:${email}`, publicKey, privateKey);

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh_key, auth_key')
    .in('player_id', recipients)
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
