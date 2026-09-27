'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError, mediaConsentSchema, parseOrThrow } from '@badminton/shared';
import { createServerSupabaseClient, getCurrentPlayer } from '../supabase-server';
import { runAction, type ActionResult } from './_shared';

// A MEMBER'S PHOTO AND VIDEO CONSENT (00255).
//
// getCurrentPlayer(), never the standing check in _shared.ts: a pending,
// suspended or banned member must still be able to withdraw, and
// set_my_media_consent() deliberately has no standing check either.
//
// Members hold no SELECT grant on either column, so the read comes from the
// service-role row getCurrentPlayer() returns for the session's own user.

export type MediaConsent = { consent: boolean; changedAt: string | null };

export async function getMyMediaConsent(): Promise<ActionResult<MediaConsent>> {
  return runAction(async () => {
    const player = await getCurrentPlayer();
    if (!player) throw new ExpectedError('Not authenticated');
    return { consent: player.media_consent, changedAt: player.media_consent_changed_at ?? null };
  });
}

// Takes no player id: every argument is a POST field the client controls, so
// the RPC resolves the caller from auth.uid() on the member's own session.
export async function setMyMediaConsent(input: unknown): Promise<ActionResult<MediaConsent>> {
  return runAction(async () => {
    const parsed = parseOrThrow(mediaConsentSchema, input);
    const player = await getCurrentPlayer();
    if (!player) throw new ExpectedError('Not authenticated');
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('set_my_media_consent', { p_consent: parsed.media_consent });
    if (error) throw new Error(`set_my_media_consent failed: ${error.message}`);
    const row = data?.[0];
    if (!row) throw new Error('set_my_media_consent returned no row');
    revalidatePath('/settings');
    return { consent: row.media_consent, changedAt: row.media_consent_changed_at ?? null };
  });
}
