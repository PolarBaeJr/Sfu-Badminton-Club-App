// The audit trail for things a MEMBER does to their own privileged state.
//
// WHY THE PLAYER APP WRITES audit_logs AT ALL. Every admin-side write of these
// columns is audited — cancelAccountDeletion files 'account_deletion_cancelled',
// updatePlayer carries the whole previous row whenever a rating moves, and the
// nightly mark-inactive-players job files 'auto_marked_inactive'. The member's
// own equivalents wrote the same columns and left nothing, so the console's
// answer to "why is this account deactivated / why did this rating change"
// depended entirely on WHO had done it. That asymmetry is the bug: the audit log
// is meant to be the record of a column's history, not the record of the admin
// app's activity.
//
// NOT "AUDIT EVERYTHING", and the difference is real. A member changing their
// own display name is not an exec changing somebody else's, and profile edits
// stay unaudited — they are self-describing, reversible by the same person, and
// a row per keystroke would bury the entries that matter. What earns a row here
// is the intersection of two things: the member is writing state they cannot
// reach with their own JWT (these all go through the service-role client,
// because the columns are outside players_self, which 00134 made a read), and an
// admin doing the same write is audited. That test is what the three callers
// have in common and what onboarding's create_player_with_rating does not — see
// the note at applySkillTier.
//
// NO requireReason, AND THAT IS NOT A SKIPPED RULE. The admin console's rule is
// audit-reason.ts: every audited action carries a reason somebody typed, enforced
// server-side because a dialog is a courtesy. There is no dialog here and no
// prompt to add one to — a member deleting their account is answering a
// confirmation, not filing a justification — so the reason is a fixed sentence
// naming the act, exactly as reactivateLapsedMember has always done for
// 'self_reactivated'. Inventing a second convention (a nullable reason, or a
// free-text box on the Settings page) would make the column mean two things.
//
// FAILURES ARE REPORTED, NEVER THROWN. Every caller has already committed the
// write this row describes; the member is deleted, restored or seeded whatever
// happens next, and failing their action because an audit insert would not go in
// would be the worse outcome. Sentry keeps the record — deliberately unlike
// logAudit() in the admin app, which for a long time discarded its own insert
// error and so could lose a row with nothing anywhere to say so.

import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from './supabase-server';

export interface MemberAuditEntry {
  /** The member, who is both the actor and the target. */
  playerId: string;
  /** Same vocabulary as the admin app's: snake_case, past tense. */
  actionType: string;
  /** What the row held before, where there was a previous value to lose. */
  oldValue?: unknown;
  newValue?: unknown;
  /** A fixed sentence naming the act. See the note above on requireReason. */
  reason: string;
}

export async function logMemberAudit(entry: MemberAuditEntry): Promise<void> {
  const { error } = await createServiceRoleClient().from('audit_logs').insert({
    // actor_id is a plain FK to players with no admin-only constraint, and the
    // member really did do this — unlike the nightly job, which files its rows
    // with a null actor.
    actor_id: entry.playerId,
    action_type: entry.actionType,
    target_type: 'player',
    target_id: entry.playerId,
    old_value: entry.oldValue ?? null,
    new_value: entry.newValue ?? null,
    reason: entry.reason,
  });

  if (error) {
    Sentry.captureException(new Error(`Member audit log write failed: ${error.message}`), {
      extra: { action: entry.actionType, playerId: entry.playerId },
    });
  }
}
