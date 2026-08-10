'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, varsityNoteSchema, ExpectedError, type VarsityNoteInput } from '@badminton/shared';
// Varsity notes are coaching records on a player — squarely the roster
// management the club owner handed to execs. author_id/actor_id record
// whoever wrote it.
//
// getConsoleUser(), not getExecOrAdmin(): these two actions are the ENTIRE
// write surface of the varsity-trainer level. Every other action in the app
// stayed on getExecOrAdmin(), so widening happens here and only here.
import { getConsoleUser } from './_shared';
import { accessLevelFor, portfolioOf, portfolioPermits } from '../permissions';

// The one place the console-level gate and the portfolio gate have to be
// composed by hand, because these actions sit BELOW the exec rung and
// getAuthenticatedExecOrAdmin(portfolio) would reject the trainer they exist
// for.
//
// portfolioPermits() answers true for every level except 'exec', so a trainer
// and an admin pass exactly as before; an exec with no portfolio passes too.
// What it stops is an exec narrowed to finance, tournaments or external writing
// coaching records on a member: notes live under /players, which is 'internal'
// work, and without this the whole narrowing had one door left open — the page
// hides nothing here (the notes panel is the part a trainer keeps) and the
// action is reachable directly.
//
// No is_trainer exemption. Someone who is both resolves to 'exec' via
// accessLevelFor(), and the rule everywhere else in this app is that a
// restriction follows the level a person resolves TO, never a flag in
// isolation — see canAccess(). An admin who wants a portfolio'd exec to keep
// writing notes clears their portfolio.
async function getVarsityAuthor() {
  const actor = await getConsoleUser();
  const level = accessLevelFor(actor);
  if (!portfolioPermits(level, portfolioOf(actor), 'internal')) {
    throw new ExpectedError(
      'That is Internal (roster) work, and it is outside your exec portfolio',
    );
  }
  return actor;
}

export async function createVarsityNote(input: VarsityNoteInput) {
  const data = parseOrThrow(varsityNoteSchema, input);
  const actor = await getVarsityAuthor();
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
  const actor = await getVarsityAuthor();
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
