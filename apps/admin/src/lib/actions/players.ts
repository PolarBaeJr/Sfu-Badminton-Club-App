'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  adminPlayerCreateSchema,
  adminPlayerUpdateSchema,
  joinName,
  sendPlayerApprovedEmail,
  parsePrivilegeClaimReview,
  restoreWithheldPrivileges,
  describePrivileges,
  type AdminPlayerUpdateInput,
} from '@badminton/shared';
import { requireCapability } from './_shared';
import { assertPlayerCreateFieldAccess, assertPlayerFieldAccess } from '../player-field-access';
import { runAction, type ActionResult } from '../action-result';

export async function approvePlayer(playerId: string, status: 'competitive' | 'recreational', reason: string): Promise<ActionResult<void>> {
  return runAction(() => approvePlayerImpl(playerId, status, reason));
}

async function approvePlayerImpl(playerId: string, status: 'competitive' | 'recreational', reason: string) {
  // Roster management is exec work. The audit row records whoever actually
  // clicked, exec or admin — actor_id is a plain FK to players with no
  // admin-only constraint (checked against the live schema).
  const actor = await requireCapability('players.approve.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({
      status,
      active_flag: true,
    })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  // Approval is the moment somebody becomes a member, so it is where the club's
  // membership code is stamped — not at signup, which is only a request. The
  // RPC derives the code from the row's own id and retries past a collision
  // behind the unique index, and it returns the existing code untouched if this
  // row already has one, which is what makes a re-approval harmless.
  const { data: memberCode, error: codeError } = await adminClient.rpc('assign_member_code', {
    p_player_id: playerId,
  });
  // The approval itself is already committed. A member with no code reads the
  // app exactly as they did before this feature existed, so failing the action
  // here would undo a real decision over a cosmetic one.
  if (codeError) {
    Sentry.captureException(codeError, { extra: { step: 'assign-member-code', playerId } });
  }

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_approved',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    // The key changes with the column. Audit rows written before 00092 became a
    // code still carry `member_number`, and that is correct — an audit entry is
    // a record of what was written on the day, not a view that gets migrated.
    new_value: { status, member_code: memberCode ?? null },
    reason,
  }, { playerId });

  // Tell them they are in. Until now approval was silent: a member who signed
  // up sat at "pending approval" with no way to know it had changed except by
  // opening the app again and guessing.
  //
  // Best-effort — the approval itself is already committed and audited, and a
  // mail failure must not roll that back or surface as a failed action.
  if (oldPlayer?.email) {
    await sendPlayerApprovedEmail(oldPlayer.email, oldPlayer.full_name ?? 'there').catch((err) => {
      Sentry.captureException(err, { extra: { step: 'player-approved-email', playerId } });
    });
  }

  revalidatePath('/players');
  revalidatePath('/dashboard');
}

export async function createPlayer(data: {
  first_name: string;
  last_name?: string;
  email: string;
  status: string;
  role?: string;
  is_exec?: boolean;
  is_trainer?: boolean;
}): Promise<ActionResult<string>> {
  return runAction(() => createPlayerImpl(data));
}

