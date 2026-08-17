import 'server-only';
import * as Sentry from '@sentry/nextjs';
import type { Database, NotificationCategory } from '@badminton/shared';
import { isPushCategoryEnabled, selectInChunks } from '@badminton/shared';
import { sendPushToPlayers, type PushPayload } from '@badminton/shared/src/push/send';
import type { createAdminClient } from './supabase-server';

type NotificationType = Database['public']['Enums']['notification_type'];

interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

// Keep only players who opted into this category's push. In-app rows are
// inserted for everyone regardless — only push honors per-category preferences,
// and the bell means nothing is lost when a push is withheld.
async function filterPushRecipients(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: string[],
  category: NotificationCategory,
): Promise<string[]> {
  // Chunked. This read is the one that breaks first as the club grows: an
  // announcement to audience `all` passes the whole roster, `.in()` is a
  // query-string filter, and the proxy refuses the request line past ~215
  // uuids. Because the handler below fails closed, that 414 withheld push from
  // EVERY member at once while the in-app bell kept working — a whole-club
  // outage with one Sentry event and nothing a member could report.
  const { data, error } = await selectInChunks<{ id: string; notification_preferences: unknown }>(
    playerIds,
    (batch) =>
      adminClient.from('players').select('id, notification_preferences').in('id', batch) as never,
  );
  // Fail CLOSED, and closed for EVERYONE rather than per chunk: selectInChunks
  // reports the first chunk error instead of letting a failed batch arrive as
  // an empty one, so a partial read cannot quietly reclassify a hundred members
  // as "did not opt in".
  //
  // This used to fall back to the full list on the reasoning that
  // a lookup error should not mute everyone — sound under the old opt-out
  // model, where the fallback matched the default. Under opt-in (00058) it
  // inverts: pushing because we could not read the preferences means buzzing
  // people who never said yes. The in-app notification row is already inserted,
  // so the message still arrives.
  if (error || !data) {
    Sentry.captureException(
      new Error(`Push preference lookup failed, withholding push: ${error?.message ?? 'no data'}`),
      { extra: { category, playerIds } },
    );
    return [];
  }
  return data
    .filter((p) => isPushCategoryEnabled(p.notification_preferences, category))
    .map((p) => p.id);
}

// Fan an event out to players over both channels: an in-app notification row
// (the bell — always works, no VAPID/subscription dependency) and, when a push
// payload is supplied, a best-effort web push to the same players. Both are
// best-effort: a failure in either channel is reported to Sentry but never
// throws, so the parent admin action still succeeds. Uses the service-role
// admin client because notifications RLS blocks inserting rows for other
// players and push_subscriptions RLS only lets a player read their own rows.
export async function notifyPlayers(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: string[],
  input: NotifyInput,
  push?: PushPayload,
  pushCategory?: NotificationCategory,
): Promise<void> {
  if (playerIds.length === 0) return;

  try {
    const rows = playerIds.map((pid) => ({
      player_id: pid,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      metadata: input.metadata ?? {},
    }));
    const { error } = await adminClient.from('notifications').insert(rows);
    if (error) throw error;
  } catch (err) {
    Sentry.captureException(err);
  }

  if (push) {
    // Fire-and-forget: web push must never block or fail the parent action.
    // When a category is given, respect each player's per-category push prefs.
    const recipients = pushCategory
      ? await filterPushRecipients(adminClient, playerIds, pushCategory)
      : playerIds;
    if (recipients.length > 0) {
      sendPushToPlayers(adminClient, recipients, push).catch((err) => Sentry.captureException(err));
    }
  }
}
