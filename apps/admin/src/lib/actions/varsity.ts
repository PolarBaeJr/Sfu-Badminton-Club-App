'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, varsityNoteSchema, type VarsityNoteInput } from '@badminton/shared';
// Varsity notes are coaching records on a player — squarely the roster
// management the club owner handed to execs, and the ONE thing a varsity
// trainer may write. author_id/actor_id record whoever wrote it.
//
// This used to be the one place a console-level gate and a portfolio gate had
// to be composed by hand: the actions sit below the exec rung, so the exec gate
// would have rejected the trainer they exist for, while an exec narrowed to
// finance had to be kept out. Two axes, one door, hand-assembled.
//
// One capability answers both. players.editor.varsitynotes.write is in
// TRAINER_BASELINE and admins hold it by level, and no composition is needed.
// The resolver never learns that trainers exist; the level enters once, at
// permits(), choosing which baseline an unrestricted person holds.
//
// IT IS NO LONGER IN THE EXEC BASELINE, and that is the one place the narrowing
// costs somebody something. It is a WRITE, so it left with the other sixty when
// EXEC_BASELINE became twelve reads: an officer nobody has assigned anything to
// can open the roster and read it and cannot write a note. It is in
// EXEC_ASSIGNABLE and in ROLE_DEFAULTS.internal, so an officer who is supposed
// to do this work is given the roster job and holds it again.
//
// THE CASE THAT ACTUALLY BITES IS A ROW CARRYING BOTH FLAGS. accessLevelFor()
// resolves is_exec before is_trainer and returns ONE level, so an exec who is
// also a trainer is an 'exec' and loses the note the trainer flag was for. Only
// a legacy or hand-rolled row can be both — fromRoleValue() writes them mutually
// exclusively — and the hole is pinned, with both repairs, in
// packages/shared/src/utils/__tests__/capabilities.test.ts.
import { requireCapability } from './_shared';

export async function createVarsityNote(input: VarsityNoteInput) {
  const data = parseOrThrow(varsityNoteSchema, input);
  const actor = await requireCapability('players.editor.varsitynotes.write');
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
  const actor = await requireCapability('players.editor.varsitynotes.write');
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
