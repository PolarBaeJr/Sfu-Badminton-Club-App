'use server';

import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  otherIncomeSchema,
  clubExpenseSchema,
  type OtherIncomeInput,
  type ClubExpenseInput,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { getAdminPlayer } from './_shared';

/**
 * The two non-fee money ledgers: other income (donations, grants, socials) and
 * club expenses (shuttles, court rental, ...). Tables land in 00073.
 *
 * ADMIN-ONLY, ENFORCED HERE. /fees is admin-level in permissions.ts and these
 * live under it, but the route check is middleware and the real boundary is the
 * action: every function below calls getAdminPlayer() (= getAuthenticatedAdmin)
 * before it touches the database. createAdminClient() is service-role and
 * bypasses RLS entirely, so an ungated action would be an open write endpoint
 * no matter what the route map says.
 *
 * EVERY MUTATION IS AUDITED, matching how the club_fees actions do it: the
 * inserted/deleted row is recorded in audit_logs with the acting admin. Money
 * moving with nobody's name on it is the thing an audit trail exists for.
 *
 * ROW COUNTS ARE CHECKED ON DELETE. PostgREST reports "matched no rows" as
 * success — `error` is null and `data` is an empty array — so a delete against
 * an id that no longer exists returns exactly what a successful delete returns.
 * Several bugs shipped by trusting an error that never arrives. Each delete
 * below asks for the deleted rows back and refuses to report success unless
 * exactly one came out.
 */

/** paid_at defaults to now: recording an entry means the money already moved. */
const paidAtOrNow = (given: string | undefined) => given ?? new Date().toISOString();

export async function addOtherIncome(input: OtherIncomeInput) {
  const parsed = parseOrThrow(otherIncomeSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const row = {
    season_id: parsed.season_id,
    category: parsed.category,
    description: parsed.description,
    amount_cents: parsed.amount_cents,
    paid_at: paidAtOrNow(parsed.paid_at),
    marked_by: admin.id,
    method: parsed.method ?? null,
    reference: parsed.reference ?? null,
  };

  const { data: created, error } = await adminClient
    .from('other_income')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'other_income_added',
    target_type: 'other_income',
    target_id: created.id,
    new_value: row,
  }, { seasonId: parsed.season_id });

  revalidatePath('/fees');
}

export async function removeOtherIncome(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Read first so the audit entry carries what was destroyed. Without it the
  // log records that an amount was deleted but not which one — there is a
  // fee_waived row on production with an empty old_value for exactly that
  // reason (see waiveFee).
  const { data: existing } = await adminClient
    .from('other_income')
    .select('id, season_id, category, description, amount_cents, paid_at, method, reference')
    .eq('id', id)
    .maybeSingle();
  if (!existing) throw new Error('Income entry not found');

  // .select() so the deleted rows come back. Without it a delete matching
  // nothing is indistinguishable from a delete that worked.
  const { data: deleted, error } = await adminClient
    .from('other_income')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) throw new Error(error.message);
  if (!deleted || deleted.length !== 1) {
    throw new Error('Income entry was not deleted — it may have been removed already');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'other_income_removed',
    target_type: 'other_income',
    target_id: id,
    old_value: existing,
  }, { seasonId: existing.season_id });

  revalidatePath('/fees');
}

export async function addExpense(input: ClubExpenseInput) {
  const parsed = parseOrThrow(clubExpenseSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const row = {
    season_id: parsed.season_id,
    category: parsed.category,
    description: parsed.description,
    amount_cents: parsed.amount_cents,
    quantity: parsed.quantity ?? null,
    paid_at: paidAtOrNow(parsed.paid_at),
    marked_by: admin.id,
    method: parsed.method ?? null,
    reference: parsed.reference ?? null,
  };

  const { data: created, error } = await adminClient
    .from('club_expenses')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_added',
    target_type: 'club_expense',
    target_id: created.id,
    new_value: row,
  }, { seasonId: parsed.season_id });

  revalidatePath('/fees');
}

export async function removeExpense(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_expenses')
    .select('id, season_id, category, description, amount_cents, quantity, paid_at, method, reference')
    .eq('id', id)
    .maybeSingle();
  if (!existing) throw new Error('Expense not found');

  const { data: deleted, error } = await adminClient
    .from('club_expenses')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) throw new Error(error.message);
  if (!deleted || deleted.length !== 1) {
    throw new Error('Expense was not deleted — it may have been removed already');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_removed',
    target_type: 'club_expense',
    target_id: id,
    old_value: existing,
  }, { seasonId: existing.season_id });

  revalidatePath('/fees');
}
