'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { requireReason } from '../audit-reason';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { updatePlayer } from './players';
import { fromRoleValue, toRoleValue, type ExecRole } from '../console-access';
import { isAdminActor } from '../player-field-access';
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
  /**
   * Which custom baseline (00093) these grants were COPIED from, or null/absent
   * for a hand-picked set.
   *
   * WHEN IT IS SET, IT IS THE SOURCE OF TRUTH AND THE OTHER THREE ARE CHECKED
   * AGAINST IT. The action loads the baseline and uses its capabilities, so the
   * stored label can never describe a set the baseline does not say. A caller
   * that sends a role, grants or revokes disagreeing with it is refused loudly
   * rather than quietly overruled — a silent overrule is the editor showing one
   * diff and the database taking another.
   *
   * WHEN IT IS ABSENT, THE LABEL IS CLEARED, and that is the important default.
   * Every ordinary edit through the two-pane editor goes through here without
   * this field, so ticking one extra capability for a baseline holder drops the
   * label and keeps every capability. Without that, the row would say "Socials
   * VP" while holding Socials VP plus one — and the next edit to that baseline
   * would propagate over the extra tick and take it away, a narrowing produced
   * by somebody else's edit to something else.
   */
  baselineId?: string | null;
  /**
   * WHY, AND IT IS NOT OPTIONAL.
   *
   * It used to be, and the consequence was that `player_permissions_changed`
   * was the ONE audited action in the console with `reason: null` on every row
   * — sessions, announcements, legal documents, ratings and platform settings
   * all require one. An access change is the last thing that should be the
   * exception: "who gave them tournaments.write, and why" is exactly the
   * question the log exists to answer, and a null there answers half of it.
   *
   * ONE REASON COVERS A BATCH. The two-pane editor saves several people at
   * once and asks for a single reason, which is then written to every one of
   * their audit rows — the same shape baseline propagation already used, where
   * the reason belongs to the edit that caused the change rather than to each
   * person it reached.
   */
  reason: string;
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

/**
 * The typed reason, trimmed, or a refusal.
 *
 * THE SHARED FLOOR, never a second copy of it — requireReason and REASON_MIN
 * live in lib/audit-reason.ts and every audited action in the console measures
 * against them. All this adds is the error CLASS: that helper throws a plain
 * Error, and every refusal in this file is an ExpectedError so that somebody
 * being told to type a reason is the system working rather than a Sentry fault.
 */
