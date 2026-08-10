'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import {
  accessLevelFor,
  effectiveCapabilities,
  isCapability,
  permissionsOf,
  resolvePermissions,
  EDITOR_OFFERABLE,
  PERMISSION_ROLES,
  ROLE_DEFAULTS,
  type Capability,
  type PermissionRole,
} from '../permissions';

/** The whole of a person's stored permissions, written in one act. */
export type PermissionsPayload = {
  /** NULL means "not composed" — the level baseline, i.e. today's access. */
  role: PermissionRole | null;
  grants: string[];
  revokes: string[];
};

/**
 * Compose one person's permissions — the write half of /permissions, and the
 * gate behind `permissions.write`.
 *
 * ONE ACTION FOR THE WHOLE TRIPLE, not three. The three columns are one
 * decision: a role change moves the base, and the deltas only mean anything
 * against it. Saving them separately would leave a window in which the deltas
 * belong to the old role — and the window is exactly when a revoke that was
 * holding something back stops applying.
 *
 * GRANT CLOSURE IS THE PRIMARY DEFENCE (see the block above the checks). It is
 * what makes this capability safe to hand to somebody who is not an admin:
 * delegation spreads access sideways, and never manufactures it.
 */
export async function setPlayerPermissions(
  playerId: string,
  next: PermissionsPayload,
): Promise<ActionResult<void>> {
  return runAction(() => setPlayerPermissionsImpl(playerId, next));
}

/** "Varsity notes (write)" — how a capability is named in a refusal. */
function nameOf(capability: Capability): string {
  const entry = CAPABILITY_GATES[capability];
  return `${entry.label} (${entry.mode})`;
}

function listOf(capabilities: readonly Capability[]): string {
  return capabilities.map(nameOf).join(', ');
}

/** Sorted, de-duplicated, and every element known to the vocabulary. */
function cleanDelta(values: string[], which: 'grant' | 'revoke'): Capability[] {
  const unknown = values.filter((v) => !isCapability(v));
  if (unknown.length > 0) {
    // Refused rather than dropped. The resolver ignores an element the
    // vocabulary no longer has — it has to, because a build can be older than a
    // stored row — but the WRITER is the one place that knows the string was
    // just typed, and storing a `${which}` nothing will ever read is a promise
    // the app does not keep. The database would refuse it anyway; this is the
    // refusal in words rather than as a constraint violation.
    throw new ExpectedError(
      `Not something this console can ${which}: ${unknown.join(', ')}`,
    );
  }
  return [...new Set(values as Capability[])].sort();
}

function missingFrom(held: ReadonlySet<Capability>, wanted: readonly Capability[]): Capability[] {
  return wanted.filter((capability) => !held.has(capability));
}

