'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { getAdminPlayer } from './_shared';
import { PORTFOLIOS, type Portfolio } from '../permissions';
import { runAction, type ActionResult } from '../action-result';

/**
 * Assign (or clear) an exec's portfolio — the write half of /permissions.
 *
 * ADMIN-ONLY, on getAdminPlayer(). An exec who could call this could widen
 * their own portfolio back to everything, or narrow a colleague out of the job
 * they were elected to do. It is the same boundary that keeps role, is_exec and
 * is_trainer with admins (see player-field-access.ts), and the database agrees:
 * players.portfolio sits in guard_player_privileged_columns (00086).
 *
 * Audited like every other privileged change. Handing out and taking away
 * access is exactly what the audit log is for, and a portfolio is now the
 * difference between an exec who can open the club's books and one who cannot.
 */
export async function setPlayerPortfolio(
  playerId: string,
  portfolio: Portfolio | null,
): Promise<ActionResult<void>> {
  return runAction(() => setPlayerPortfolioImpl(playerId, portfolio));
}

async function setPlayerPortfolioImpl(playerId: string, portfolio: Portfolio | null) {
  const admin = await getAdminPlayer();

  // Checked against the closed set rather than trusted from the client: the
  // CHECK constraint in 00086 would refuse an unknown value anyway, but a
  // constraint violation reaches the admin as a Postgres error string, and an
  // unknown portfolio that DID land would leave its holder with the baseline
  // and no explanation.
  if (portfolio !== null && !PORTFOLIOS.includes(portfolio)) {
    throw new ExpectedError('That is not a portfolio');
  }

  const adminClient = createAdminClient();
  const { data: target } = await adminClient
    .from('players')
    .select('id, full_name, is_exec, portfolio')
    .eq('id', playerId)
    .maybeSingle();
  if (!target) throw new ExpectedError('That member no longer exists.');

  // A portfolio only ever narrows an EXEC. On anyone else it is a value nothing
  // reads — admins are superusers and trainers hold no portfolio — so storing
  // one would be a promise the app does not keep, and it would come into force
  // silently on the day they were made an exec.
  if (portfolio !== null && !target.is_exec) {
    throw new ExpectedError('Portfolios narrow an exec, so only an exec can hold one.');
  }

  const { error } = await adminClient
    .from('players')
    .update({ portfolio })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_portfolio_changed',
    target_type: 'player',
    target_id: playerId,
    old_value: { portfolio: target.portfolio ?? null },
    new_value: { portfolio },
  }, { playerId });

  revalidatePath('/permissions');
  revalidatePath('/players');
  // The sidebar and the dashboard are both filtered by portfolio, so the person
  // whose access just changed must not keep a cached copy of the old one.
  revalidatePath('/dashboard');
}
