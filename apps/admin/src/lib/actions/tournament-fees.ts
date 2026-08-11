'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  feeTierSchema,
  tournamentFeeMarkSchema,
  type FeeTierInput,
  type TournamentFeeMarkInput,
  ExpectedError,
} from '@badminton/shared';
import { requireCapability } from './_shared';

/**
 * Move the "default" flag onto one tier, restoring the old one if it fails.
 *
 * uq_tournament_fee_tiers_default (00002) is a partial unique index, so this is
 * necessarily two statements with no transaction around them. Between them the
 * tournament has no default tier, and a failure on the second one used to leave
 * it that way permanently. The compensating update puts the previous default
 * back, so the visible outcome of a failure is "the change did not take" rather
 * than the silent "this tournament now prices unlisted players at nothing".
 *
 * If the restore itself fails there is nothing left to try; Sentry and an
 * explicit message are the only honest options, because the state that survives
 * is the one nobody would think to look for.
 */
async function promoteDefaultTier(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  tierId: string,
) {
  const { data: previous } = await adminClient
    .from('tournament_fee_tiers')
    .select('id')
    .eq('tournament_id', tournamentId)
    .eq('is_default', true)
    .neq('id', tierId)
    .maybeSingle();

  if (previous) {
    const { error: clearError } = await adminClient
      .from('tournament_fee_tiers')
      .update({ is_default: false })
      .eq('id', previous.id);
    if (clearError) throw new Error(clearError.message);
  }

  const { data: promoted, error: setError } = await adminClient
    .from('tournament_fee_tiers')
    .update({ is_default: true })
    .eq('id', tierId)
    // Matching no row is not an error in PostgREST, and "no row" is reachable:
    // the tier can be deleted between the clear above and this update. Without
    // the count check that path returns success having left the tournament with
    // no default at all — the exact outcome this function exists to prevent.
    .select('id');
  if (!setError && promoted?.length) return;

  const reason = setError ? setError.message : 'the fee tier no longer exists';

  if (previous) {
    const { error: restoreError } = await adminClient
      .from('tournament_fee_tiers')
      .update({ is_default: true })
      .eq('id', previous.id);
    if (restoreError) {
      Sentry.captureException(
        new Error(`Tournament left with no default fee tier: ${reason} (restore: ${restoreError.message})`),
        { extra: { tournamentId, tierId, previousDefaultId: previous.id } },
      );
      throw new Error(
        'The default fee tier could not be changed, and the previous default could not be restored — ' +
        'this tournament now has no default tier. Set one from the fees page.',
      );
    }
  }
  throw new Error(reason);
}