async function setPlayerPermissionsImpl(playerId: string, next: PermissionsPayload) {
  // THE ACTOR'S SET COMES FROM THEIR OWN ROW, resolved server-side through the
  // same path every gate uses — permissionsOf, resolvePermissions,
  // effectiveCapabilities — and never from anything the client sent. That is
  // the whole of grant closure's foundation: if the actor's set could be
  // influenced from outside, every check below would be checking a number the
  // attacker chose.
  //
  // requireCapability returns the row it just authenticated, so there is not
  // even a second lookup that could disagree with the one that let them in.
  const actor = await requireCapability('permissions.write');
  const actorLevel = accessLevelFor(actor);
  const actorSet = effectiveCapabilities(actorLevel, permissionsOf(actor));

  // SELF-EDIT IS BLOCKED OUTRIGHT, and it is worth saying that this is not
  // load-bearing: granting yourself something you already hold is a no-op, and
  // a self role-change is bounded by the after-test below, so it could only
  // ever shrink you. It is refused because a permissions screen where the row
  // you are editing might be your own is where misreadings live — "I ticked it
  // and nothing happened" is a support conversation nobody should have. An
  // admin who wants to drop one of their own capabilities asks another admin.
  if (actor.id === playerId) {
    throw new ExpectedError(
      'You cannot change your own permissions. Ask another admin to do it.',
    );
  }

  const adminClient = createAdminClient();
  // Every column permissionsOf() and accessLevelFor() read, and all three
  // permission columns together: naming permission_role without both delta
  // columns makes permissionsOf() throw, deliberately, because the alternative
  // is a narrowed SELECT silently discarding a revoke.
  const { data: target } = await adminClient
    .from('players')
    .select(
      'id, full_name, email, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes',
    )
    .eq('id', playerId)
    .maybeSingle();
  if (!target) throw new ExpectedError('That member no longer exists.');

  const targetLevel = accessLevelFor(target);

  // Its own check with its own words, ahead of the subset test that would also
  // catch it. An admin holds all 113 capabilities, so "their set is not a
  // subset of yours" is technically what fails — but that sentence tells a
  // treasurer nothing, and "only an admin can change an admin's permissions"
  // tells them exactly who to ask.
  if (targetLevel === 'admin' && actorLevel !== 'admin') {
    throw new ExpectedError("Only an admin can change an admin's permissions.");
  }

  if (next.role !== null && !PERMISSION_ROLES.includes(next.role)) {
    throw new ExpectedError('That is not a permission role.');
  }

  // ROLES ARE EXEC-ONLY. An admin is a superuser by LEVEL and their stored role
  // is never consulted; a trainer's whole level is two capabilities and there
  // is nothing in it to narrow. Storing a role on either would be a value
  // nothing reads — and on a trainer it would come into force silently the day
  // somebody made them an exec.
  if (next.role !== null && targetLevel !== 'exec') {
    throw new ExpectedError(
      'Only an executive can be given a permission role. Admins are unrestricted and trainers hold the varsity-notes baseline.',
    );
  }

  // NO DELTAS WITHOUT A ROLE, cleared here rather than refused. Going back to
  // unrestricted is the safe direction and should not be a two-step act — but
  // the arrays cannot be left behind, or a revoke would sit dormant and wake up
  // the day somebody picks a role again. The database CHECK says the same
  // thing; this is what stops an admin ever meeting it.
  const role = next.role;
  const grants = role === null ? [] : cleanDelta(next.grants, 'grant');
  const revokes = role === null ? [] : cleanDelta(next.revokes, 'revoke');

  const bothWays = grants.filter((capability) => revokes.includes(capability));
  if (bothWays.length > 0) {
    throw new ExpectedError(
      `Cannot grant and revoke the same thing: ${listOf(bothWays)}`,
    );
  }

  // A grant of something the role already gives is normalised away rather than
  // stored. It resolves identically, but a stored redundant grant survives the
  // role losing that capability — so the person would keep it while every other
  // holder of the role lost it, from a tick nobody made deliberately.
  const roleBase = role === null ? [] : ROLE_DEFAULTS[role];
  const storedGrants = grants.filter((capability) => !roleBase.includes(capability));

  // ------------------------------------------------------------------
  // GRANT CLOSURE
  // ------------------------------------------------------------------
  // Nobody hands out what they do not hold. Four checks, all of them before any
  // write, so a refusal leaves the row exactly as it was — a partially applied
  // permission change is a person with an access set nobody chose.

  // 1. Every GRANT is something the actor holds.
  const cannotGrant = missingFrom(actorSet, storedGrants);
  if (cannotGrant.length > 0) {
    throw new ExpectedError(
      `You cannot grant ${listOf(cannotGrant)} because you do not hold ${cannotGrant.length === 1 ? 'it' : 'them'}.`,
    );
  }

  // 2. Every REVOKE is something the actor holds, bound by the SAME rule.
  //
  // An unbounded revoke is a denial-of-access weapon: a narrowly-scoped holder
  // of permissions.write could strip a colleague who outranks them of the
  // capabilities they were elected to use. The consequence, which is real and
  // worth stating: only somebody who could have granted a capability can take
  // it back, so tidying up after a departed officer may need an admin.
  const cannotRevoke = missingFrom(actorSet, revokes);
  if (cannotRevoke.length > 0) {
    throw new ExpectedError(
      `You cannot revoke ${listOf(cannotRevoke)} because you do not hold ${cannotRevoke.length === 1 ? 'it' : 'them'}.`,
    );
  }

  // 3. WHO MAY EDIT WHOM, before the change. Stops a narrowly-scoped holder
  //    reaching into the permissions of somebody who holds more than they do —
  //    which they could otherwise do purely by narrowing them, without granting
  //    anything at all.
  const before = effectiveCapabilities(targetLevel, permissionsOf(target));
  const outOfReach = missingFrom(actorSet, [...before]);
  if (outOfReach.length > 0) {
    throw new ExpectedError(
      `You cannot change this person's permissions: they hold ${listOf(outOfReach)}, which you do not.`,
    );
  }

  // 4. And on the RESULT. Catches the case the delta checks cannot see: a role
  //    change moves the base wholesale, and its defaults are not grants, so
  //    nothing above would have looked at them.
  const after = effectiveCapabilities(
    targetLevel,
    resolvePermissions(role, storedGrants, revokes),
  );
  const wouldExceed = missingFrom(actorSet, [...after]);
  if (wouldExceed.length > 0) {
    throw new ExpectedError(
      `That would give them ${listOf(wouldExceed)}, which you do not hold.`,
    );
  }

  // 5. AND THE CEILING THIS CHANGE SHIPS WITH. Grant closure bounds what one
  //    person may hand another; it cannot bound an ADMIN, who holds everything
  //    by level. So the set an admin may compose is capped at the exec baseline
  //    — the capabilities execs already had — which is what keeps this change
  //    provably inside the envelope that shipped before it. Handing out the
  //    admin-only half is its own small, reviewable change; it is not this one.
  const offerable = new Set<Capability>(EDITOR_OFFERABLE);
  const notYetOfferable = storedGrants.filter((capability) => !offerable.has(capability));
  if (notYetOfferable.length > 0) {
    throw new ExpectedError(
      `${listOf(notYetOfferable)} cannot be handed out yet — ${notYetOfferable.length === 1 ? 'it is' : 'they are'} admin-only.`,
    );
  }

  // Snapshotted BEFORE the write, not read back from `target` afterwards. The
  // audit row is the only trace this change leaves, and "what it was" has to be
  // captured while it still is.
  const wasStored = {
    permission_role: target.permission_role ?? null,
    permission_grants: target.permission_grants ?? [],
    permission_revokes: target.permission_revokes ?? [],
  };

  const { error } = await adminClient
    .from('players')
    .update({
      permission_role: role,
      permission_grants: storedGrants,
      permission_revokes: revokes,
    })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  // BOTH the stored triple AND the resolved set, on both sides.
  //
  // The triple alone does not answer "what did this change actually do": a role
  // is a name whose contents live in code and can move in a later deploy, so
  // reading `role: finance` back in six months tells you what it means TODAY,
  // not what it meant when the change was made. The resolved sets are the
  // answer, and they are the only thing in this row that cannot go stale.
  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id,
      action_type: 'player_permissions_changed',
      target_type: 'player',
      target_id: playerId,
      old_value: { ...wasStored, effective: [...before].sort() },
      new_value: {
        permission_role: role,
        permission_grants: storedGrants,
        permission_revokes: revokes,
        effective: [...after].sort(),
      },
    },
    { playerId },
  );

  revalidatePath('/permissions');
  revalidatePath('/players');
  // The sidebar and the dashboard are both filtered by what the viewer holds,
  // so the person whose access just changed must not keep a cached copy of the
  // old answer.
  revalidatePath('/dashboard');
}
