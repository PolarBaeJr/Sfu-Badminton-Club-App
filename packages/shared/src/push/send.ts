interface PushPayload {
  title: string;
  body: string;
  url?: string;
  [key: string]: unknown;
}

interface SupabaseAdminLike {
  from: (table: string) => {
    select: (...args: unknown[]) => { eq: (...args: unknown[]) => { eq: (...args: unknown[]) => { data: unknown[] | null } } };
    update: (data: unknown) => { eq: (...args: unknown[]) => unknown };
  };
}

export async function sendPushNotification(
  playerId: string,
  payload: PushPayload,
  supabaseAdmin: SupabaseAdminLike
): Promise<void> {
  const { data: subscriptions } = await (supabaseAdmin as Record<string, unknown> as { from: (t: string) => Record<string, unknown> })
    .from('push_subscriptions') as unknown as { data: Array<{ id: string; endpoint: string; p256dh_key: string; auth_key: string }> | null };

  if (!subscriptions || subscriptions.length === 0) return;

  // Web Push sending requires the web-push npm package on the server side.
  // This is a placeholder — in production, import and use web-push here.
  // The actual sending is handled by Supabase Edge Functions or a server action.
  console.log(`Would send push to ${subscriptions.length} subscriptions for player ${playerId}:`, payload);
}
