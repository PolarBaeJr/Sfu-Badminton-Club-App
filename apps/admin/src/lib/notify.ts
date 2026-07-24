import 'server-only';
import * as Sentry from '@sentry/nextjs';
import type { Database, NotificationCategory } from '@badminton/shared';
import { isPushCategoryEnabled } from '@badminton/shared';
import { sendPushToPlayers, type PushPayload } from '@badminton/shared/src/push/send';
import type { createAdminClient } from './supabase-server';

type NotificationType = Database['public']['Enums']['notification_type'];

interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

// Drop players who turned this category's push off. In-app rows are inserted
// for everyone regardless — only push honors per-category preferences.
async function filterPushRecipients(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: string[],
  category: NotificationCategory,
): Promise<string[]> {
  const { data, error } = await adminClient
    .from('players')
    .select('id, notification_preferences')
    .in('id', playerIds);
  if (error || !data) return playerIds; // fail open — a pref lookup error shouldn't mute everyone
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
