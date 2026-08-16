'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { execBioSchema, parseOrThrow, ExpectedError } from '@badminton/shared';
import { createServiceRoleClient } from '../supabase-server';
import { requirePlayer, runAction, type ActionResult } from './_shared';

/**
 * The exec panel's one write: an officer's own blurb on the club's public /exec
 * page (players.exec_bio, 00130).
 *
 * A FILE OF ITS OWN rather than another branch of updateProfile. This is not a
 * profile edit — it is publishing text under the club's name to a page a
 * logged-out stranger can read — and the two need different gates. updateProfile
 * asks only "are you a member in good standing"; this asks "are you an officer,
 * and is this your own card".
 */
export async function updateExecBio(bio: string): Promise<ActionResult> {
  return runAction(() => updateExecBioImpl(bio));
}

async function updateExecBioImpl(bio: string) {
  const { exec_bio } = parseOrThrow(execBioSchema, { exec_bio: bio });

  // Resolves the caller from their VERIFIED session and reads their own row.
  // There is deliberately no player id parameter on this action: whose bio this
  // is, is not something the client gets a say in.
  const player = await requirePlayer();

  // ---- WHO MAY EDIT AN EXEC BIO: THE OFFICER, AND ONLY THEIR OWN ----
  //
  // `is_exec` alone, and NOT `is_exec || role === 'admin'`. The predicate here
  // is the one get_executives() uses — `is_exec AND active_flag` — because the
  // gate has to match the page. An admin who is not on the exec team has no
  // card on /exec to edit, so admitting them would be a write with no rendered
  // consequence. (requirePlayer() has already rejected or reactivated an
  // inactive account, so active_flag is settled by the time we get here.)
  //
  // A VARSITY TRAINER IS NOT AN EXEC. is_trainer opens the console (00054); it
  // puts nobody on the public page, so a trainer is refused here exactly as a
  // plain member is, and their personal bio stays private. This is the same
  // distinction Settings draws, and it is the one thing about this feature that
  // is easiest to break by reaching for hasConsoleAccess().
  if (!player.is_exec) {
    throw new ExpectedError('Only members of the exec team can edit the exec page');
  }

  // NO CAPABILITY IS CONSULTED, and that is a decision rather than an omission.
  // The club owner asked to separate the two bios, not to let officers rewrite
  // each other's; self-only needs no capability at all, and inventing one for a
  // gate nobody asked for would be a permission that lies about what the app
  // enforces (capability-gates.ts exists to stop exactly that).
  //
  // IF CROSS-EDITING IS EVER WANTED, the capability is already there and it is
  // `players.privilegedfields.write`. It governs exec_title and exec_photo_url
  // (admin/src/lib/player-field-access.ts PLAYER_FIELD_PRIVILEGED) — the other
  // two fields that publish to /exec — so the officer's blurb belongs beside
  // them and nowhere else. Note before doing it: CAPABILITY_GATES asserts ONE
  // enforcement point per capability, so a second reader needs an `also` entry
  // and a `merged` justification, or the drift test fails.

  // SERVICE-ROLE, not the caller's JWT. Two reasons, and both are about keeping
  // the rule in one place:
  //   - `authenticated` has no SELECT grant on exec_bio (00130 §4a), so a
  //     PostgREST write asking for the row back would 403 on the read half.
  //   - the gate above is the whole authorization, and it lives here. Routing
  //     through RLS as well would put half the rule in the database and half in
  //     this file, which is how the two drift.
  // The filter is player.id, which came from the verified session and never
  // from the request body, so this can only ever write the caller's own row.
  const { error } = await createServiceRoleClient()
    .from('players')
    .update({ exec_bio })
    .eq('id', player.id);

  if (error) {
    Sentry.captureException(error, { extra: { action: 'updateExecBio', playerId: player.id } });
    throw new Error(error.message);
  }

  // /exec is `force-dynamic`, so this is belt and braces rather than the thing
  // that makes the change visible — the editor calls router.refresh() and the
  // page re-runs get_executives() on the next request either way.
  revalidatePath('/exec');
}
