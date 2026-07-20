'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, varsityNoteSchema, type VarsityNoteInput } from '@badminton/shared';
import { getAdminPlayer } from './_shared';

export async function createVarsityNote(input: VarsityNoteInput) {
  const data = parseOrThrow(varsityNoteSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: note, error } = await adminClient
    .from('varsity_notes')
    .insert({
      player_id: data.player_id,
      note: data.note,
      author_id: admin.id,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'varsity_note_created',
    target_type: 'varsity_note',
    target_id: note.id,
    new_value: { player_id: data.player_id, note: data.note },
  }, { playerId: data.player_id });

  revalidatePath(`/players/${data.player_id}`);
}

export async function deleteVarsityNote(noteId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldNote } = await adminClient
    .from('varsity_notes')
    .select('id, player_id, note, author_id')
    .eq('id', noteId)
    .single();
  if (!oldNote) throw new Error('Note not found');

  const { error } = await adminClient.from('varsity_notes').delete().eq('id', noteId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'varsity_note_deleted',
    target_type: 'varsity_note',
    target_id: noteId,
    old_value: oldNote,
  }, { playerId: oldNote.player_id });

  revalidatePath(`/players/${oldNote.player_id}`);
}
