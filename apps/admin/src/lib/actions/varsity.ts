'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, varsityNoteSchema, type VarsityNoteInput } from '@badminton/shared';
// Varsity notes are coaching records on a player — squarely the roster
// management the club owner handed to execs. author_id/actor_id record
// whoever wrote it.
import { getExecOrAdmin } from './_shared';

export async function createVarsityNote(input: VarsityNoteInput) {
  const data = parseOrThrow(varsityNoteSchema, input);
  const actor = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: note, error } = await adminClient
    .from('varsity_notes')
    .insert({
      player_id: data.player_id,
      note: data.note,
      author_id: actor.id,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'varsity_note_created',
    target_type: 'varsity_note',
    target_id: note.id,
    new_value: { player_id: data.player_id, note: data.note },
  }, { playerId: data.player_id });

  revalidatePath(`/players/${data.player_id}`);
}

export async function deleteVarsityNote(noteId: string) {
  const actor = await getExecOrAdmin();
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
    actor_id: actor.id,
    action_type: 'varsity_note_deleted',
    target_type: 'varsity_note',
    target_id: noteId,
    old_value: oldNote,
  }, { playerId: oldNote.player_id });

  revalidatePath(`/players/${oldNote.player_id}`);
}
