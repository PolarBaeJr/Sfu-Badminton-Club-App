import { describe, it, expect } from 'vitest';
import {
  PAYMENT_REMINDER_COOLDOWN_MS,
  payableLines,
  paymentPrompt,
  reminderDecision,
  seasonDuesState,
  showsPublicPaidBadge,
  type PayableFeeLine,
} from '../fee-reminders';

const MEMBER = { isExec: false, feeExempt: false };
const NOW = new Date('2026-09-24T12:00:00Z');

const line = (over: Partial<PayableFeeLine> = {}): PayableFeeLine => ({
  feeType: 'dues',
  paidAt: null,
  amountCents: 2000,
  pending: false,
  remindedAt: null,
  ...over,
});

describe('payableLines', () => {
  it('keeps unpaid dues, event and tournament lines', () => {
    const lines = [line(), line({ feeType: 'event', amountCents: 1500 }), line({ feeType: 'tournament' })];
    expect(payableLines(lines, MEMBER)).toHaveLength(3);
  });

  it('drops paid and waived lines', () => {
    expect(payableLines([line({ paidAt: '2026-09-01T00:00:00Z' })], MEMBER)).toEqual([]);
  });

  it('drops reinstatements, which are never paid by receipt', () => {
    expect(payableLines([line({ feeType: 'reinstatement' })], MEMBER)).toEqual([]);
  });

  it('gives execs and fee-exempt members nothing', () => {
    expect(payableLines([line()], { isExec: true, feeExempt: false })).toEqual([]);
    expect(payableLines([line()], { isExec: false, feeExempt: true })).toEqual([]);
  });
});

describe('paymentPrompt', () => {
  it('totals the lines with no receipt in', () => {
    const prompt = paymentPrompt([line(), line({ feeType: 'event', amountCents: 1500 })], MEMBER);
    expect(prompt).toEqual({ kind: 'owing', totalCents: 3500, unknownCount: 0, count: 2 });
  });

  it('leaves a line with a pending receipt out of the total', () => {
    const prompt = paymentPrompt([line({ pending: true }), line({ feeType: 'event', amountCents: 1500 })], MEMBER);
    expect(prompt).toEqual({ kind: 'owing', totalCents: 1500, unknownCount: 0, count: 1 });
  });

  it('says submitted once every payable line has a receipt waiting', () => {
    expect(paymentPrompt([line({ pending: true })], MEMBER)).toEqual({ kind: 'submitted' });
  });

  it('counts a line with no price rather than adding zero silently', () => {
    expect(paymentPrompt([line({ amountCents: null })], MEMBER)).toMatchObject({ kind: 'owing', unknownCount: 1 });
  });

  it('says nothing when all is settled, waived or exempt', () => {
    expect(paymentPrompt([line({ paidAt: '2026-09-01T00:00:00Z' })], MEMBER)).toEqual({ kind: 'none' });
    expect(paymentPrompt([line()], { isExec: true, feeExempt: false })).toEqual({ kind: 'none' });
  });
});

describe('reminderDecision', () => {
  it('reminds a member with an unpaid line', () => {
    expect(reminderDecision([line()], MEMBER, NOW)).toEqual({ remind: true });
  });

  it('skips a member who owes nothing, or whose line is waived', () => {
    expect(reminderDecision([], MEMBER, NOW)).toEqual({ remind: false, reason: 'nothing_owed' });
    expect(reminderDecision([line({ paidAt: '2026-09-01T00:00:00Z' })], MEMBER, NOW)).toEqual({
      remind: false,
      reason: 'nothing_owed',
    });
  });

  it('skips a member whose receipt is waiting', () => {
    expect(reminderDecision([line({ pending: true })], MEMBER, NOW)).toEqual({ remind: false, reason: 'submitted' });
  });

  it('skips execs and fee-exempt members', () => {
    expect(reminderDecision([line()], { isExec: true, feeExempt: false }, NOW)).toEqual({
      remind: false,
      reason: 'nothing_owed',
    });
  });

  it('honours the three-day cooldown, and lets the reminder through at exactly three days', () => {
    const recent = new Date(NOW.getTime() - PAYMENT_REMINDER_COOLDOWN_MS + 60_000).toISOString();
    const due = new Date(NOW.getTime() - PAYMENT_REMINDER_COOLDOWN_MS).toISOString();
    expect(reminderDecision([line({ remindedAt: recent })], MEMBER, NOW)).toEqual({
      remind: false,
      reason: 'cooldown',
    });
    expect(reminderDecision([line({ remindedAt: due })], MEMBER, NOW)).toEqual({ remind: true });
  });

  it('reads the cooldown off any of the member lines', () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const lines = [line(), line({ feeType: 'event', remindedAt: recent })];
    expect(reminderDecision(lines, MEMBER, NOW)).toEqual({ remind: false, reason: 'cooldown' });
  });
});

describe('seasonDuesState and the public badge', () => {
  it('reads paid, waived and unpaid off the row', () => {
    expect(seasonDuesState({ paid_at: '2026-09-01T00:00:00Z', method: 'e_transfer' }, MEMBER)).toBe('paid');
    expect(seasonDuesState({ paid_at: '2026-09-01T00:00:00Z', method: 'Waived' }, MEMBER)).toBe('waived');
    expect(seasonDuesState({ paid_at: null }, MEMBER)).toBe('unpaid');
    expect(seasonDuesState(null, MEMBER)).toBe('unpaid');
  });

  it('calls execs and fee-exempt members exempt, whatever the row says', () => {
    expect(seasonDuesState({ paid_at: '2026-09-01T00:00:00Z' }, { isExec: true, feeExempt: false })).toBe('exempt');
    expect(seasonDuesState(null, { isExec: false, feeExempt: true })).toBe('exempt');
  });

  it('shows Paid publicly and nothing else', () => {
    expect(showsPublicPaidBadge('paid')).toBe(true);
    expect(showsPublicPaidBadge('waived')).toBe(false);
    expect(showsPublicPaidBadge('exempt')).toBe(false);
    expect(showsPublicPaidBadge('unpaid')).toBe(false);
  });
});
