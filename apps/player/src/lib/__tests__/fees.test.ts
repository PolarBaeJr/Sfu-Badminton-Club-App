import { describe, expect, it } from 'vitest';
import {
  formatDayMonth,
  formatPaidDay,
  headlineAmount,
  headlineBadge,
  money,
  outstandingFooter,
  receiptMeta,
  seasonDateline,
  settlementOf,
  summariseFees,
  type FeeLine,
} from '@/lib/fees';

function line(over: Partial<FeeLine> = {}): FeeLine {
  return {
    key: 'k',
    kind: 'season',
    name: 'Term membership',
    owedCents: 4000,
    paid: false,
    waived: false,
    paidAt: null,
    method: null,
    reference: null,
    ...over,
  };
}

describe('money', () => {
  it('says TBD rather than $0.00 when no price is recorded', () => {
    expect(money(null)).toBe('TBD');
    expect(money(undefined)).toBe('TBD');
    expect(money(0)).toBe('$0.00');
    expect(money(4000)).toBe('$40.00');
  });
});

describe('settlementOf', () => {
  it('treats an unpaid row as neither paid nor waived', () => {
    expect(settlementOf({ paid_at: null, method: null })).toEqual({ paid: false, waived: false });
  });

  it('treats a paid row with no method as paid', () => {
    expect(settlementOf({ paid_at: '2026-01-08T20:00:00Z', method: null })).toEqual({
      paid: true,
      waived: false,
    });
  });

  it('reads the reserved method as waived, not paid', () => {
    expect(settlementOf({ paid_at: '2026-01-08T20:00:00Z', method: 'waived' })).toEqual({
      paid: false,
      waived: true,
    });
  });

  it('matches the reserved method case-insensitively', () => {
    // A custom method typed as "Waived" is the same intent, and payment-methods.ts
    // reserves the word precisely so it cannot be smuggled past as free text.
    expect(settlementOf({ paid_at: '2026-01-08T20:00:00Z', method: ' Waived ' }).waived).toBe(true);
  });

  it('does not call a row waived just because the method says so with no paid_at', () => {
    expect(settlementOf({ paid_at: null, method: 'waived' })).toEqual({ paid: false, waived: false });
  });
});

describe('summariseFees', () => {
  it('a brand-new member owes the season fee and has no receipts', () => {
    const s = summariseFees([line()], { exempt: false });
    expect(s.status).toBe('owing');
    expect(s.totalCents).toBe(4000);
    expect(s.unknownCount).toBe(0);
    expect(s.receipts).toEqual([]);
    expect(headlineAmount(s)).toBe('$40.00');
    expect(headlineBadge(s)).toEqual({ tone: 'warning', label: 'UNPAID' });
  });

  it('is all-paid only when something was actually billed and settled', () => {
    const s = summariseFees([line({ paid: true, paidAt: '2026-01-08T20:00:00Z' })], {
      exempt: false,
    });
    expect(s.status).toBe('all-paid');
    expect(headlineBadge(s).tone).toBe('success');
    expect(s.receipts).toHaveLength(1);
  });

  it('a waived fee settles the line without being called paid', () => {
    const s = summariseFees(
      [line({ waived: true, owedCents: 0, paidAt: '2026-01-08T20:00:00Z', method: 'waived' })],
      { exempt: false },
    );
    expect(s.status).toBe('all-paid');
    expect(s.outstanding).toEqual([]);
    expect(s.receipts).toHaveLength(1);
  });

  it('distinguishes never-billed from paid-in-full', () => {
    // Zero owed is three different things. The badge is the only place a member
    // can tell them apart, so it must not collapse them.
    expect(headlineBadge(summariseFees([], { exempt: false })).label).toBe('NOTHING DUE');
    expect(headlineBadge(summariseFees([line()], { exempt: true })).label).toBe('NOT CHARGED');
    expect(
      headlineBadge(summariseFees([line({ paid: true, paidAt: '2026-01-08T20:00:00Z' })], { exempt: false }))
        .label,
    ).toBe('ALL PAID');
  });

  it('keeps an exempt member’s earlier receipts', () => {
    // Being made an exec does not delete the term you paid for as a member.
    const s = summariseFees(
      [line({ paid: true, paidAt: '2026-01-08T20:00:00Z' }), line({ key: 'b' })],
      { exempt: true },
    );
    expect(s.status).toBe('exempt');
    expect(s.totalCents).toBe(0);
    expect(s.outstanding).toEqual([]);
    expect(s.receipts).toHaveLength(1);
  });

  it('counts a priceless outstanding line instead of summing it as zero', () => {
    // The failure this guards: a tournament with no fee row, no tier_id and no
    // default tier has no price anywhere. Adding it as 0 would print a total
    // that silently omits a real debt.
    const s = summariseFees([line({ owedCents: 4000 }), line({ key: 'b', kind: 'tournament', owedCents: null })], {
      exempt: false,
    });
    expect(s.totalCents).toBe(4000);
    expect(s.unknownCount).toBe(1);
    expect(headlineAmount(s)).toBe('$40.00');
  });

  it('shows TBD when the only thing outstanding has no recorded price', () => {
    const s = summariseFees([line({ kind: 'tournament', owedCents: null })], { exempt: false });
    expect(s.totalCents).toBe(0);
    expect(s.unknownCount).toBe(1);
    expect(headlineAmount(s)).toBe('TBD');
  });

  it('orders receipts newest payment first', () => {
    const s = summariseFees(
      [
        line({ key: 'old', paid: true, paidAt: '2026-01-08T20:00:00Z' }),
        line({ key: 'new', paid: true, paidAt: '2026-03-02T20:00:00Z' }),
      ],
      { exempt: false },
    );
    expect(s.receipts.map((r) => r.key)).toEqual(['new', 'old']);
  });
});

