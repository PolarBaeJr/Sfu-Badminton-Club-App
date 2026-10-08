'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { ExpectedError } from '@badminton/shared';
// The exec's verdict on a walkover is private free text and no longer lives on
// the walkover row — 00118. See lib/private-notes.ts.
import { WALKOVER_NOTES, writePrivateNote } from '../private-notes';

/**
 * `noteRecorded` is how the caller learns the verdict reached
 * `walkover_admin_notes`. It is FALSE and not an error when 00118 has not been
 * applied to this database yet — see writePrivateNote.
 */
export async function confirmWalkover(
  walkoverId: string,
  notes: string,
): Promise<ActionResult<{ noteRecorded: boolean }>> {
  return runAction(() => confirmWalkoverImpl(walkoverId, notes));
}

async function confirmWalkoverImpl(walkoverId: string, notes: string) {
  const admin = await requireCapability('walkovers.confirm.write');
  const adminClient = createAdminClient();

  // p_admin_notes IS DELIBERATELY NOT PASSED. It is `DEFAULT NULL`, so omitting
  // it leaves `walkovers.admin_notes` unwritten — which is the point: the
  // walkovers_select policy admits `forfeit_player_id`, so the player who
  // forfeited could read the exec's verdict on their own forfeit straight off
  // that column. 00118 moves the text to walkover_admin_notes and explains why
  // the ROW policy is correctly left alone.
  //
  // THE FUNCTION ITSELF IS NOT REDEFINED, and 00118 argues that at length:
  // rewriting it to insert the note would be atomic, but plpgsql cannot be
  // patched in part, so it would mean reproducing ~150 lines of a SECURITY
  // DEFINER body that applies Elo penalties and auto-suspension counters. The
  // parameter stays as dead weight until the migration that drops the column
  // drops it too.
  const { error } = await adminClient.rpc('apply_walkover_result', {
    p_walkover_id: walkoverId,
    p_admin_id: admin.id,
  });

  if (error) {
    Sentry.captureException(new Error(`Walkover confirmation failed: ${error.message}`), {
      extra: { walkoverId },
    });
    throw new Error(error.message);
  }

  // AFTER THE RPC, BEFORE THE AUDIT, AND IT DOES NOT THROW. By this point the
  // walkover is confirmed, a match row exists, Elo has been applied and the
  // forfeiting player's reliability counters have moved — all irreversibly from
  // here. Throwing on a note failure would skip logAdminAudit and leave every
  // one of those effects unattributed.
  const note = await writePrivateNote(adminClient, WALKOVER_NOTES, walkoverId, notes, admin.id);
  if (note.error) {
    Sentry.captureException(new Error(`Walkover note not recorded: ${note.error}`), {
      extra: { walkoverId, action: 'confirm_walkover' },
    });
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'walkover_confirmed',
    target_type: 'walkover',
    target_id: walkoverId,
    // WHAT ACTUALLY HAPPENED — the audit row must not imply a note it does not
    // have. The text itself is in `reason` either way, so a failed note is a
    // degraded outcome rather than a lost one.
    new_value: { note_recorded: note.recorded },
    reason: notes,
  }, { walkoverId });

  revalidatePath('/walkovers');
  revalidatePath('/matches');
  return { noteRecorded: note.recorded };
}

/** See confirmWalkover for what `noteRecorded` means and why it is not an error. */
export async function rejectWalkover(
  walkoverId: string,
  notes: string,
): Promise<ActionResult<{ noteRecorded: boolean }>> {
  return runAction(() => rejectWalkoverImpl(walkoverId, notes));
}

async function rejectWalkoverImpl(walkoverId: string, notes: string) {
  const admin = await requireCapability('walkovers.reject.write');
  const adminClient = createAdminClient();

  // ONE STATEMENT, and it is the reject half of audit F-009. This used to read
  // the walkover (discarding the read error), update it to 'rejected'
  // unconditionally, and then reopen the challenge. Nothing tested that the
  // walkover was still pending, so two execs clicking Reject both succeeded,
  // and an exec rejecting one a colleague had just CONFIRMED reopened a
  // challenge whose match had already been played and rated. A failed read
  // reopened nothing and said nothing.
  //
  // 00184 takes the walkover FOR UPDATE, refuses anything that is not still
  // pending, and reopens the challenge only from 'walkover_pending'.
  //
  // `admin_notes` is deliberately NOT set — 00118. This is the sharpest case of
  // the four that migration moves: a REJECTION reason is the exec's assessment
  // of a claim the forfeiting player made, and walkovers_select names that
  // player.
  const { data: rejected, error } = await adminClient.rpc('reject_walkover_atomic', {
    p_walkover_id: walkoverId,
    p_admin_id: admin.id,
  });

  if (error) throw new Error(error.message);
  if (!rejected) throw new Error('Could not reject this walkover — please try again.');
  if (!rejected.ok) {
    throw new ExpectedError(
      rejected.reason === 'already_settled'
        ? `This walkover has already been ${rejected.status} by somebody else. Reload the queue.`
        : 'Walkover not found',
    );
  }

  // After the rejection lands, before the audit, and it does not throw — the
  // walkover is already rejected and the challenge already reopened.
  const note = await writePrivateNote(adminClient, WALKOVER_NOTES, walkoverId, notes, admin.id);
  if (note.error) {
    Sentry.captureException(new Error(`Walkover note not recorded: ${note.error}`), {
      extra: { walkoverId, action: 'reject_walkover' },
    });
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'walkover_rejected',
    target_type: 'walkover',
    target_id: walkoverId,
    new_value: { note_recorded: note.recorded },
    reason: notes,
  }, { walkoverId });

  revalidatePath('/walkovers');
  return { noteRecorded: note.recorded };
}
