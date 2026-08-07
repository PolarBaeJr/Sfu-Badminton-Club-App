'use server';

import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  otherIncomeSchema,
  clubExpenseSchema,
  clubExpenseUpdateSchema,
  type OtherIncomeInput,
  type ClubExpenseInput,
  type ClubExpenseUpdateInput,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { getAdminPlayer, getExecOrAdmin } from './_shared';

/**
 * The two non-fee money ledgers: other income (donations, grants, socials) and
 * club expenses (shuttles, court rental, ...). Tables land in 00073;
 * reimbursement state lands in 00077.
 *
 * WHO MAY DO WHAT, AND WHY IT IS ENFORCED HERE. createAdminClient() is
 * service-role and bypasses RLS entirely, so the gate at the top of each
 * function IS the boundary — the route map in permissions.ts is middleware and
 * decides only who may open the page. An ungated action would be an open write
 * endpoint no matter what that map says.
 *
 *   addExpense               exec or admin
 *   everything else here     admin only  (including updateExpense)
 *
 * addExpense is the one exception, and it is the club owner's: "allow execs to
 * add expenses too". An exec who buys shuttles out of their own pocket has to
 * be able to say so, or the club never learns the money went out and the exec
 * never gets paid back. That is bookkeeping. DELETING an expense is not — it
 * erases a spend from the season total with no second copy of the number
 * anywhere — so removeExpense keeps getAdminPlayer(), as do both halves of the
 * income ledger, which is club money an exec has no stake in.
 *
 * markExpenseReimbursed is admin-only for the plainest reason: it asserts the
 * club has paid someone. An exec confirming their own reimbursement is the
 * whole point of not letting them.
 *
 * EVERY MUTATION IS AUDITED, matching how the club_fees actions do it: the
 * inserted/deleted row is recorded in audit_logs with the acting admin. Money
 * moving with nobody's name on it is the thing an audit trail exists for.
 *
 * ROW COUNTS ARE CHECKED ON EVERY DELETE AND EVERY UPDATE. PostgREST reports
 * "matched no rows" as success — `error` is null and `data` is an empty array —
 * so a delete or update against an id that no longer exists returns exactly
 * what a successful one returns. Several bugs shipped by trusting an error that
 * never arrives. Every mutation below asks for the affected rows back with
 * .select() and refuses to report success unless exactly one came out.
 */

/** paid_at defaults to now: recording an entry means the money already moved. */
const paidAtOrNow = (given: string | undefined) => given ?? new Date().toISOString();

/**
 * A payer has to be someone who could plausibly have bought something for the
 * club — an exec or an admin.
 *
 * The dialog only offers those people, but the dialog is not the boundary: a
 * server action can be invoked directly with any payload, and `paid_by` is
 * validated by the schema only as "a uuid". Without this an exec could name any
 * member — including one who has no idea — as the person the club owes money
 * to, and the reimbursement flow would then hand that debt to an admin to
 * settle.
 *
 * Silent on a null payer, which is the "club funds" case and names nobody.
 */
async function assertEligiblePayer(
  adminClient: ReturnType<typeof createAdminClient>,
  paidBy: string | null,
) {
  if (!paidBy) return;
  const { data: payer } = await adminClient
    .from('players')
    .select('id, role, is_exec')
    .eq('id', paidBy)
    .maybeSingle();
  if (!payer) throw new Error('That payer is not a member of the club');
  if (payer.role !== 'admin' && !payer.is_exec) {
    throw new Error('Only an exec or an admin can be recorded as having paid for the club');
  }
}

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

/**
 * Record money out. The ONE action in this file an exec may call — see the
 * module header.
 *
 * paid_by is taken from the input, never from the actor. The two are different
 * people whenever an admin writes up an exec's receipt, and defaulting it to
 * the actor would file the admin as the one owed the money. Absent means the
 * club account paid directly and nobody is owed; the dialog makes the caller
 * choose rather than letting either case be the silent default.
 */
export async function addExpense(input: ClubExpenseInput) {
  const parsed = parseOrThrow(clubExpenseSchema, input);
  const actor = await getExecOrAdmin();
  const adminClient = createAdminClient();
  await assertEligiblePayer(adminClient, parsed.paid_by ?? null);

  const row = {
    season_id: parsed.season_id,
    category: parsed.category,
    description: parsed.description,
    amount_cents: parsed.amount_cents,
    quantity: parsed.quantity ?? null,
    paid_at: paidAtOrNow(parsed.paid_at),
    marked_by: actor.id,
    paid_by: parsed.paid_by ?? null,
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
    actor_id: actor.id,
    action_type: 'expense_added',
    target_type: 'club_expense',
    target_id: created.id,
    new_value: row,
  }, { seasonId: parsed.season_id });

  revalidatePath('/fees');
}