export async function createFeeTier(input: FeeTierInput) {
  parseOrThrow(feeTierSchema, input);
  const admin = await requireCapability('tournaments.fees.tier.create.write');
  const adminClient = createAdminClient();

  // Create the tier as a NON-default first, then move the default onto it.
  //
  // The old order cleared the tournament's existing default and only then
  // inserted — so an insert that failed UNIQUE(tournament_id, name) reported
  // failure and left the tournament with no default tier at all. Nothing in the
  // console says "this tournament lost its default"; it just starts pricing
  // unlisted players at nothing, and markTournamentFeePaid snapshots a null
  // amount. Doing the write that can fail on its own data FIRST means a
  // rejected name changes nothing.
  //
  // uq_tournament_fee_tiers_default (00002) is a partial unique index on
  // tournament_id WHERE is_default, so the flip genuinely has to be
  // clear-then-set; it cannot be one statement through PostgREST.
  const { data: tier, error } = await adminClient
    .from('tournament_fee_tiers')
    .insert({
      tournament_id: input.tournament_id,
      name: input.name,
      amount_cents: input.amount_cents,
      // Which memberships this tier prices (00094). `?? null` and not omitted:
      // null is the meaningful value — "anyone" — and leaving the key out would
      // work only because the column happens to default to it.
      applies_to: input.applies_to ?? null,
      is_default: false,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  if (input.is_default) {
    try {
      await promoteDefaultTier(adminClient, input.tournament_id, tier.id);
    } catch (err) {
      // The tier itself was created; only the default flag failed to move.
      // Push the fresh list before rethrowing and say so plainly — otherwise
      // the admin reads "failed" on a stale page, retries the same name, and
      // gets a duplicate-key error for a tier they believe was never made.
      revalidatePath(`/tournaments/${input.tournament_id}/fees`);
      throw new Error(
        `"${input.name}" was created, but could not be made the default tier: ` +
        (err instanceof Error ? err.message : 'unknown error'),
      );
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_created',
    target_type: 'tournament_fee_tier',
    target_id: tier.id,
    new_value: input,
  }, { tournamentId: input.tournament_id });

  revalidatePath(`/tournaments/${input.tournament_id}/fees`);
}

export async function updateFeeTier(id: string, input: Partial<FeeTierInput>) {
  parseOrThrow(feeTierSchema.partial(), input);
  const admin = await requireCapability('tournaments.fees.tier.update.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('tournament_fee_tiers')
    .select('*')
    .eq('id', id)
    .single();
  if (!old) throw new Error('Fee tier not found');

  // Same ordering as createFeeTier, and for the same reason: the field update
  // is the one that can fail on UNIQUE(tournament_id, name), so it goes first
  // and a rejected rename leaves the tournament's existing default alone.
  // Clearing it up front meant a rename to an already-used name reported
  // failure AND silently removed the default.
  //
  // tournament_id is dropped rather than applied. feeTierSchema.partial()
  // accepts it, so this action would happily move a tier to another
  // tournament — and every entry-fee row already pointing at that tier
  // would silently become a cross-tournament reference, which is the same
  // corruption markTournamentFeePaid now refuses to create. A tier belongs to
  // the tournament it was made for; renaming and repricing are the edits.
  const { is_default: wantsDefault, tournament_id: _ignored, ...fields } = input;
  const changes = wantsDefault === false ? { ...fields, is_default: false } : fields;
  if (Object.keys(changes).length > 0) {
    const { error } = await adminClient.from('tournament_fee_tiers').update(changes).eq('id', id);
    if (error) throw new Error(error.message);
  }

  if (wantsDefault === true) {
    await promoteDefaultTier(adminClient, old.tournament_id, id);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_updated',
    target_type: 'tournament_fee_tier',
    target_id: id,
    old_value: old,
    // What was actually written, not what was asked for. Logging `input` would
    // record the tournament_id move that this action deliberately refuses —
    // an audit trail claiming a change that never happened.
    new_value: { ...changes, ...(wantsDefault === true ? { is_default: true } : {}) },
  }, { tournamentId: old.tournament_id });

  revalidatePath(`/tournaments/${old.tournament_id}/fees`);
}

export async function deleteFeeTier(id: string) {
  const admin = await requireCapability('tournaments.fees.tier.delete.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('tournament_fee_tiers')
    .select('*')
    .eq('id', id)
    .single();
  if (!old) throw new Error('Fee tier not found');

  const { error } = await adminClient.from('tournament_fee_tiers').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_deleted',
    target_type: 'tournament_fee_tier',
    target_id: id,
    old_value: old,
  }, { tournamentId: old.tournament_id });

  revalidatePath(`/tournaments/${old.tournament_id}/fees`);
}

export async function markTournamentFeePaid(input: TournamentFeeMarkInput) {
  parseOrThrow(tournamentFeeMarkSchema, input);
  const admin = await requireCapability('tournaments.fees.markpaid.write');
  const adminClient = createAdminClient();

  // Snapshot the amount: explicit input, else the chosen tier's amount, else the
  // tournament's default tier's amount. Records the tier that determined it.
  let tierId = input.tier_id ?? null;
  let amountCents = input.amount_cents ?? null;

  if (tierId) {
    // club_fees.tier_id is a plain FK to tournament_fee_tiers(id)
    // (00001), which constrains the tier to exist and nothing more — a tier
    // belonging to a DIFFERENT tournament is a perfectly valid row as far as
    // Postgres is concerned. The lookup used to be keyed on the id alone, so
    // passing tournament B's tier id while marking a fee for tournament A
    // copied B's price onto A's fee and stored B's tier against it. This
    // filters on the pair, so a tier from another tournament simply is not
    // found.
    //
    // Checked whenever a tier is named, not only when the amount has to be
    // derived from it. The old code skipped the lookup entirely when an
    // explicit amount was supplied, which meant the one input path that never
    // validated the tier was also the one that stored it verbatim.
    const { data: tier } = await adminClient
      .from('tournament_fee_tiers')
      .select('id, amount_cents')
      .eq('id', tierId)
      .eq('tournament_id', input.tournament_id)
      .maybeSingle();
    if (!tier) throw new ExpectedError('That fee tier does not belong to this tournament.');
    if (amountCents == null) amountCents = tier.amount_cents;
  } else if (amountCents == null) {
    const { data: tier } = await adminClient
      .from('tournament_fee_tiers')
      .select('id, amount_cents')
      .eq('tournament_id', input.tournament_id)
      .eq('is_default', true)
      .maybeSingle();
    tierId = tier?.id ?? null;
    amountCents = tier?.amount_cents ?? null;
  }

  // WHICH SEASON THIS MONEY COUNTS TOWARD, stamped on rather than joined.
  // Entry fees used to reach a season through tournaments.season_id at read
  // time; club_fees carries the season itself, the same rule 00069 arrived at
  // for reinstatements and 00073 built in from the start. Nullable, because
  // tournaments.season_id is (00001) — a tournament outside every season is a
  // real row, and refusing to record its money would be worse than recording it
  // unattached.
  const { data: tournament } = await adminClient
    .from('tournaments')
    .select('season_id')
    .eq('id', input.tournament_id)
    .maybeSingle();

  // READ, THEN UPDATE OR INSERT — see the note in actions/fees.ts. 00094's
  // uniqueness is a partial index (… WHERE fee_type = 'tournament'), which
  // PostgREST cannot infer as an upsert arbiter.
  const { data: existing } = await adminClient
    .from('club_fees')
    .select('id')
    .eq('tournament_id', input.tournament_id)
    .eq('player_id', input.player_id)
    .eq('fee_type', 'tournament')
    .maybeSingle();

  const payment = {
    tier_id: tierId,
    amount_cents: amountCents,
    paid_at: new Date().toISOString(),
    marked_by: admin.id,
    method: input.method ?? null,
    reference: input.reference ?? null,
  };

  let fee: { id: string };
  if (existing) {
    const { data: updated, error } = await adminClient
      .from('club_fees')
      .update(payment)
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    fee = updated;
  } else {
    const { data: inserted, error } = await adminClient
      .from('club_fees')
      .insert({
        fee_type: 'tournament',
        tournament_id: input.tournament_id,
        player_id: input.player_id,
        season_id: tournament?.season_id ?? null,
        ...payment,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ExpectedError(
          'An entry fee was recorded for this player while you were marking it paid. Reload and check before trying again.',
        );
      }
      throw new Error(error.message);
    }
    fee = inserted;
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_marked_paid',
    target_type: 'tournament_fee',
    target_id: fee.id,
    new_value: {
      tournament_id: input.tournament_id,
      player_id: input.player_id,
      tier_id: tierId,
      amount_cents: amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  }, { tournamentId: input.tournament_id, playerId: input.player_id });

  revalidatePath(`/tournaments/${input.tournament_id}/fees`);
}

export async function markTournamentFeeUnpaid(tournamentId: string, playerId: string) {
  const admin = await requireCapability('tournaments.fees.markunpaid.write');
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, tournament_id, player_id, tier_id, amount_cents, paid_at, method')
    .eq('tournament_id', tournamentId)
    .eq('player_id', playerId)
    .eq('fee_type', 'tournament')
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  // The row STAYS, with only the payment fields cleared — the entry itself is
  // still a fact, and the member still owes for it. Same as markFeeUnpaid.
  const { error } = await adminClient
    .from('club_fees')
    .update({ paid_at: null, marked_by: null, method: null })
    .eq('id', oldFee.id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_marked_unpaid',
    target_type: 'tournament_fee',
    target_id: oldFee.id,
    old_value: oldFee,
    new_value: { paid_at: null, marked_by: null, method: null },
  }, { tournamentId, playerId });

  revalidatePath(`/tournaments/${tournamentId}/fees`);
}
