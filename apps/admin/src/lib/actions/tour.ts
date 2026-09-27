'use server';

import { createAdminClient, getAuthenticatedConsoleUser } from '../supabase-server';
import { runAction, type ActionResult } from '../action-result';
import { EXEC_TOUR_KEY } from '../tours/exec-tour';

/**
 * Record that this officer finished or skipped the console tour, so it never
 * starts by itself again on any device (players.tours_seen, 00246).
 *
 * NO PARAMETERS, on purpose. Every argument of a server action is a POST field
 * the client controls, and mark_tour_seen() takes a player id, so the id comes
 * from the session here and the tour key is fixed.
 *
 * getAuthenticatedConsoleUser, not requireCapability: this writes nothing but
 * the caller's own tour record, so any console level may, and skipPasskey
 * because the layout that mounts the tour reads the viewer the same way.
 */
export async function markConsoleTourSeen(): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await getAuthenticatedConsoleUser({ skipPasskey: true });
    const { error } = await createAdminClient().rpc('mark_tour_seen', {
      p_player_id: viewer.id,
      p_tour: EXEC_TOUR_KEY,
    });
    if (error) throw new Error(`mark_tour_seen failed: ${error.message}`);
  });
}