describe('dates', () => {
  it('reads a DATE column in UTC so the day does not slip backwards', () => {
    // new Date('2026-01-06') is UTC midnight; formatted in America/Vancouver
    // that is 5 January. This is the bug shared's formatDate() has.
    expect(formatDayMonth('2026-01-06')).toBe('6 JAN');
    expect(formatDayMonth('2026-05-04')).toBe('4 MAY');
  });

  it('reads a TIMESTAMPTZ in the club timezone', () => {
    // 2026-01-09T02:00:00Z is 8 January, 6pm in Vancouver.
    expect(formatPaidDay('2026-01-09T02:00:00Z')).toBe('8 JAN');
  });

  it('returns null rather than "Invalid Date" for missing or broken input', () => {
    expect(formatDayMonth(null)).toBeNull();
    expect(formatDayMonth('not-a-date')).toBeNull();
    expect(formatPaidDay(undefined)).toBeNull();
    expect(formatPaidDay('nonsense')).toBeNull();
  });

  it('handles a season with no end date', () => {
    expect(seasonDateline('2026-01-06', '2026-05-04')).toBe('6 JAN – 4 MAY');
    expect(seasonDateline('2026-01-06', null)).toBe('FROM 6 JAN');
    expect(seasonDateline(null, '2026-05-04')).toBeNull();
  });
});

describe('receiptMeta', () => {
  it('drops the segments a row has no value for', () => {
    expect(receiptMeta(line({ paid: true, paidAt: '2026-01-09T02:00:00Z' }))).toEqual({
      text: '8 JAN',
      reference: null,
    });
  });

  it('spells the method out and hands the reference back separately', () => {
    // The reference is returned rather than joined so the page can wrap it in
    // <Atomic> — a transaction id must not break across lines.
    expect(
      receiptMeta(
        line({ paid: true, paidAt: '2026-01-09T02:00:00Z', method: 'e_transfer', reference: 'RC-2261' }),
      ),
    ).toEqual({ text: '8 JAN · E-TRANSFER', reference: 'RC-2261' });
  });

  it('says WAIVED instead of naming the reserved method as a payment method', () => {
    expect(
      receiptMeta(line({ waived: true, paidAt: '2026-01-09T02:00:00Z', method: 'waived' })).text,
    ).toBe('8 JAN · WAIVED');
  });

  it('treats a whitespace-only reference as absent', () => {
    expect(receiptMeta(line({ paid: true, paidAt: '2026-01-09T02:00:00Z', reference: '   ' })).reference)
      .toBeNull();
  });
});

describe('outstandingFooter', () => {
  it('states the season end date as an end date, never as a deadline', () => {
    expect(outstandingFooter(line({ paid: true, paidAt: '2026-01-09T02:00:00Z' }), '2026-05-04')).toBe(
      'TERM FEE PAID 8 JAN · SEASON ENDS 4 MAY',
    );
  });

  it('says the term fee is unrecorded rather than implying it was paid', () => {
    expect(outstandingFooter(line(), '2026-05-04')).toBe(
      'TERM FEE NOT YET RECORDED · SEASON ENDS 4 MAY',
    );
  });

  it('names a waiver as a waiver', () => {
    expect(outstandingFooter(line({ waived: true, paidAt: '2026-01-09T02:00:00Z' }), null)).toBe(
      'TERM FEE WAIVED',
    );
  });

  it('has nothing to say with no season fee and no end date', () => {
    expect(outstandingFooter(null, null)).toBeNull();
  });
});
