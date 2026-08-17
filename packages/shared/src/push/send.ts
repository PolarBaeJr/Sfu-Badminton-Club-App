import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { selectInChunks } from '../utils/query-chunks';
import { mapWithConcurrency } from '../utils/concurrency';

/**
 * How many pushes may be in flight at once.
 *
 * Each send is an outbound TLS handshake to a push service PLUS an ECDSA P-256
 * VAPID signature and an AES128GCM payload encryption — CPU-bound, per message.
 * `Promise.all` over the whole roster starts all of them: at 500 members with
 * ~1.3 devices each that is ~650 simultaneous handshakes and signings from the
 * Next container, on a 4-core Pi that also hosts three Supabase stacks, the
 * reverse proxy and both apps, with the memory cgroup disabled and no container
 * limits to contain the result. It is fire-and-forget, so nobody is watching.
 *
 * 10 is ~2× the cores: enough to keep the crypto busy and hide per-request
 * latency, with headroom left for the request the container is actually
 * serving. 650 sends at 10-wide is a few seconds of wall clock on a path
 * nothing awaits.
 *
 * NOT applied to the weekly digest, which is sequential ON PURPOSE — its
 * comment explains that a burst of mail against a fresh sender reputation is
 * what gets throttled. That is a provider-reputation constraint, not a host
 * one, and this bound does not answer it.
 */
export const PUSH_CONCURRENCY = 10;

// Payload shape consumed by apps/player/public/sw.js push handler.
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

interface Subscription {
  id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
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

  // Chunked: `.in()` goes in the query string, and a club-wide push asks about
  // every member at once. Past ~215 uuids the request line exceeds the proxy's
  // 8 KB cap and the read 414s — see utils/query-chunks.
  const { data: subscriptions, error } = await selectInChunks<Subscription>(
    playerIds,
    (batch) =>
      supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh_key, auth_key')
        .in('player_id', batch)
        .eq('active', true) as PromiseLike<{
        data: Subscription[] | null;
        error: { message: string } | null;
      }>,
  );

  // Unchanged on purpose: a failed read still throws rather than pushing to
  // whichever chunks happened to answer. A partial recipient list is not a
  // smaller version of this bug, it is a quieter one.
  if (error) throw new Error(`Failed to load push subscriptions: ${error.message}`);
  if (!subscriptions || subscriptions.length === 0) return;

  const body = JSON.stringify(payload);

  // The first non-expiry error is RECORDED and rethrown after the pool drains,
  // not thrown from inside it — and that changes with the concurrency bound
  // rather than being a free choice.
  //
  // Unbounded, `Promise.all` had already started every send before any of them
  // could reject, so a 429 from one push service cost that one message and
  // nothing else. Bounded, a throw from the task stops the pool: one bad
  // endpoint at subscription 5 would leave 15 through 650 never attempted,
  // reported as a single Sentry event indistinguishable from the old one, and
  // retried by nobody. That is the same silent-partial-delivery failure the
  // chunked read above refuses to have, on the send side.
  //
  // The error still surfaces, so a genuine provider fault stays visible.
  let firstSendError: unknown;
  let sendFailed = false;
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
      } else if (!sendFailed) {
        sendFailed = true;
        firstSendError = err;
      }
    }
  });
  if (sendFailed) throw firstSendError;
}

export async function sendPushToPlayer(
  supabase: SupabaseClient,
  playerId: string,
  payload: PushPayload
): Promise<void> {
  await sendPushToPlayers(supabase, [playerId], payload);
}
