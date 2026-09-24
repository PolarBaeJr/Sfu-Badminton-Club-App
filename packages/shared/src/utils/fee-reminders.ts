// WHO STILL HAS TO PAY, AND WHO MAY BE NUDGED ABOUT IT.
//
// Three readers ask the same question of a member's fee lines: the banner on
// /feed and /membership ("You have $X unpaid"), the console's Remind button,
// and the Paid badge on a profile. Pure functions over the lines, so the rules
// are tested once and the three cannot drift.
//
// A LINE is one club_fees row, or the dues a member owes this season before
// any row exists for them (paidAt null, nothing reminded).

import type { FeeType } from '../types/database';
import { isReservedMethod } from './payment-methods';

/** An exec's reminder is not repeated to the same member within this window. */
export const PAYMENT_REMINDER_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

export interface PayableFeeLine {
  feeType: FeeType;
  /** Set once paid or waived; a waiver is a settled line. */
  paidAt: string | null;
  amountCents: number | null;
  /** A receipt is waiting for an exec on this line. */
  pending: boolean;
  /** club_fees.payment_reminded_at; null for a dues line with no row yet. */
  remindedAt?: string | null;
}

export interface FeePayer {
  isExec: boolean;
  feeExempt: boolean;
}

/**
 * The lines a member can pay by e-transfer: unsettled, and not a
 * reinstatement (those are settled with an exec, never by a receipt). Execs
 * and fee-exempt members are charged none of the rest, so they get nothing.
 */
export function payableLines(lines: readonly PayableFeeLine[], payer: FeePayer): PayableFeeLine[] {
  if (payer.isExec || payer.feeExempt) return [];
  return lines.filter((l) => l.paidAt == null && l.feeType !== 'reinstatement');
}

export type PaymentPrompt =
  | { kind: 'none' }
  /** Lines with no receipt in yet. The total is a floor when unknownCount > 0. */
  | { kind: 'owing'; totalCents: number; unknownCount: number; count: number }
  /** Everything payable has a receipt waiting for an exec. */
  | { kind: 'submitted' };

/** What the banner says. */
export function paymentPrompt(lines: readonly PayableFeeLine[], payer: FeePayer): PaymentPrompt {
  const payable = payableLines(lines, payer);
  const awaiting = payable.filter((l) => !l.pending);
  if (awaiting.length > 0) {
    return {
      kind: 'owing',
      totalCents: awaiting.reduce((sum, l) => sum + (l.amountCents ?? 0), 0),
      unknownCount: awaiting.filter((l) => l.amountCents == null).length,
      count: awaiting.length,
    };
  }
  return payable.length > 0 ? { kind: 'submitted' } : { kind: 'none' };
}

export type ReminderDecision =
  | { remind: true }
  | { remind: false; reason: 'nothing_owed' | 'submitted' | 'cooldown' };

/**
 * Whether the console's Remind reaches this member now. Not when nothing is
 * owed, not when every owed line already has a receipt waiting, and not when
 * any of their lines was reminded inside the cooldown.
 */
export function reminderDecision(
  lines: readonly PayableFeeLine[],
  payer: FeePayer,
  now: Date,
): ReminderDecision {
  const payable = payableLines(lines, payer);
  if (payable.length === 0) return { remind: false, reason: 'nothing_owed' };
  if (payable.every((l) => l.pending)) return { remind: false, reason: 'submitted' };
  const last = lastRemindedAt(payable);
  if (last !== null && now.getTime() - last.getTime() < PAYMENT_REMINDER_COOLDOWN_MS) {
    return { remind: false, reason: 'cooldown' };
  }
  return { remind: true };
}

/** The most recent reminder across a member's lines, or null. */
export function lastRemindedAt(lines: readonly PayableFeeLine[]): Date | null {
  let latest: number | null = null;
  for (const l of lines) {
    if (!l.remindedAt) continue;
    const t = new Date(l.remindedAt).getTime();
    if (Number.isNaN(t)) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest === null ? null : new Date(latest);
}

export type SeasonDuesState = 'paid' | 'waived' | 'exempt' | 'unpaid';

/**
 * A member's dues for the active season, for the console's door check. Only
 * 'paid' is ever shown publicly (see showsPublicPaidBadge); the other three are
 * for execs holding the markpaid capability.
 */
export function seasonDuesState(
  row: { paid_at?: string | null; method?: string | null } | null | undefined,
  payer: FeePayer,
): SeasonDuesState {
  if (payer.isExec || payer.feeExempt) return 'exempt';
  if (!row?.paid_at) return 'unpaid';
  return isReservedMethod(row.method) ? 'waived' : 'paid';
}

/** Public profiles show Paid and nothing else: unpaid members are not named. */
export function showsPublicPaidBadge(state: SeasonDuesState): boolean {
  return state === 'paid';
}