/**
 * Correct an expense that has already been recorded. ADMIN ONLY.
 *
 * The club owner asked for this so a typo in a description or a fat-fingered
 * amount does not need a delete and a re-entry. Admin-only for the same reason
 * removeExpense is: an exec recording their own spend is bookkeeping, an exec
 * silently raising the figure afterwards is not.
 *
 * ONCE REIMBURSED, THE AMOUNT AND THE PAYER ARE FROZEN.
 * This is the one real decision in this function. A reimbursement was settled
 * against a specific figure paid to a specific person, and both of those are
 * now facts about money that has already changed hands twice — the exec paid
 * the shop, the club paid the exec. Editing either turns the row into a claim
 * that the club reimbursed an amount it did not reimburse, or reimbursed
 * somebody it did not pay. The badge on the row would assert it, and nobody
 * reads the audit log to check a badge. Everything that does NOT change what
 * was settled — description, category, quantity, date, method, reference —
 * stays editable, which covers the typo case the owner actually described.
 *
 * The two alternatives, and what each would have meant:
 *
 *   - CLEAR THE REIMBURSEMENT when the amount changes. Rejected: the club
 *     really did pay that money out, on a date, confirmed by a named admin, and
 *     an edit to a description-adjacent field would destroy all three. It also
 *     hides the interesting case — if the reimbursed amount was wrong, someone
 *     was underpaid or overpaid, and quietly resetting the row to "owed"
 *     obscures which.
 *   - ALLOW IT AND RECORD BOTH VALUES IN THE AUDIT ROW. Rejected as the only
 *     protection: the audit trail is reconstructible but the visible row is
 *     wrong, and the person harmed (the exec who was paid the old figure) reads
 *     the row, not audit_logs. Both values ARE recorded here regardless — that
 *     part of the option is kept for every edit, not used as a substitute for
 *     refusing this one.
 *
 * A settled expense whose amount is genuinely wrong therefore needs an admin to
 * delete it and re-record it. That is deliberate friction: it is a statement
 * that a reimbursement was paid incorrectly, which is a conversation with a
 * person, not a form field.
 */
export async function updateExpense(input: ClubExpenseUpdateInput) {
  const parsed = parseOrThrow(clubExpenseUpdateSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_expenses')
    .select('id, season_id, category, description, amount_cents, quantity, paid_at, paid_by, reimbursed_at, reimbursed_by, method, reference')
    .eq('id', parsed.id)
    .maybeSingle();
  if (!existing) throw new Error('Expense not found');

  // A FULL REPLACEMENT, exactly like addExpense: an omitted payer means "the
  // club paid, nobody is owed", not "leave it alone". The dialog always resends
  // the stored value, and on a settled row the equality check below refuses an
  // omission outright rather than quietly un-assigning the person the club has
  // already paid.
  const nextPaidBy = parsed.paid_by ?? null;
  const settled = Boolean(existing.reimbursed_at);
  if (settled && parsed.amount_cents !== existing.amount_cents) {
    throw new Error(
      'This expense has already been reimbursed — its amount can no longer be changed. Delete it and re-record it if the reimbursement was wrong.',
    );
  }
  if (settled && nextPaidBy !== (existing.paid_by ?? null)) {
    throw new Error(
      'This expense has already been reimbursed — who paid it can no longer be changed.',
    );
  }
  await assertEligiblePayer(adminClient, nextPaidBy);

  const patch = {
    category: parsed.category,
    description: parsed.description,
    amount_cents: parsed.amount_cents,
    quantity: parsed.quantity ?? null,
    // Keeps the stored date when the caller sends none, rather than stamping
    // today the way an INSERT does. An edit that silently re-dated a spend to
    // whenever the typo was noticed would move it in every date-ordered view
    // for no reason the admin asked for.
    paid_at: parsed.paid_at ?? existing.paid_at ?? new Date().toISOString(),
    paid_by: nextPaidBy,
    method: parsed.method ?? null,
    reference: parsed.reference ?? null,
  };

  // The reimbursement state is re-checked BY THE DATABASE, not just by the read
  // above. Between that read and this write another admin can mark the row
  // reimbursed; without this filter the amount change would land on a settled
  // row anyway and the guard would have been decoration. When the row was
  // already settled the filter matches on its stored timestamp instead, so the
  // still-permitted edits (description, category, ...) go through.
  const query = adminClient.from('club_expenses').update(patch).eq('id', parsed.id);
  const scoped = settled
    ? query.eq('reimbursed_at', existing.reimbursed_at)
    : query.is('reimbursed_at', null);

  const { data: updated, error } = await scoped.select('id');
  if (error) throw new Error(error.message);
  // PostgREST calls "matched no rows" a success. Without this an admin is
  // toasted "Saved" for an edit that never landed — on a money figure.
  if (!updated || updated.length !== 1) {
    throw new Error('Expense was not updated — someone else may have just changed it');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_updated',
    target_type: 'club_expense',
    target_id: parsed.id,
    // Both sides in full, so a changed amount is reconstructible from the log
    // alone without a second query against a row that may later be deleted.
    old_value: existing,
    new_value: patch,
  }, { seasonId: existing.season_id });

  revalidatePath('/fees');
}

