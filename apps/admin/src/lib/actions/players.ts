'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { auditablePlayer } from '../auditable-player';
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
  ExpectedError,
  type AdminPlayerUpdateInput,
  rosterRestoreColumns,
} from '@badminton/shared';
import { requireCapability } from './_shared';
import {
  assertNoConsoleAccessFields,
  assertPlayerCreateFieldAccess,
  assertPlayerFieldAccess,
} from '../player-field-access';
import { assertLevelClosure } from '../console-access';
import { accessLevelFor, effectiveCapabilities, permissionsOf } from '../permissions';
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

  // APPROVAL ONLY APPLIES TO A PENDING SIGNUP, and until now only the client
  // said so. isApprovalEdit() — `currentStatus === 'pending_approval'` and into a
  // real division — is the rule both callers already follow, and its test spells
  // out the harm: "approving them twice would file a second player_approved row
  // for an approval that never happened". That is a client-side rule guarding a
  // server action, which is to say a suggestion; this is the guarantee, in the
  // same spirit as reinstatePlayer's "not banned, so there is nothing to
  // reinstate".
  //
  // WHAT IT ACTUALLY CLOSES, because the reachable damage is worse than a
  // duplicate audit row. This function writes `status` and `active_flag: true`
  // with no reference to what the row held, so a hand-rolled POST — or a tab
  // opened before somebody was suspended — could aim it at ANY member and:
  //   * clear a status='suspended' that removePlayer wrote, an admin-only
  //     capability being undone through an exec one;
  //   * email a banned or suspended member "you're in", which is the club
  //     telling somebody the opposite of a moderation decision it just made;
  //   * file a player_approved row that reads as an approval, over a row that
  //     was approved months ago, destroying nothing but recording a fiction.
  //
  // STRICTLY STRONGER THAN AN is_banned CHECK, which is what a privilege audit
  // proposed here. A banned member is not pending_approval — banPlayer does not
  // touch status — so refusing anything that is not pending_approval refuses
  // them too, and refuses the suspended and the already-approved as well. It is
  // also the right shape: the ban is not what makes this write wrong. See the
  // note below on why `active_flag: true` beside a ban is not the finding it
  // looks like.
  //
  // The status is compared, not is_banned, so a member who signed up and was
  // banned before anyone got to them can still be approved — and stays blocked
  // by is_banned everywhere afterwards, which is the column's job.
  if (oldPlayer?.status !== 'pending_approval') {
    throw new ExpectedError(
      'Only a pending signup can be approved. This member has already been let in, ' +
      'or their standing is a decision for the roster controls rather than this one.',
    );
  }

  // The full restore column set, not a bare `active_flag: true`. Approval is
  // an admission rather than a restore, but the failure mode is identical: a
  // signup that sat in Needs Attention past the inactivity cutoff — a frosh
  // week form approved late in the term — would be admitted with a
  // months-stale last_active_at and deactivated by the nightly job before the
  // member ever saw the club.
  const { data: approved, error } = await adminClient
    .from('players')
    .update({
      status,
      ...rosterRestoreColumns(new Date().toISOString()),
    })
    .eq('id', playerId)
    // Re-checked in the WHERE clause, because the read above is a moment old and
    // two execs clearing the Needs Attention tab together would both pass it. The
    // loser then matches no row, so only one of them emails the member and only
    // one files the audit entry.
    .eq('status', 'pending_approval')
    // Matching zero rows is not an error in PostgREST. Without the count the
    // loser of that race sends a second "you're in" email and writes a second
    // player_approved row for a decision it did not make.
    .select('id');

  if (error) throw new Error(error.message);
  if (!approved?.length) {
    throw new ExpectedError(
      'That signup was decided while you were approving it — most likely another exec got there first. ' +
      'Reload the roster before trying again.',
    );
  }

  // active_flag: true BESIDE A POSSIBLE BAN IS DELIBERATE, and it was queried.
  // updatePlayer carries thirty-odd lines refusing to mark a banned member
  // INACTIVE — "they may get removed from suspended", the club owner — which is
  // the club insisting a moderated member stays ON the roster so lifting the ban
  // later puts them back where they were. banPlayer never clears the flag, so
  // banned-and-active is the ordinary state, and writing `true` here agrees with
  // that rule rather than routing around it. Nothing gates on active_flag alone:
  // requirePlayer, getAccountStanding, isSelfReactivatable, the calendar feed and
  // every tournament entry path read is_banned as its own independent refusal.

  // Approval is the moment somebody becomes a member, so it is where the club's
  // membership code is stamped — not at signup, which is only a request. The
  // RPC derives the code from the row's own id and retries past a collision
  // behind the unique index, and it returns the existing code untouched if this
  // row already has one, so calling it twice on one row is a no-op.
  //
  // THE PRECONDITION ABOVE COSTS ONE RECOVERY PATH, and it is worth naming. If
  // this RPC fails the status write is already committed, and re-running the
  // whole approval used to be how an exec filled the missing code in; it is now
  // refused, because the member is no longer pending. That is the right trade:
  // the code is cosmetic by the reasoning on the next lines, 00092 ships a
  // backfill for exactly this state, and the alternative was leaving approval
  // aimable at every row in the table so that one Sentry-reported failure stayed
  // retryable.
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
    old_value: auditablePlayer(oldPlayer),
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
  // ONE PATH TO CONSOLE ACCESS, AND IT IS NOT THIS ONE. Refused for EVERYBODY,
  // admins included, which is what makes it different from the guard above:
  // that one asks who you are, this one says the act does not live here. See
  // assertNoConsoleAccessFields for why "no admin control sends it any more" is
  // not the same thing as it being unreachable.
  //
  // AFTER the level guard rather than before, so an exec who tries it still
  // gets "Admin access required" — the sentence that tells them the real
  // shape of the refusal — rather than being pointed at a screen they cannot
  // open either.
  assertNoConsoleAccessFields([data as Record<string, unknown>, parsed]);
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
  //
  // last_active_at IS THE ONE THIS USED TO MISS, and missing it made the whole
  // block self-defeating. mark-inactive-players selects on `active_flag = true
  // AND last_active_at < cutoff`, so a console restore that left the column
  // 120+ days stale put the member straight back into that job's result set:
  // deactivated again the same night, and — because the notice stamp had just
  // been cleared — emailed "your membership is now inactive" a second time.
  // One restore, one silent reversal, one wrong email.
  if (playerUpdate.active_flag === true) {
    Object.assign(playerUpdate, rosterRestoreColumns(new Date().toISOString()));
  }
  // role / is_exec / is_trainer are DELIBERATELY ABSENT from this assembly, and
  // the guard above means they can never arrive here anyway. Console access is
  // set on /permissions, through setConsoleAccess → writeConsoleLevel, which is
  // the only writer of the three columns that edits an existing member.
  if (data.membership_type) playerUpdate.membership_type = data.membership_type;
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
    old_value: { player: auditablePlayer(oldPlayer), rating: oldRating },
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
//
// NO is_banned CHECK ON THE `active_flag: true` BELOW, and that is a decision. A
// privilege audit read this write and approvePlayer's as "a holder of one
// capability returning a banned member to the active roster without holding
// players.reinstate.write". Two things make that the wrong reading here:
//
//   * the flag is not the ban. is_banned is an independent column with its own
//     refusal in requirePlayer, getAccountStanding, isSelfReactivatable, the
//     calendar feed and every tournament entry path, and banPlayer never touches
//     active_flag — so banned-and-active is the ordinary state of a banned
//     member, not a laundered one. updatePlayer's long note is the club insisting
//     on precisely that: a banned member may not be marked INACTIVE.
//   * there is no second capability to bypass. players.deletion.cancel.write is
//     on access-level.ts's deliberately-unofferable list, so only an admin — who
//     holds players.reinstate.write by level — can reach this at all.
//
// What this write restores is the pair deleteMyAccount cleared, nothing more.
export async function cancelAccountDeletion(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => cancelAccountDeletionImpl(playerId));
}

