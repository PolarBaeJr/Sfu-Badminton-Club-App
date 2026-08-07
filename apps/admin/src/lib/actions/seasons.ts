'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, seasonFeeSchema, seasonCreateSchema, ExpectedError, clubToday, type SeasonFeeInput, type SeasonCreateInput } from '@badminton/shared';
import { getAdminPlayer, getExecOrAdmin } from './_shared';

// term + year are the real inputs, not a name. seasons.name is DERIVED from them
// by trg_set_season_name (00043) so it can never drift from the pair.
//
// This used to send only a free-text `name`, leaving term and year null — and
// both are NOT NULL with no default, so creating a season failed with a not-null
// violation every time. It went unnoticed because the club has had exactly one
// season, created before 00043 added the columns.
export async function createSeason(data: SeasonCreateInput) {
  const input = parseOrThrow(seasonCreateSchema, data);
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: season, error } = await adminClient.from('seasons').insert({
    term: input.term,
    year: input.year,
    start_date: input.start_date,
    end_date: input.end_date || null,
    active_flag: false,
    // name deliberately omitted — the trigger writes it from term/year. Sending
    // one here would be overwritten anyway, so passing it would only create a
    // second, disagreeing source of truth.
  }).select().single();

  if (error) {
    // seasons_term_year_unique (00043): one season per term per year, because
    // two "Fall 2026" rows would split that season's matches across both.
    if (error.code === '23505') {
      throw new ExpectedError(`${input.term[0]!.toUpperCase()}${input.term.slice(1)} ${input.year} already exists.`);
    }
    throw new Error(error.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_created',
    target_type: 'season',
    target_id: season.id,
    new_value: data,
  });

  revalidatePath('/seasons');
}

export async function updateSeasonFees(seasonId: string, fees: SeasonFeeInput) {
  parseOrThrow(seasonFeeSchema, fees);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('seasons')
    .select('competitive_fee_cents, recreational_fee_cents')
    .eq('id', seasonId)
    .single();

  const { error } = await adminClient
    .from('seasons')
    .update({
      competitive_fee_cents: fees.competitive_fee_cents,
      recreational_fee_cents: fees.recreational_fee_cents,
    })
    .eq('id', seasonId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_fees_updated',
    target_type: 'season',
    target_id: seasonId,
    old_value: old,
    new_value: fees,
  }, { seasonId });

  revalidatePath('/seasons');
  revalidatePath('/fees');
}

export type SeasonEloPolicy = 'carry' | 'soft' | 'full';

export async function setActiveSeason(seasonId: string, eloPolicy: SeasonEloPolicy = 'carry') {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  // Atomic: snapshot the outgoing season's ELO, switch active, apply the policy.
  // The policy only changes ratings — match history and W-L records are kept.
  const { error } = await adminClient.rpc('activate_season', {
    p_season_id: seasonId,
    p_elo_policy: eloPolicy,
  });
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_activated',
    target_type: 'season',
    target_id: seasonId,
    new_value: { elo_policy: eloPolicy },
  }, { seasonId });

  revalidatePath('/seasons');
  revalidatePath('/fees');
}

export async function endSeason(seasonId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('seasons').update({
    active_flag: false,
    // The club's calendar date, not the server's UTC one. toISOString() gives
    // the UTC date, and Vancouver is UTC-7/-8 — so an exec ending a season at
    // 6pm on Friday stamped it as ending Saturday. end_date is a DATE the club
    // reads as "the day we finished", and it also bounds season reporting.
    end_date: clubToday(),
  }).eq('id', seasonId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_ended',
    target_type: 'season',
    target_id: seasonId,
  }, { seasonId });

  revalidatePath('/seasons');
}