/**
 * Confirm the club has paid back whoever fronted an expense. ADMIN ONLY.
 *
 * Changes NO money figure. The expense already counted against the season net
 * the moment it was recorded and it still does — see season-finance.ts for why.
 * This records that a debt to a person is settled, nothing more.
 *
 * Three guards, because three different wrong things can be reported as
 * success:
 *
 *  1. The row is read first. Without it, "already reimbursed", "row was
 *     deleted" and "the club paid for this, there is nobody to reimburse" all
 *     produce the same zero-row update and would all be reported identically.
 *     Each gets its own message here, so an admin who is told nothing happened
 *     knows which nothing it was.
 *
 *  2. The update filters on `reimbursed_at IS NULL`. That makes a double
 *     submit a no-op rather than silently rewriting the original settlement
 *     date to today — a month-old reimbursement quietly re-dated is a figure
 *     nobody would ever notice was wrong.
 *
 *  3. The affected rows are counted. PostgREST returns `error: null` and an
 *     empty array for an update that matched nothing, which is byte for byte
 *     what a successful update returns. Between the read and the write another
 *     admin can settle or delete the same row; without this check the second
 *     admin is toasted "Marked reimbursed" for a write that never happened, and
 *     an audit row is filed swearing it did.
 *
 * AND IT SETTLES ONLY WHAT THE ADMIN ACTUALLY CONFIRMED. The caller passes the
 * amount and the payer it displayed in the confirm dialog, and both are part of
 * the WHERE clause. Taking only the id would mean the click approves whatever
 * the row happens to say at the instant the write lands: another admin edits
 * "$84, Alice" to "$840, Bob" in between, and the first admin's "yes, pay Alice
 * back her $84" silently becomes "yes, pay Bob $840". Nothing on screen would
 * ever have shown that figure to the person who approved it.
 */
export async function markExpenseReimbursed(
  id: string,
  /** What the confirm dialog showed. The settlement is refused if the row has moved. */
  confirmed: { amountCents: number; paidBy: string },
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_expenses')
    .select('id, season_id, description, amount_cents, paid_by, reimbursed_at, reimbursed_by')
    .eq('id', id)
    .maybeSingle();
  if (!existing) throw new Error('Expense not found');
  if (!existing.paid_by) {
    throw new Error('This expense was paid from club funds — there is nobody to reimburse');
  }
  if (existing.reimbursed_at) throw new Error('This expense is already marked reimbursed');
  // Checked here for the readable message, and again in the WHERE clause below
  // for the race. This branch alone would be decoration.
  if (existing.amount_cents !== confirmed.amountCents || existing.paid_by !== confirmed.paidBy) {
    throw new Error('This expense changed while you were looking at it — reload and check it again');
  }

  const reimbursed_at = new Date().toISOString();

  const { data: updated, error } = await adminClient
    .from('club_expenses')
    .update({ reimbursed_at, reimbursed_by: admin.id })
    .eq('id', id)
    .is('reimbursed_at', null)
    .eq('amount_cents', confirmed.amountCents)
    .eq('paid_by', confirmed.paidBy)
    .select('id');
  if (error) throw new Error(error.message);
  if (!updated || updated.length !== 1) {
    throw new Error('Expense was not marked reimbursed — someone else may have just changed it');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'expense_reimbursed',
    target_type: 'club_expense',
    target_id: id,
    // Both sides, so the log answers "who was paid back, how much, and when"
    // without a join against a row that may later be deleted.
    old_value: existing,
    new_value: { reimbursed_at, reimbursed_by: admin.id, paid_by: existing.paid_by },
  }, { seasonId: existing.season_id });

  revalidatePath('/fees');
}

/**
 * ADMIN ONLY, deliberately not exec, even though an exec may add one. Recording
 * a spend adds a fact; deleting one erases money from the season total and
 * there is no second copy of the figure anywhere. It would also let an exec
 * remove an expense an admin had already reimbursed them for.
 */
export async function removeExpense(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('club_expenses')
    .select('id, season_id, category, description, amount_cents, quantity, paid_at, paid_by, reimbursed_at, reimbursed_by, method, reference')
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
