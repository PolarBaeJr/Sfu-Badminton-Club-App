import { describe, expect, it } from 'vitest';
import { summariseFees } from '@badminton/shared/src/utils/fee-statement';
import { buildStatementLines, statementHeadline, type OwnFeeRow, type StatementSeason } from '../lib/statement';

const season: StatementSeason = {
  id: 's1',
  name: 'Fall 2026',
  end_date: '2026-12-10',
  competitive_fee_cents: 6000,
  recreational_fee_cents: 4000,
};

const fee = (over: Partial<OwnFeeRow>): OwnFeeRow => ({
  id: 'f',
  fee_type: 'dues',
  season_id: null,
  tournament_id: null,
  club_event_id: null,
  amount_cents: null,
  paid_at: null,
  method: null,
  reference: null,
  created_at: '2026-09-01T00:00:00Z',
  ...over,
});

const member = { status: 'competitive', is_exec: false, fee_exempt: false };
const none = new Map<string, string>();

function statement(player: typeof member, rows: OwnFeeRow[], names = none) {
  const { lines, seasonLine } = buildStatementLines({
    player,
    season,
    feeRows: rows,
    tournamentNames: names,
    eventNames: none,
  });
  const exempt = Boolean(player.is_exec || player.fee_exempt);
  return { lines, seasonLine, summary: summariseFees(lines, { exempt }) };
}

describe('buildStatementLines', () => {
  it('a member with no dues row owes the season price for their status', () => {
    const { seasonLine, summary } = statement(member, []);
    expect(seasonLine?.key).toBe('season-s1');
    expect(seasonLine?.owedCents).toBe(6000);
    expect(summary.status).toBe('owing');
    expect(statementHeadline(summary)).toEqual({ amount: '$60.00', label: 'UNPAID' });
  });

  it('a recreational member owes the recreational price', () => {
    const { summary } = statement({ ...member, status: 'recreational' }, []);
    expect(summary.totalCents).toBe(4000);
  });

  it('an exempt member gets no dues line and is not charged', () => {
    const { seasonLine, summary } = statement({ ...member, fee_exempt: true }, []);
    expect(seasonLine).toBeNull();
    expect(summary.status).toBe('exempt');
    expect(statementHeadline(summary)).toEqual({ amount: '$0.00', label: 'NOT CHARGED' });
  });

  it('an exec still owes a reinstatement: it is not a due', () => {
    const rows = [fee({ id: 'r', fee_type: 'reinstatement', amount_cents: 2500 })];
    const { summary } = statement({ ...member, is_exec: true }, rows);
    expect(summary.status).toBe('owing');
    expect(summary.totalCents).toBe(2500);
  });

  it('a waived dues row is settled, and its receipt says waived rather than paid', () => {
    const rows = [fee({ id: 'd', season_id: 's1', amount_cents: 0, paid_at: '2026-09-05T18:00:00Z', method: 'Waived' })];
    const { seasonLine, summary } = statement(member, rows);
    expect(seasonLine?.waived).toBe(true);
    expect(seasonLine?.paid).toBe(false);
    expect(summary.status).toBe('all-paid');
    expect(summary.receipts.map((l) => l.key)).toEqual(['d']);
    expect(statementHeadline(summary).label).toBe('ALL PAID');
  });

  it('an entry with no recorded price makes the total unknown, not zero', () => {
    const rows = [
      fee({ id: 'd', season_id: 's1', amount_cents: 6000, paid_at: '2026-09-05T18:00:00Z', method: 'e_transfer' }),
      fee({ id: 't', fee_type: 'tournament', tournament_id: 't1' }),
    ];
    const { lines, summary } = statement(member, rows, new Map([['t1', 'Fall Open']]));
    expect(lines.map((l) => l.name)).toEqual(['Fall 2026 membership', 'Fall Open']);
    expect(summary.unknownCount).toBe(1);
    expect(statementHeadline(summary).amount).toBe('TBD');
  });

  it('a tournament the member can no longer read keeps its fee under a generic name', () => {
    const rows = [fee({ id: 't', fee_type: 'tournament', tournament_id: 'gone', amount_cents: 1500 })];
    const { lines } = statement({ ...member, fee_exempt: true }, rows);
    expect(lines.map((l) => l.name)).toEqual(['Tournament entry']);
  });

  it('no season and no rows is nothing due', () => {
    const { lines } = buildStatementLines({
      player: member,
      season: null,
      feeRows: [],
      tournamentNames: none,
      eventNames: none,
    });
    expect(lines).toEqual([]);
    expect(statementHeadline(summariseFees(lines, { exempt: false }))).toEqual({ amount: '$0.00', label: 'NOTHING DUE' });
  });
});
