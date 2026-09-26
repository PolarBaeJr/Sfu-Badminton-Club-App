'use server';

import { ExpectedError } from '@badminton/shared';
import { createServiceRoleClient, getCurrentPlayer } from '../supabase-server';
import { MEMBER_TOUR_KEY } from '../tours/member-tour';
import { runAction, type ActionResult } from './_shared';

/**
 * Record that this member finished or skipped the app tour, so it never starts
 * by itself again on any device (players.tours_seen, 00246).
 *
 * NO PARAMETERS, on purpose. Every argument of a server action is a POST field
 * the client controls, and mark_tour_seen() takes a player id, so the id comes
 * from the session here and the tour key is fixed.
 *
 * getCurrentPlayer(), not requirePlayer(): a pending signup can take the tour
 * too, and nothing about recording it needs an approved account.
 *
 * No revalidatePath. Nothing on screen reads the column except the tour host,
 * which has already closed the tour and remembered it on the device.
 */
export async function markMemberTourSeen(): Promise<ActionResult> {
  return runAction(async () => {
    const player = await getCurrentPlayer();
    if (!player) throw new ExpectedError('Not authenticated');
    const { error } = await createServiceRoleClient().rpc('mark_tour_seen', {
      p_player_id: player.id,
      p_tour: MEMBER_TOUR_KEY,
    });
    if (error) throw new Error(`mark_tour_seen failed: ${error.message}`);
  });
}
