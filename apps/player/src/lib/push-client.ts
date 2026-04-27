'use client';

import { getPostHogClient } from '@/lib/posthog';

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function isPushEnabled(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub !== null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function subscribeToPush(playerId: string): Promise<boolean> {
  if (!isPushSupported()) return false;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const reg = await navigator.serviceWorker.ready;
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) {
      console.error('VAPID public key not configured');
      return false;
    }

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
    });

    const keys = subscription.toJSON().keys;

    // Save to Supabase
    const { createClient } = await import('@badminton/shared/supabase-browser');
    const supabase = createClient();
    const { error } = await supabase.from('push_subscriptions').insert({
      player_id: playerId,
      endpoint: subscription.endpoint,
      p256dh_key: keys?.p256dh || '',
      auth_key: keys?.auth || '',
      user_agent: navigator.userAgent,
      active: true,
    });

    if (error) {
      console.error('Failed to save push subscription:', error);
      return false;
    }

    const ph = getPostHogClient();
    if (ph) ph.capture('push_notification_subscribed', { player_id: playerId });

    return true;
  } catch (err) {
    console.error('Push subscribe failed:', err);
    return false;
  }
}

export async function unsubscribeFromPush(playerId: string): Promise<boolean> {
  if (!isPushSupported()) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();

    if (subscription) {
      // Remove from DB
      const { createClient } = await import('@badminton/shared/supabase-browser');
      const supabase = createClient();
      await supabase.from('push_subscriptions')
        .update({ active: false })
        .eq('player_id', playerId)
        .eq('endpoint', subscription.endpoint);

      await subscription.unsubscribe();
    }

    return true;
  } catch (err) {
    console.error('Push unsubscribe failed:', err);
    return false;
  }
}