function reasonFor(reason: string, what: string): string {
  try {
    return requireReason(reason, what);
  } catch (err) {
    throw new ExpectedError(err instanceof Error ? err.message : 'A reason is required.');
  }
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

  // Before anything is read and long before anything is written. The reason is
  // a property of the REQUEST, so refusing it early keeps a reasonless call
  // from ever touching the database — and the trimmed value is what reaches
  // the audit row, never the whitespace that got it past the length check.
  const why = reasonFor(next.reason, 'Changing somebody’s permissions');

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
  // catch it. An admin holds all 115 capabilities, so "their set is not a
  // subset of yours" is technically what fails — but that sentence tells a
  // treasurer nothing, and "only an admin can change an admin's permissions"
  // tells them exactly who to ask.
  if (targetLevel === 'admin' && actorLevel !== 'admin') {
    throw new ExpectedError("Only an admin can change an admin's permissions.");
  }

  if (next.role !== null && !PERMISSION_ROLES.includes(next.role)) {
    throw new ExpectedError('That is not a permission role.');
  }

  // A ROLE ON AN ADMIN IS A VALUE NOTHING READS, and that is the whole reason
  // it is refused. permits() short-circuits on level === 'admin' before any set
  // is consulted, so a stored role would not take one capability away from
  // them; it would only look as though it had, which is worse than refusing.
  // Narrowing an admin means making them an executive first.
  //
  // TRAINERS USED TO BE REFUSED HERE TOO, and that is what this change undoes.
  // The old reasoning was that a trainer's whole level is three capabilities
  // with nothing in it to narrow — true, and beside the point: the club has a
  // varsity trainer who also runs sessions, and the only way to say so was to
  // make them an exec, which hands over the entire exec baseline to somebody
  // who needed one area of it. Composition is the answer to exactly that, and
  // no machinery had to change to allow it: resolvePermissions is
  // LEVEL-AGNOSTIC, so a composed trainer has always resolved through the same
  // path as a composed exec, and the level decides only what an UNCOMPOSED
  // person holds. This guard was the one thing refusing to create one.
  //
  // The cost, and it is real: a role REPLACES the base, so a trainer given
  // `tournaments` loses TRAINER_BASELINE — varsity notes included — unless the
  // role carries it or it is granted back. That is the same semantics an exec
  // has had since this shipped, and the editor shows what will be lost before
  // the save rather than after.
  if (next.role !== null && targetLevel === 'admin') {
    throw new ExpectedError(
      'An admin holds every capability by level, so a permission role on one would never be consulted. Make them an executive first.',
    );
  }

  // A CUSTOM BASELINE (00093) IS A COPY, AND THIS IS WHERE IT IS COPIED.
  //
  // The capabilities are read from the baseline row, never from the payload, so
  // permission_baseline_id can never name a baseline that says something other
  // than what the person holds. The payload is checked against it rather than
  // ignored: a disagreement means the client drew a diff the server would not
  // have written, and silently writing the other one is how an admin comes to
  // believe they granted something they did not.
  //
  // THE FIVE CLOSURE CHECKS BELOW STILL RUN, unchanged and on these values. A
  // baseline is bounded at authoring time by the author's own set, but the
  // person ASSIGNING it may be someone else with less — so "this baseline was
  // legal to write" is not "this actor may hand it to this person", and nothing
  // here is allowed to skip the question.
  const baselineId = next.baselineId ?? null;
  let fromBaseline: Capability[] | null = null;
  if (baselineId !== null) {
    const { data: baselineRow } = await adminClient
      .from('permission_baselines')
      .select('id, capabilities')
      .eq('id', baselineId)
      .maybeSingle();
    if (!baselineRow) throw new ExpectedError('That baseline no longer exists.');
    fromBaseline = [
      ...new Set((baselineRow.capabilities as string[]).filter(isCapability)),
    ].sort();

    // 'custom' is the EMPTY base, which is the only base under which the stored
    // grants are the whole of what the person holds. Any other role has defaults
    // beneath them, and a label claiming the set came from a baseline would be
    // describing part of it.
    if (next.role !== 'custom') {
      throw new ExpectedError('A baseline is stored as a hand-picked set. Pick "Hand-picked".');
    }
    // Element by element rather than through a joined string: a delimiter is a
    // character that could appear in a capability, and this comparison is what
    // stops a stored label describing a set the baseline does not say.
    const asked = [...new Set(next.grants)].sort();
    const sameAsBaseline =
      asked.length === fromBaseline.length
      && asked.every((capability, index) => capability === fromBaseline![index]);
    if (!sameAsBaseline || next.revokes.length > 0) {
      throw new ExpectedError(
        'That does not match what the baseline says. Reload the page and try again.',
      );
    }
  }

  // NO DELTAS WITHOUT A ROLE, cleared here rather than refused. Going back to
  // unrestricted is the safe direction and should not be a two-step act — but
  // the arrays cannot be left behind, or a revoke would sit dormant and wake up
  // the day somebody picks a role again. The database CHECK says the same
  // thing; this is what stops an admin ever meeting it.
  const role = next.role;
  const grants = role === null ? [] : cleanDelta(fromBaseline ?? next.grants, 'grant');
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

  // THE LABEL IS WRITTEN ON EVERY SAVE, and to null unless this one came from a
  // baseline. That is what keeps it honest: an ordinary edit through the editor
  // carries no baselineId, so ticking one extra capability for a baseline holder
  // drops the label in the same write that stores the tick. The person keeps
  // everything they had; only the claim about where it came from goes.
  const { error } = await adminClient
    .from('players')
    .update({
      permission_role: role,
      permission_grants: storedGrants,
      permission_revokes: revokes,
      permission_baseline_id: role === null ? null : baselineId,
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
        permission_baseline_id: role === null ? null : baselineId,
        effective: [...after].sort(),
      },
      // ALWAYS PRESENT NOW. An editor save carries the one reason typed for the
      // batch; baseline propagation carries the reason typed on the edit that
      // caused it; setConsoleAccess carries its own. So a member's audit trail
      // says why their access moved without anything else having to be found
      // first, which is the entire reason the column is there.
      reason: why,
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

/**
 * Give somebody the console, or take it away — the other half of /permissions,
 * and the half the page's own subtitle has always promised.
 *
 * THIS ACTION WRITES NOTHING ITSELF. It composes two existing guarded actions,
 * in an order chosen below, and that is deliberate: `role`, `is_exec` and
 * `is_trainer` are the hard floor in player-field-access.ts — refused to anyone
 * below admin under all circumstances and reachable by no capability — and the
 * one place enforcing that floor is assertPlayerFieldAccess() inside
 * updatePlayer(). A second path that set those columns directly would be a
 * second place the floor has to be remembered.
 *
 * (Worth knowing while reading that: the guard_player_privileged_columns trigger
 * names the same columns and does NOT cover this path. It opens with `IF
 * auth.uid() IS NULL … RETURN NEW`, and every admin action writes through the
 * service-role client where auth.uid() is NULL — see the header of
 * player-field-access.ts, verified against the live definition. The trigger
 * protects a member editing their own row through PostgREST. The application
 * guard is the only one standing here.)
 *
 * ADMIN BY LEVEL, not by capability, and checked here as well as inside
 * updatePlayer(). Handing out a level is the one act the capability system
 * deliberately cannot express, so `permissions.write` — which an exec may hold —
 * must not be mistaken for permission to do it. The early check is what makes
 * the refusal say so; without it a treasurer would meet "Admin access required
 * to change: role, is_exec, is_trainer", which is true and tells them nothing.
 */
export async function setConsoleAccess(
  playerId: string,
  access: ExecRole,
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(() => setConsoleAccessImpl(playerId, access, reason));
}

async function setConsoleAccessImpl(playerId: string, access: ExecRole, rawReason: string) {
  const actor = await requireCapability('permissions.write');
  // THE SAME FLOOR AS EVERY OTHER AUDITED ACTION. This used to be enforced only
  // by the dialog, at two characters — "ok" reached the audit log — and it now
  // has to hold here as well, because both clearComposition paths below forward
  // this reason into setPlayerPermissions, which measures it against REASON_MIN.
  // Left at two, a console-access change that also cleared a composition would
  // half-apply and report a refusal about a screen the admin never saw.
  const reason = reasonFor(rawReason, 'Changing somebody’s console access');
  if (!isAdminActor(actor)) {
    throw new ExpectedError(
      'Only an admin can give somebody the console or take it away. Ask an admin.',
    );
  }

  // SELF-DEMOTION IS REFUSED, for the reason the permissions row beside it is:
  // this is a page only an admin can open, so an admin who takes their own
  // console access away on it loses the screen they would need to put it back.
  // The database's last-admin guard does not cover this — it protects the last
  // admin who holds a PASSKEY, so a club with two admins would let either one
  // lock themselves out. Somebody who genuinely means to step down asks the
  // other admin, which is the same answer the permissions half already gives.
  if (actor.id === playerId) {
    throw new ExpectedError(
      'You cannot change your own console access. Ask another admin to do it.',
    );
  }

  const adminClient = createAdminClient();
  // The level markers, plus all three permission columns together — naming
  // permission_role without both delta columns makes permissionsOf() throw.
  const { data: target } = await adminClient
    .from('players')
    .select('id, full_name, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes')
    .eq('id', playerId)
    .maybeSingle();
  if (!target) throw new ExpectedError('That member no longer exists.');

  const was = toRoleValue(
    (target.role as string | null) ?? 'player',
    target.is_exec === true,
    target.is_trainer === true,
  );
  const levelChanged = was !== access;

  // A COMPOSITION IS ONLY CONSULTED AT TWO OF THE FOUR LEVELS. An admin is a
  // superuser by level and permits() short-circuits before any stored set is
  // read; somebody with no level never reaches a gate at all. So the stored
  // triple survives exactly one kind of move — executive to varsity trainer and
  // back — where the resolver, which is level-agnostic, goes on resolving it and
  // the page goes on showing it. Every other move clears it.
  //
  // Left behind, it is the dormant-delta hazard the storage CHECKs exist to
  // prevent, one level up: a revoke that stops biting and a grant that stops
  // showing, both invisible on a row with nowhere to apply, ready to wake up the
  // day somebody is promoted again months later.
  const live = (value: ExecRole) => value === 'executive' || value === 'trainer';
  const clears = !(live(was) && live(access));
  const hasComposition =
    (target.permission_role ?? null) !== null ||
    ((target.permission_grants as string[] | null) ?? []).length > 0 ||
    ((target.permission_revokes as string[] | null) ?? []).length > 0;

  // ORDER, AND IT IS NOT ARBITRARY. Clearing a LIVE composition first and then
  // failing to write the level would leave an executive who had just lost their
  // narrowing — a widening produced by a failed operation, which is the one
  // outcome this action must not have. So a live composition is cleared AFTER,
  // where the worst case is an inert delta on a row that no longer reaches a
  // gate, reported loudly here rather than discovered later.
  //
  // A composition that is ALREADY inert — on somebody with no level, or on an
  // admin — has the opposite answer for the same reason: clearing it cannot
  // widen anybody, because it is granting nobody anything right now, and doing
  // it first means a failed level write leaves nothing stale behind at all.
  const clearFirst = clears && hasComposition && !live(was);
  const clearAfter = clears && hasComposition && live(was);

  // NOTHING TO DO ONLY WHEN THERE IS NOTHING LEFT TO DO. "Their level is already
  // what you asked for" is NOT the same question as "does this action have
  // anything to change", and answering the second with the first is how the
  // clear-after path above becomes permanent damage: if the level write lands
  // and the clear then fails, the admin retries, `was` now equals `access`, and
  // an early return here would report success while the stale composition sits
  // there forever with no way to reach it from the console. On that retry
  // clearFirst is true — the level is 'none' now, so the composition is already
  // inert — and the work finishes.
  if (!levelChanged && !clearFirst && !clearAfter) return;

  async function clearComposition(levelAlreadyChanged: boolean) {
    // THE CALLER'S OWN REASON, forwarded. This clear is not a separate decision
    // an admin made; it is part of the console-access change they typed a
    // reason for, and the member's audit trail should say so rather than carry
    // a permissions row explaining nothing beside a level row explaining
    // everything. (It is also what keeps this path working at all now that
    // setPlayerPermissions requires one.)
    const cleared = await setPlayerPermissions(playerId, {
      role: null,
      grants: [],
      revokes: [],
      reason,
    });
    if (!cleared.ok) {
      throw new ExpectedError(
        levelAlreadyChanged
          ? `Console access changed, but their stored permissions could not be cleared: ${cleared.error}`
          : `Their stored permissions could not be cleared, so console access was left alone: ${cleared.error}`,
      );
    }
  }

  if (clearFirst) await clearComposition(false);

  // Through updatePlayer, which applies the field guard, refuses a non-admin,
  // writes the audit row and meets the database's last-admin trigger. All three
  // columns every time, never a subset: fromRoleValue answers the whole question,
  // so moving somebody from executive to trainer clears is_exec in the same write
  // that sets is_trainer, and no marker survives a move it was not part of.
  if (levelChanged) {
    const res = await updatePlayer(playerId, { ...fromRoleValue(access), reason });
    if (!res.ok) throw new ExpectedError(res.error);
  }

  if (clearAfter) await clearComposition(true);

  // updatePlayer revalidates /players and the member's own page; neither is this
  // one, and an executive moved to trainer never reaches setPlayerPermissions
  // above, so nothing else would refresh the list this was changed from.
  revalidatePath('/permissions');
  revalidatePath('/dashboard');
}
