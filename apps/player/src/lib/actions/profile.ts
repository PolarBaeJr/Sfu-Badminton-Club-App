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
    // RLS policy `players_self_insert` (00018) enforces that
    // user_id = auth.uid(), status = 'pending_approval', and role = 'player',
    // so the regular client is sufficient — no service role bypass required.
    const insert: Record<string, unknown> = {
      user_id: user.id,
      email: user.email!,
      full_name: data.full_name,
      onboarding_completed: true,
      status: 'pending_approval',
      role: 'player',
    };
    if (data.display_name) insert.display_name = data.display_name;
    if (data.phone) insert.phone = data.phone;

    const { data: newPlayer, error } = await supabase
      .from('players')
      .insert(insert)
      .select('id')
      .single();

    if (error) throw new Error(error.message);

    if (newPlayer) {
      const { error: ratingsError } = await supabase.from('ratings').insert({
        player_id: newPlayer.id,
        singles_elo: 1200,
        doubles_elo: 1200,
        singles_provisional: true,
        doubles_provisional: true,
        singles_k_factor: 40,
        doubles_k_factor: 40,
      });
      if (ratingsError) throw new Error(ratingsError.message);
    }
  }

  revalidatePath('/');
}
