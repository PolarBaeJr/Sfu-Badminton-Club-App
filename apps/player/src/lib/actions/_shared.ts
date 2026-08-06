// Internal helpers for server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files. Keeping them out of the
// 'use server' boundary lets us keep `getPlayerProps` synchronous.
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PostHog } from 'posthog-node';
import { getMissingLegalDocuments, isPushCategoryEnabled, ExpectedError, isExpectedFailure, type NotificationCategory } from '@badminton/shared';
import { sendPushToPlayers, type PushPayload } from '@badminton/shared/src/push/send';
import { getCurrentPlayer, createServiceRoleClient } from '../supabase-server';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// Next.js control-flow errors (redirect/notFound) throw and MUST propagate.
const NEXT_CONTROL_FLOW = /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/;

// Wrap a server-action body so thrown errors become a serializable
// { ok:false, error } value the client can display. Without this, Next.js
// redacts thrown Server Action messages in production to a generic digest.
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const digest = (err as { digest?: string } | null)?.digest;
    if (typeof digest === 'string' && NEXT_CONTROL_FLOW.test(digest)) throw err;
    // Returning the error as a value (so it survives Next.js's prod redaction)
    // means it never reaches Sentry's automatic server-action capture — report
    // it here so the error is still logged, then return the user-facing message.
    // ExpectedErrors are ordinary user-facing rejections (failed validation, an
    // unapproved account); they still reach the caller, they just aren't faults.
    // isExpectedFailure also matches an allowlisted guard message arriving as a
    // plain Error, which is how score-format rejections were reaching Sentry.
    if (!isExpectedFailure(err)) Sentry.captureException(err);
    return { ok: false, error: err instanceof Error ? err.message : 'Something went wrong' };
  }
}

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
    throw new ExpectedError('Not authenticated');
  }
  if (player.status === 'pending_approval') {
    Sentry.setUser(null);
    throw new ExpectedError('Account pending approval');
  }
  if (player.status === 'suspended') {
    Sentry.setUser(null);
    throw new ExpectedError('Account suspended');
  }
  // is_banned is an independent column, not folded into status — without this
  // a banned player could still create/accept challenges, check into sessions
  // and submit rated results (tournament register/check-in already re-check it).
  if (player.is_banned) {
    Sentry.setUser(null);
    throw new ExpectedError('Account suspended pending reinstatement');
  }
  Sentry.setUser({ id: player.id });
  return player;
}

// Blocks gameplay actions (check-in, challenges, tournament registration)
// until the player has accepted the current version of all four legal
// documents — with the waiver re-signed within the last year (annual
// renewal, see getMissingLegalDocuments). `player` comes from
// requirePlayer()/getCurrentPlayer(), whose select embeds
// waiver_acceptances(document, version, accepted_at). legal_documents holds
// four tiny rows, so the version fetch is cheap.
export async function assertCurrentWaiver(
  supabase: SupabaseClient,
  player: {
    waiver_reset_at?: string | null;
    waiver_acceptances?: { document: string; version: string; accepted_at: string }[] | null;
  }
) {
  const { data: docs } = await supabase
    .from('legal_documents')
    .select('document, version, reacceptance_required_since');
  if (!docs || docs.length === 0) return;

  const missing = getMissingLegalDocuments(docs, player.waiver_acceptances ?? [], new Date(), player.waiver_reset_at);
  if (missing.length > 0) {
    throw new ExpectedError("Please accept the club's current legal documents before playing");
  }
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
  pushPayload?: PushPayload,
  pushCategory?: NotificationCategory
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
    let playerIds = notificationRows.map((r) => r.player_id);
    // In-app rows above always land; push honors per-category preferences.
    if (pushCategory) {
      const { data } = await serviceClient
        .from('players')
        .select('id, notification_preferences')
        .in('id', playerIds);
      if (data) {
        playerIds = data
          .filter((p) => isPushCategoryEnabled(p.notification_preferences, pushCategory))
          .map((p) => p.id);
      }
    }
    if (playerIds.length === 0) return;
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
