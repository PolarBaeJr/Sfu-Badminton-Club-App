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

// Mirrors packages/shared/src/utils/query-chunks.ts and its derivation, for the
// same reason the sender itself is mirrored: Deno cannot import the npm
// workspace. `.in()` is a QUERY-STRING filter, Kong 3.9.1 refuses a request
// line over 8,192 bytes, a uuid plus its separator is 37 of them, and 4,096 are
// reserved for the path, the select list and any other filter. Measured on the
// production path: 215 ids reached PostgREST, 220 got a 414.
const REQUEST_LINE_LIMIT_BYTES = 8192;
const BYTES_PER_ID = 37;
const RESERVED_REQUEST_BYTES = 4096;
const IN_CHUNK_SIZE = Math.floor((REQUEST_LINE_LIMIT_BYTES - RESERVED_REQUEST_BYTES) / BYTES_PER_ID);

// Mirrors PUSH_CONCURRENCY. Each send is a TLS handshake plus an ECDSA P-256
// signature and an AES128GCM encryption; the edge runtime shares the same Pi as
// three Supabase stacks, the proxy and both Next apps.
const PUSH_CONCURRENCY = 10;

function chunkIds<T>(ids: readonly T[], size = IN_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
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
  // Chunked — see IN_CHUNK_SIZE. An admin alert fans out to every admin and a
  // club-wide reminder to the roster, so this list is not bounded by anything
  // in the schema.
  const rows: Array<{ id: string; notification_preferences: unknown }> = [];
  for (const batch of chunkIds(playerIds)) {
    const { data, error } = await supabase
      .from('players')
      .select('id, notification_preferences')
      .in('id', batch);
    // Fail CLOSED, and closed for EVERYONE. A failed chunk must not arrive as
    // an empty one: that would silently reclassify a hundred members as "did
    // not opt in" and push to the rest, which is quieter than the outage it
    // replaces and therefore worse. Under opt-in, "we could not read the
    // preferences" is not a licence to push to people who may have said no.
    if (error || !data) {
      console.error('push: failed to load notification preferences:', error?.message);
      return [];
    }
    for (const row of data as Array<{ id: string; notification_preferences: unknown }>) {
      rows.push(row);
    }
  }
  return rows
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

  type Subscription = { id: string; endpoint: string; p256dh_key: string; auth_key: string };
  const subscriptions: Subscription[] = [];
  for (const batch of chunkIds(recipients)) {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh_key, auth_key')
      .in('player_id', batch)
      .eq('active', true);

    // Abandons the whole send rather than delivering to whichever chunks
    // answered, matching the Node mirror: a partial recipient list is not a
    // smaller version of this failure, it is a quieter one.
    if (error) {
      console.error('push: failed to load subscriptions:', error.message);
      return;
    }
    for (const sub of (data ?? []) as Subscription[]) subscriptions.push(sub);
  }
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  await mapWithConcurrency(subscriptions, PUSH_CONCURRENCY, async (sub) => {
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
  });
}
