'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  profileSchema,
  legalAcceptanceSchema,
  accountDeletionSchema,
  parseOrThrow,
  getMissingLegalDocuments,
  type LegalAcceptanceInput,
  type WaiverDocument,
} from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient, getCurrentPlayer } from '../supabase-server';
import { requirePlayer, trackServerEvent } from './_shared';

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

// The current legal document texts, for the onboarding waiver step and the
// waiver-gate overlay. Public to any authenticated user (RLS: read-only).
export async function getLegalDocuments(): Promise<
  { document: WaiverDocument; version: string; content: string }[]
> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('legal_documents')
    .select('document, version, content');
  if (error) throw new Error(error.message);
  // Callers sort with sortLegalDocuments for display.
  return data ?? [];
}

// Insert acceptance rows for the documents the player is still missing —
// never touching prior rows, which are append-only evidence (00014 dropped
// the unique key so the annual waiver renewal adds a NEW row). Only inserting
// the missing/expired set keeps re-acceptance idempotent in effect.
async function insertAcceptances(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  playerId: string,
  ageAttestation: boolean
) {
  const { data: docs, error: docsError } = await supabase
    .from('legal_documents')
    .select('document, version, reacceptance_required_since');
  if (docsError) throw new Error(docsError.message);
  if (!docs || docs.length === 0) return;

  const { data: existing, error: existingError } = await supabase
    .from('waiver_acceptances')
    .select('document, version, accepted_at')
    .eq('player_id', playerId);
  if (existingError) throw new Error(existingError.message);

  // Same inputs as the layout's waiver gate — including the per-player
  // waiver_reset_at — or the two disagree and the accept loop deadlocks
  // (gate shows but this inserts nothing).
  const { data: playerRow } = await supabase
    .from('players')
    .select('waiver_reset_at')
    .eq('id', playerId)
    .maybeSingle();

  const missing = getMissingLegalDocuments(docs, existing ?? [], new Date(), playerRow?.waiver_reset_at ?? null);
  if (missing.length === 0) return;

  const versionByDoc = new Map(docs.map((doc) => [doc.document, doc.version]));
  const userAgent = (await headers()).get('user-agent');
  const { error } = await supabase.from('waiver_acceptances').insert(
    missing.map((document) => ({
      player_id: playerId,
      document,
      version: versionByDoc.get(document)!,
      age_attestation: ageAttestation,
      user_agent: userAgent,
    }))
  );
  if (error) throw new Error(error.message);
}

// Not requirePlayer(): pending_approval members must be able to accept, and
// existing members hit this from the blocking waiver gate after a version bump.
export async function acceptLegalDocuments(data: LegalAcceptanceInput) {
  parseOrThrow(legalAcceptanceSchema, data);
  const player = await getCurrentPlayer();
  if (!player) throw new Error('Not authenticated');
  const supabase = await createServerSupabaseClient();

  await insertAcceptances(supabase, player.id, data.age_attestation);
  revalidatePath('/');
}

// Not requirePlayer(): pending_approval members must be able to delete their
// account too. Identity is derived only from the session — never from params.
// Nothing is destroyed here: the row is deactivated and stamped, the
// purge-deleted-accounts edge function anonymizes it after 30 days, and
// signing back in before then lets the player restore it (restoreMyAccount).
export async function deleteMyAccount(confirmation: string) {
  parseOrThrow(accountDeletionSchema, { confirmation });
  const player = await getCurrentPlayer();
  if (!player) throw new Error('Not authenticated');

  // Service role: deletion_requested_at / active_flag aren't part of the
  // players self-update RLS surface.
  const service = createServiceRoleClient();
  const { error } = await service
    .from('players')
    .update({ deletion_requested_at: new Date().toISOString(), active_flag: false })
    .eq('id', player.id);
  if (error) throw new Error(error.message);

  trackServerEvent(player.id, 'account_deletion_requested', {});
}

// Self-service revert path during the 30-day retention window.
export async function restoreMyAccount() {
  const player = await getCurrentPlayer();
  if (!player) throw new Error('Not authenticated');
  if (!player.deletion_requested_at) throw new Error('No deletion is scheduled for this account');

  const service = createServiceRoleClient();
  const { error } = await service
    .from('players')
    .update({ deletion_requested_at: null, active_flag: true })
    .eq('id', player.id);
  if (error) throw new Error(error.message);

  trackServerEvent(player.id, 'account_deletion_cancelled', {});
  revalidatePath('/');
}

export async function completeOnboarding(data: {
  full_name: string;
  display_name?: string;
  phone?: string;
  waiver_accepted: boolean;
  code_of_conduct_accepted: boolean;
  terms_accepted: boolean;
  age_attestation: boolean;
}) {
  parseOrThrow(profileSchema, data);
  parseOrThrow(legalAcceptanceSchema, data);
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const existingPlayer = await getCurrentPlayer();
  let playerId = existingPlayer?.id ?? null;

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
    // create_player_with_rating (migration 00003_functions.sql) inserts the
    // player and ratings rows in one transaction. Its internal guard mirrors
    // the players_self_insert RLS policy (00005_rls.sql): user_id = auth.uid(),
    // status = 'pending_approval', role = 'player'.
    const { error } = await supabase.rpc('create_player_with_rating', {
      p_user_id: user.id,
      p_email: user.email!,
      p_full_name: data.full_name,
      p_display_name: data.display_name || null,
      p_phone: data.phone || null,
    });

    if (error) throw new Error(error.message);

    // Re-fetch for the freshly created row's id.
    playerId = (await getCurrentPlayer())?.id ?? null;
  }

  if (playerId) {
    await insertAcceptances(supabase, playerId, data.age_attestation);
  }

  revalidatePath('/');
}