async function createPlayerImpl(data: {
  first_name: string;
  last_name?: string;
  email: string;
  status: string;
  role?: string;
  is_exec?: boolean;
  is_trainer?: boolean;
}) {
  // Admin accounts cannot be created here — only promoted from existing
  // members via updatePlayer, so every admin went through real signup
  // (and the passkey enrollment path). The schema also excludes 'admin';
  // this check just gives the friendly message before Zod's enum error.
  if (data.role === 'admin') throw new Error('Admins cannot be created directly — promote an existing member instead');
  const parsed = parseOrThrow(adminPlayerCreateSchema, data);
  const actor = await requireCapability('players.create.write');
  // Adding a member is exec work; adding one who is already an exec is not.
  // Without this an exec could mint a second privileged identity and sidestep
  // "you cannot promote yourself".
  assertPlayerCreateFieldAccess(actor, parsed);
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient.from('players').select('id').eq('email', data.email).maybeSingle();
  if (existing) throw new Error('A player with this email already exists');

  // create_player_with_rating (migration 00003_functions.sql) inserts the
  // player and ratings rows in one transaction.
  const { data: playerId, error } = await adminClient.rpc('create_player_with_rating', {
    p_user_id: null,
    p_email: data.email,
    p_first_name: data.first_name,
    p_last_name: data.last_name || null,
    // Admin-created players have always had display_name seeded with the
    // whole name; joinName reproduces exactly what full_name will generate.
    p_display_name: joinName(data.first_name, data.last_name),
    p_status: data.status || 'recreational',
    p_role: data.role || 'player',
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // create_player_with_rating() predates both markers, so they are stamped in a
  // follow-up update. Only issued when something is actually being granted.
  if (data.is_exec || data.is_trainer) {
    const flags: Record<string, boolean> = {};
    if (data.is_exec) flags.is_exec = true;
    if (data.is_trainer) flags.is_trainer = true;
    await adminClient.from('players').update(flags).eq('id', playerId);
  }

  // Adding somebody from the console IS the club letting them in — there is no
  // approval step ahead of them — so the code is stamped here for the same
  // reason approvePlayer stamps it there. The exception is a row deliberately
  // created as pending_approval: that one has an approval ahead of it, and
  // getting a code before the decision is made would be the console
  // pre-empting itself.
  if ((data.status || 'recreational') !== 'pending_approval') {
    const { error: codeError } = await adminClient.rpc('assign_member_code', {
      p_player_id: playerId,
    });
    // The member exists and is on the roster; a missing code is not worth
    // failing a creation that already succeeded.
    if (codeError) {
      Sentry.captureException(codeError, { extra: { step: 'assign-member-code', playerId } });
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_created',
    target_type: 'player',
    target_id: playerId,
    new_value: { first_name: data.first_name, last_name: data.last_name ?? null, email: data.email, status: data.status, is_exec: data.is_exec ?? false, is_trainer: data.is_trainer ?? false },
    reason: 'Manual admin creation',
  });

  revalidatePath('/players');
  return playerId;
}

export async function updatePlayer(playerId: string, data: AdminPlayerUpdateInput): Promise<ActionResult<void>> {
  return runAction(() => updatePlayerImpl(playerId, data));
}

async function updatePlayerImpl(playerId: string, data: AdminPlayerUpdateInput) {
  const parsed = parseOrThrow(adminPlayerUpdateSchema, data) as Record<string, unknown>;
  const actor = await requireCapability('players.update.write');
  // Both payloads, because the write below reads from raw `data` while
  // exec_title / exec_photo_url normalize '' → undefined during parsing.
  // Guarding only `parsed` would let a hand-rolled POST of { exec_title: '' }
  // through the guard and into the update.
  assertPlayerFieldAccess(actor, [data as Record<string, unknown>, parsed]);
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  const { data: oldRating } = await adminClient.from('ratings').select('*').eq('player_id', playerId).single();

  const playerUpdate: Record<string, unknown> = {};
  if (data.status) playerUpdate.status = data.status;
  // Inactive is active_flag, not a status — see adminPlayerUpdateSchema.
  if (data.active_flag !== undefined) playerUpdate.active_flag = data.active_flag;

  // A suspended or banned member cannot be marked inactive. The club owner:
  // "when a user is suspended please make it so they cannot be marked as
  // inactive, since they may get removed from suspended". Both flags are
  // treated alike because they read identically to the member — the app calls
  // is_banned "suspended pending reinstatement" — and the damage is the same
  // either way: a deactivated suspension is indistinguishable from an ordinary
  // lapse, so lifting the suspension later would leave them off the roster,
  // and the sign-in reactivation would hand a moderated account its way back.
  //
  // Enforced here rather than only by hiding the button on /players, because
  // the button is one caller of a server action and a hand-rolled POST is
  // another. The status compared is the one this write LEAVES BEHIND (an edit
  // that sets a division and clears the flag in the same call is fine);
  // is_banned is never written here, so the stored value is the live one.
  //
  // The rule is "cannot be MARKED inactive", so this gates the TRANSITION, not
  // the value. The Edit dialog re-sends the current state — an already-inactive
  // row saves as { status: undefined, active_flag: false } — so gating on the
  // value alone would make every removed member (removePlayer writes
  // status='suspended' alongside the flag) and every banned-and-inactive member
  // permanently uneditable, which is the opposite of what this protects.
  if (playerUpdate.active_flag === false && oldPlayer?.active_flag !== false) {
    const resultingStatus = (data.status ?? oldPlayer?.status) as string | undefined;
    if (resultingStatus === 'suspended' || resultingStatus === 'pending_approval') {
      throw new Error(
        `A ${resultingStatus === 'suspended' ? 'suspended' : 'pending'} member cannot be marked inactive — lift the suspension first, or leave them where they are.`,
      );
    }
    if (oldPlayer?.is_banned) {
      throw new Error(
        'A banned member cannot be marked inactive — unban them first, or leave them where they are.',
      );
    }
  }

  // Coming back onto the roster re-arms the inactivity notice (00059), so a
  // member who lapses again later is told again. Mirrors what the members' app
  // does in reactivateLapsedMember().
  // Restoring someone from the console also stops the retention clock (00062),
  // for the same reason the members' app clears it on sign-in: they are back on
  // the roster, so the year that would have anonymised them must not keep
  // running underneath.
  if (playerUpdate.active_flag === true) {
    playerUpdate.inactivity_notice_sent_at = null;
    playerUpdate.inactive_since = null;
  }
  if (data.role) playerUpdate.role = data.role;
  if (data.membership_type) playerUpdate.membership_type = data.membership_type;
  if (data.is_exec !== undefined) playerUpdate.is_exec = data.is_exec;
  if (data.is_trainer !== undefined) playerUpdate.is_trainer = data.is_trainer;
  if (data.exec_title !== undefined) playerUpdate.exec_title = data.exec_title;
  if (data.fee_exempt !== undefined) playerUpdate.fee_exempt = data.fee_exempt;
  if (data.exec_photo_url !== undefined) playerUpdate.exec_photo_url = data.exec_photo_url;
  // 00129 — the member's Gender, which they set once and cannot change again.
  // THIS IS THE ONLY WAY IT EVER CHANGES AFTER THAT, and it is deliberately an
  // ordinary line in this function rather than a server action of its own:
  //
  //   * the capability is players.update.write, which every exec baseline holds
  //     and which the whole rest of this dialog is already behind — no new
  //     capability is minted, so CAPABILITY_GATES keeps one enforcement point
  //     per capability and the drift test is untouched;
  //   * `reason` is required by adminPlayerUpdateSchema and the logAdminAudit
  //     call below carries the previous row whole, so every exec change to this
  //     field is audited with a reason and a before-value for free.
  //
  // `null` is a value an exec may send: clearing it back to "prefer not to say"
  // is a correction, and after 00129 this is the only route to NULL there is.
  // Hence `!== undefined` rather than a truthiness test.
  //
  // The write reaches the database through createAdminClient() — the
  // service-role key — which is what guard_competition_category_lock_trg
  // recognises as the console. It is NOT recognised by auth.uid() being NULL:
  // see 00129 on why that shape would have admitted anon as well.
  if (data.competition_category !== undefined) {
    playerUpdate.competition_category = data.competition_category;
  }
  if (Object.keys(playerUpdate).length > 0) {
    const { error } = await adminClient.from('players').update(playerUpdate).eq('id', playerId);
    if (error) throw new Error(error.message);
  }

  const ratingUpdate: Record<string, unknown> = {};
  if (data.singles_elo !== undefined) ratingUpdate.singles_elo = data.singles_elo;
  if (data.doubles_elo !== undefined) ratingUpdate.doubles_elo = data.doubles_elo;

  if (Object.keys(ratingUpdate).length > 0) {
    const { error } = await adminClient.from('ratings').update(ratingUpdate).eq('player_id', playerId);
    if (error) throw new Error(error.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: { player: oldPlayer, rating: oldRating },
    new_value: { ...playerUpdate, ...ratingUpdate },
    reason: data.reason,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

// Admin-only, alongside removePlayer/mergePlayers: account lifecycle and the
// legal re-signature gate were not part of "let execs manage players", so they
// keep capabilities no baseline below admin holds, and their buttons are
// hidden for execs.
//
// Backup path for the player's own restore flow: clears a pending
// self-service account deletion (players.deletion_requested_at) before the
// purge-deleted-accounts edge function anonymizes the row.
export async function cancelAccountDeletion(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => cancelAccountDeletionImpl(playerId));
}

async function cancelAccountDeletionImpl(playerId: string) {
  const admin = await requireCapability('players.deletion.cancel.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  if (!oldPlayer?.deletion_requested_at) throw new Error('No deletion is scheduled for this player');

  const { error } = await adminClient
    .from('players')
    .update({ deletion_requested_at: null, active_flag: true })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'account_deletion_cancelled',
    target_type: 'player',
    target_id: playerId,
    old_value: { deletion_requested_at: oldPlayer.deletion_requested_at },
    new_value: { deletion_requested_at: null, active_flag: true },
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

// Force just this player to re-sign the waiver on their next visit. Stamps
// players.waiver_reset_at = now(); the shared getMissingLegalDocuments helper
// then treats their latest waiver acceptance as stale until they re-sign.
export async function requireWaiverResignature(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => requireWaiverResignatureImpl(playerId));
}

async function requireWaiverResignatureImpl(playerId: string) {
  // Exec-level, matching requireReacceptance (the club-wide equivalent). Asking
  // someone to re-sign is operational — a returning member after months away —
  // and cannot alter what they are agreeing to. Editing the waiver TEXT is
  // still admin-only, which is where the legal exposure lives.
  const admin = await requireCapability('players.waiver.resign.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('waiver_reset_at').eq('id', playerId).single();

  const now = new Date().toISOString();
  const { error } = await adminClient
    .from('players')
    .update({ waiver_reset_at: now })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'waiver_resignature_required',
    target_type: 'player',
    target_id: playerId,
    old_value: { waiver_reset_at: oldPlayer?.waiver_reset_at ?? null },
    new_value: { waiver_reset_at: now },
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

// Stays admin-only while the rest of player management opened up to execs.
// The owner asked for management, not destruction: removal deactivates an
// account and merge_players() deletes a row outright — neither is undoable from
// the console.
//
// NOTE: nothing in the console calls this any more. The club owner specified
// the per-tab actions on /players as Edit / Ban / Inactive, and "Inactive" is
// updatePlayer({ active_flag: false }) — the same deactivation without the
// silent status: 'suspended' this also writes, and reversible from the Inactive
// tab. Kept because it is the audited path a future bulk/CLI removal would use;
// delete it only after checking nothing off-console depends on it.
export async function removePlayer(playerId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => removePlayerImpl(playerId, reason));
}

async function removePlayerImpl(playerId: string, reason: string) {
  const admin = await requireCapability('players.remove.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({ status: 'suspended', active_flag: false })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_removed',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    reason,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath('/dashboard');
}

// ---------------------------------------------------------------------------
// Merge duplicate accounts
// ---------------------------------------------------------------------------
// The recurring case: an admin pre-adds someone to the roster, then that person
// signs up themselves with a different email — two rows, one holding the
// history, one holding the login. Rows can't share a UUID, so merging means
// repointing every reference onto a survivor and deleting the other. All of
// that lives in the merge_players() SQL function (migration 00026), which
// refuses outright if the account being removed has real history.

export interface MergePreviewRow {
  table_name: string;
  row_count: number;
  effect: string;
}

/** What would block this merge — empty array means it's safe to run. */
export async function previewPlayerMerge(
  keepId: string,
  removeId: string,
): Promise<ActionResult<MergePreviewRow[]>> {
  return runAction(async () => {
    await requireCapability('players.merge.write');
    const adminClient = createAdminClient();
    const { data, error } = await adminClient.rpc('merge_players_preview', {
      p_keep: keepId,
      p_remove: removeId,
    });
    if (error) throw new Error(error.message);
    // Only surface the rows that actually block; "ok" rows are noise.
    return ((data ?? []) as MergePreviewRow[]).filter((r) => Number(r.row_count) > 0);
  });
}

export async function mergePlayers(
  keepId: string,
  removeId: string,
): Promise<ActionResult<{ login_moved: boolean }>> {
  return runAction(async () => {
    const admin = await requireCapability('players.merge.write');
    const adminClient = createAdminClient();

    const { data, error } = await adminClient.rpc('merge_players', {
      p_keep: keepId,
      p_remove: removeId,
      p_actor: admin.id,
    });
    // The function raises with a human-readable reason (history present, two
    // logins, same id) — surface it verbatim rather than a generic failure.
    if (error) throw new Error(error.message);

    revalidatePath('/players');
    return { login_moved: Boolean((data as { login_moved?: boolean } | null)?.login_moved) };
  });
}

/**
 * Resolve a permission review left by a roster claim (00132).
 *
 * `restore` writes back exactly the privileges the claim withheld and clears the
 * flag; `dismiss` clears the flag and leaves the row as it is. Both are ONE
 * click, which is the point of storing the privileges on the row rather than
 * making an admin reconstruct them from /audit.
 *
 * THE CAPABILITY IS players.consoleaccess.write, not players.update.write. That
 * is what the /permissions editor asks for when it sets somebody's console level
 * (permissions.ts:621), and restoring a withheld role or is_exec IS setting a
 * console level — asking for the weaker one would let somebody who may edit
 * member details grant admin.
 *
 * `role` additionally requires the actor to be an admin, mirroring
 * setConsoleAccess's own refusal: an exec cannot hand out the level above their
 * own, and a review is not a way around that.
 */
export async function resolvePrivilegeClaimReview(
  playerId: string,
  decision: 'restore' | 'dismiss',
): Promise<ActionResult<void>> {
  return runAction(() => resolvePrivilegeClaimReviewImpl(playerId, decision));
}

async function resolvePrivilegeClaimReviewImpl(playerId: string, decision: 'restore' | 'dismiss') {
  const actor = await requireCapability('players.consoleaccess.write');
  const adminClient = createAdminClient();

  const { data: player, error: readError } = await adminClient
    .from('players')
    .select('id, full_name, role, is_exec, is_trainer, privilege_claim_review')
    .eq('id', playerId)
    .single();
  if (readError) throw new Error(readError.message);

  const review = parsePrivilegeClaimReview(player.privilege_claim_review);
  // Already resolved — by somebody else, in another tab, a moment ago. Say so
  // rather than writing a restore built from an empty review.
  if (!review) throw new Error('There is nothing left to review on this member.');

  const restore = decision === 'restore' ? restoreWithheldPrivileges(review) : {};
  if (restore.role && restore.role !== 'player' && actor.role !== 'admin') {
    throw new Error('Only an admin can restore an admin role. Ask one to resolve this review.');
  }

  const { error } = await adminClient
    .from('players')
    .update({ ...restore, privilege_claim_review: null })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  // 'player_updated' DELIBERATELY, and for the reason writeConsoleLevel chose it
  // (permissions.ts:566): isAccessChange() matches that action_type plus a
  // console-level column, so this shows up on /accounts' access-change card. A
  // bespoke action_type would make the restore vanish from the one screen that
  // exists to answer "who was given what, and when".
  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: { role: player.role, is_exec: player.is_exec, is_trainer: player.is_trainer },
    new_value: { ...restore, privilege_claim_review: null },
    reason:
      decision === 'restore'
        ? `Restored privileges a roster claim withheld at sign-in: ${describePrivileges(review.withheld)}.`
        : 'Dismissed a roster claim permission review without restoring anything.',
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}
