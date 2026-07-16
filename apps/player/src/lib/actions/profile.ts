'use server';

import { revalidatePath } from 'next/cache';
import { profileSchema, parseOrThrow } from '@badminton/shared';
import { createServerSupabaseClient, getCurrentPlayer } from '../supabase-server';
import { requirePlayer } from './_shared';

export async function updateProfile(data: {
  full_name: string;
  display_name?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  show_activity_status?: boolean;
}) {
  parseOrThrow(profileSchema, data);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const update: Record<string, unknown> = { full_name: data.full_name };
  if (data.display_name !== undefined) {
    // Empty string -> null so the column isn't stuck with ''.
    update.display_name = data.display_name === '' ? null : data.display_name;
  }
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.bio !== undefined) update.bio = data.bio;
  if (data.hide_from_leaderboard !== undefined) update.hide_from_leaderboard = data.hide_from_leaderboard;
  if (data.show_activity_status !== undefined) update.show_activity_status = data.show_activity_status;

  const { error } = await supabase
    .from('players')
    .update(update)
    .eq('id', player.id);

  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}

export async function completeOnboarding(data: { full_name: string; display_name?: string; phone?: string }) {
  parseOrThrow(profileSchema, data);
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const existingPlayer = await getCurrentPlayer();

  if (existingPlayer) {
    const update: Record<string, unknown> = {
      full_name: data.full_name,
      onboarding_completed: true,
    };
    if (data.display_name) update.display_name = data.display_name;
    if (data.phone) update.phone = data.phone;

    const { error } = await supabase
      .from('players')
      .update(update)
      .eq('id', existingPlayer.id);

    if (error) throw new Error(error.message);
  } else {
    // create_player_with_rating (migration 00021) inserts the player and
    // ratings rows in one transaction. Its internal guard mirrors the
    // players_self_insert RLS policy (00018): user_id = auth.uid(),
    // status = 'pending_approval', role = 'player'.
    const { error } = await supabase.rpc('create_player_with_rating', {
      p_user_id: user.id,
      p_email: user.email!,
      p_full_name: data.full_name,
      p_display_name: data.display_name || null,
      p_phone: data.phone || null,
    });

    if (error) throw new Error(error.message);
  }

  revalidatePath('/');
}