async function cancelAccountDeletionImpl(playerId: string) {
  const admin = await requireCapability('players.deletion.cancel.write');
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  if (!oldPlayer?.deletion_requested_at) throw new Error('No deletion is scheduled for this player');

  // A cancelled deletion puts them back on the roster, so it is a restore and
  // takes the full column set — not just the two fields the name suggests.
  // Somebody who requested deletion after going quiet has a stale
  // last_active_at by definition, which made this the restore path MOST likely
  // to be undone overnight.
  const restore = rosterRestoreColumns(new Date().toISOString());
  const { error } = await adminClient
    .from('players')
    .update({ deletion_requested_at: null, ...restore })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'account_deletion_cancelled',
    target_type: 'player',
    target_id: playerId,
    old_value: {
      deletion_requested_at: oldPlayer.deletion_requested_at,
      active_flag: oldPlayer.active_flag,
      last_active_at: oldPlayer.last_active_at,
      inactive_since: oldPlayer.inactive_since,
    },
    new_value: { deletion_requested_at: null, ...restore },
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
    old_value: auditablePlayer(oldPlayer),
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
 *
 * ...AND SO IS GRANT CLOSURE, WHICH THIS USED TO SKIP. Asking for the same
 * capability is not the same thing as applying the same rule. A restore hands
 * over a LEVEL — is_exec confers the whole exec baseline, is_trainer the trainer
 * one — and, because a restore does not clear a composition, it hands over any
 * stored grants sitting dormant on the row as well. Without closure a
 * five-capability officer could resolve a review and produce a colleague holding
 * things the officer has never held, from the /players screen, with none of the
 * checks the /permissions control applies to the identical act.
 *
 * assertLevelClosure is therefore the SAME function setConsoleAccess calls, on
 * sets computed the same way — not a second transcription of the rule. The one
 * difference is `after`: setConsoleAccess sometimes clears the composition and
 * resolves the new level against UNRESTRICTED, and a restore never clears, so
 * the stored triple is always what the result is measured through. That is the
 * conservative reading and it is the true one.
 *
 * AND NOBODY RESOLVES THEIR OWN REVIEW, for the reason setConsoleAccess refuses a
 * self-edit: it is the one move that would let this capability promote its own
 * holder. Usually unreachable — a member whose privileges were withheld has no
 * console to resolve anything from — but a MIXED review keeps some privileges and
 * withholds others, so somebody can hold the capability and still have a pending
 * restore of their own.
 */
export async function resolvePrivilegeClaimReview(
  playerId: string,
  decision: 'restore' | 'dismiss',
): Promise<ActionResult<void>> {
  return runAction(() => resolvePrivilegeClaimReviewImpl(playerId, decision));
}

async function resolvePrivilegeClaimReviewImpl(playerId: string, decision: 'restore' | 'dismiss') {
  const actor = await requireCapability('players.consoleaccess.write');
  // Refused before the target is even loaded, exactly as setConsoleAccess does
  // it, so self-promotion is never a question of what the row happens to say.
  if (actor.id === playerId) {
    throw new ExpectedError(
      'You cannot resolve your own permission review. Ask another admin to do it.',
    );
  }
  const adminClient = createAdminClient();

  // The three permission columns TOGETHER with the level markers: naming
  // permission_role without both delta columns makes permissionsOf() throw
  // rather than read a missing revoke as an empty one.
  const { data: player, error: readError } = await adminClient
    .from('players')
    .select(
      'id, full_name, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes, privilege_claim_review',
    )
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

  // GRANT CLOSURE, ON THE LEVEL THIS WOULD PRODUCE. `after` is resolved from the
  // MERGED row — the restore's columns over the row's current ones — because a
  // restore adds privileges rather than replacing the set: somebody whose is_exec
  // was withheld but whose is_trainer was kept ends up holding both, and the
  // check has to measure what they will actually hold.
  //
  // Through the stored composition in both directions, never UNRESTRICTED: a
  // restore does not clear one, so a dormant grant on the row wakes up with the
  // level and is part of what is being handed over.
  //
  // A `dismiss` IS STILL CHECKED, and it is worth being exact about what that
  // means because the obvious reading is wrong. `after` equals `before` for a
  // dismiss, so check 2 can never fire — but check 1 measures what the target
  // ALREADY holds, so a dismiss on somebody richer than the actor is refused.
  //
  // That is the same rule setConsoleAccess applies and it is the right one:
  // dismissing permanently discards a privilege somebody was elected to have,
  // which is the denial-of-access half of this act, and "who may edit whom" does
  // not stop applying because the write happens to be small. It only bites on a
  // MIXED review — one that kept a level and withheld something else — since a
  // fully-stripped member resolves to no level and an empty `before`, which is
  // the ordinary case and passes.
  const actorLevel = accessLevelFor(actor);
  const actorSet = effectiveCapabilities(actorLevel, permissionsOf(actorLevel, actor));
  const beforeLevel = accessLevelFor(player);
  const merged = {
    role: (restore.role as string | undefined) ?? player.role,
    is_exec: (restore.is_exec as boolean | undefined) ?? player.is_exec,
    is_trainer: (restore.is_trainer as boolean | undefined) ?? player.is_trainer,
  };
  const afterLevel = accessLevelFor(merged);
  assertLevelClosure(
    actorSet,
    effectiveCapabilities(beforeLevel, permissionsOf(beforeLevel, player)),
    effectiveCapabilities(afterLevel, permissionsOf(afterLevel, player)),
  );

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
