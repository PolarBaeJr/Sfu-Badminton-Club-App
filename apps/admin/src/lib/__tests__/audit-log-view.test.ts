import { describe, it, expect } from 'vitest';
import {
  abbreviateActor,
  actionLabel,
  actionTone,
  buildTabs,
  groupOf,
  matchesQuery,
  relativeWhen,
  resolveTab,
  shortRef,
  sortLogs,
  visibleLogs,
  type AuditLogEntry,
} from '../audit-log-view';

// The screen's job is to lose nothing. Most of what follows is a test that some
// piece of presentation does NOT drop a row, and the rest is the unknown-type
// case — `action_type` is free text, so "a value this file has never seen" is a
// permanent, expected input rather than an error case.

let seq = 0;
function entry(over: Partial<AuditLogEntry> = {}): AuditLogEntry {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    created_at: '2026-08-10T12:00:00.000Z',
    action_type: 'player_updated',
    target_type: 'player',
    target_id: 'aaaaaaaa-0000-0000-0000-000000000000',
    reason: null,
    actor: { full_name: 'Aiko Tanaka' },
    ...over,
  };
}

// Types nothing in the codebase produces. If any of these ever start matching a
// rule the assertions below break loudly, which is the intent.
const UNKNOWN = ['sponsorship_signed', 'kit_order_placed', 'zzz', 'X'];

describe('actionTone', () => {
  it('reads the verb, not the noun', () => {
    expect(actionTone('player_banned')).toBe('danger');
    expect(actionTone('match_voided')).toBe('danger');
    expect(actionTone('walkover_rejected')).toBe('danger');
    expect(actionTone('auto_suspend')).toBe('danger');
    expect(actionTone('passkey_counter_anomaly')).toBe('danger');

    expect(actionTone('player_approved')).toBe('success');
    expect(actionTone('player_reinstated')).toBe('success');
    expect(actionTone('walkover_confirmed')).toBe('success');
    expect(actionTone('expense_reimbursed')).toBe('success');

    expect(actionTone('player_updated')).toBe('warning');
    expect(actionTone('player_permissions_changed')).toBe('warning');
    expect(actionTone('season_ended')).toBe('warning');
    expect(actionTone('players_merged')).toBe('warning');
    expect(actionTone('session_archived')).toBe('warning');
  });

  it('does not let a shared word decide between opposites', () => {
    expect(actionTone('fee_marked_paid')).toBe('success');
    expect(actionTone('fee_marked_unpaid')).toBe('warning');
    // Cancelling a pending account deletion is the safe outcome, not a danger.
    expect(actionTone('account_deletion_cancelled')).toBe('neutral');
  });

  it('gives an unknown type a neutral treatment rather than none', () => {
    for (const action of UNKNOWN) expect(actionTone(action)).toBe('neutral');
    // Recognised but uneventful lands in the same place, and that is fine.
    expect(actionTone('fee_waived')).toBe('neutral');
  });

  it('never throws on a degenerate value', () => {
    expect(actionTone('')).toBe('neutral');
    expect(actionTone('___')).toBe('neutral');
  });
});

describe('actionLabel', () => {
  it('humanises without abridging', () => {
    expect(actionLabel('fee_waived')).toBe('FEE WAIVED');
    expect(actionLabel('legal_document_reacceptance_required'))
      .toBe('LEGAL DOCUMENT REACCEPTANCE REQUIRED');
    // An unknown type is still printed in full — the raw value is the only
    // description of it that exists.
    expect(actionLabel('sponsorship_signed')).toBe('SPONSORSHIP SIGNED');
  });
});

describe('groupOf', () => {
  it('files the real action types where an officer would look', () => {
    expect(groupOf('player_banned')).toBe('members');
    expect(groupOf('players_merged')).toBe('members');
    expect(groupOf('passkey_login')).toBe('members');
    expect(groupOf('auto_suspend')).toBe('members');
    expect(groupOf('player_permissions_changed')).toBe('members');

    expect(groupOf('match_voided')).toBe('matches');
    expect(groupOf('challenge_force_expired')).toBe('matches');
    expect(groupOf('dispute_resolved')).toBe('matches');

    expect(groupOf('session_attendance_marked')).toBe('sessions');
    expect(groupOf('tournament_participant_added')).toBe('tournaments');
    expect(groupOf('season_created')).toBe('club');
    expect(groupOf('legal_document_updated')).toBe('club');
    expect(groupOf('event_waiver_template_updated')).toBe('club');
  });

  it('files money by its money-ness, above the section it happened in', () => {
    expect(groupOf('tournament_fee_tier_created')).toBe('money');
    expect(groupOf('tournament_fee_marked_paid')).toBe('money');
    expect(groupOf('season_fees_updated')).toBe('money');
    expect(groupOf('reinstatement_payment_recorded')).toBe('money');
    expect(groupOf('other_income_added')).toBe('money');
    expect(groupOf('manual_fee_added')).toBe('money');
    expect(groupOf('expense_removed')).toBe('money');
  });

  it('does not confuse a suspended tournament with a suspended member', () => {
    expect(groupOf('tournament_suspended')).toBe('tournaments');
    expect(groupOf('auto_suspend')).toBe('members');
  });

  it('puts an unknown type in other rather than dropping it', () => {
    for (const action of UNKNOWN) expect(groupOf(action)).toBe('other');
    expect(groupOf('')).toBe('other');
  });
});

describe('buildTabs', () => {
  const logs = [
    entry({ action_type: 'player_banned' }),
    entry({ action_type: 'player_approved' }),
    entry({ action_type: 'match_voided' }),
    entry({ action_type: 'fee_waived' }),
    entry({ action_type: 'sponsorship_signed' }),
  ];

  it('offers only the groups the data contains', () => {
    expect(buildTabs(logs).map((t) => t.id))
      .toEqual(['all', 'members', 'matches', 'money', 'other']);
  });

  it('counts from the data', () => {
    const byId = Object.fromEntries(buildTabs(logs).map((t) => [t.id, t.count]));
    expect(byId).toEqual({ all: 5, members: 2, matches: 1, money: 1, other: 1 });
  });

  it('accounts for every row: the groups sum to All', () => {
    const tabs = buildTabs(logs);
    const all = tabs.find((t) => t.id === 'all')!.count;
    const rest = tabs.filter((t) => t.id !== 'all').reduce((n, t) => n + t.count, 0);
    expect(rest).toBe(all);
    expect(all).toBe(logs.length);
  });

  it('gives an unknown type its own visible home', () => {
    const tabs = buildTabs([entry({ action_type: 'kit_order_placed' })]);
    expect(tabs).toEqual([
      { id: 'all', label: 'All', count: 1 },
      { id: 'other', label: 'Other', count: 1 },
    ]);
  });

  it('is just All when there is nothing', () => {
    expect(buildTabs([])).toEqual([{ id: 'all', label: 'All', count: 0 }]);
  });
});

describe('resolveTab', () => {
  const tabs = buildTabs([entry({ action_type: 'player_banned' })]);

  it('keeps a selection that is on screen', () => {
    expect(resolveTab(tabs, 'members')).toBe('members');
  });

  it('falls back to All when the selected tab has gone', () => {
    // The season changed underneath the selection and there is no money in the
    // new one: without this the table is empty and no tab is lit.
    expect(resolveTab(tabs, 'money')).toBe('all');
    expect(resolveTab([{ id: 'all', label: 'All', count: 0 }], 'members')).toBe('all');
  });
});

describe('matchesQuery', () => {
  const log = entry({
    action_type: 'fee_waived',
    reason: 'Hardship request approved by the treasurer',
    actor: { full_name: 'Aiko Tanaka' },
    target_type: 'club_fee',
  });

  it('matches an empty query', () => {
    expect(matchesQuery(log, '')).toBe(true);
    expect(matchesQuery(log, '   ')).toBe(true);
  });

  it('matches the action in either spelling', () => {
    expect(matchesQuery(log, 'fee_waived')).toBe(true);
    expect(matchesQuery(log, 'fee waived')).toBe(true);
    expect(matchesQuery(log, 'WAIVED')).toBe(true);
  });

  it('searches the reason, which is what the log is read for', () => {
    expect(matchesQuery(log, 'hardship')).toBe(true);
    expect(matchesQuery(log, 'treasurer')).toBe(true);
  });

  it('narrows on each additional word', () => {
    expect(matchesQuery(log, 'aiko hardship')).toBe(true);
    expect(matchesQuery(log, 'aiko banned')).toBe(false);
  });

  it('finds a row with a null actor by the word shown for it', () => {
    expect(matchesQuery(entry({ actor: null }), 'system')).toBe(true);
  });

  it('finds a row by its reference', () => {
    expect(matchesQuery(log, shortRef(log.id))).toBe(true);
  });

  it('finds a row by the person it is about', () => {
    const banned = entry({
      action_type: 'player_banned',
      actor: { full_name: 'Aiko Tanaka' },
      subject: { full_name: 'Ravi Menon', avatar_url: null },
      reason: 'Three no-shows in a term',
    });
    expect(matchesQuery(banned, 'ravi')).toBe(true);
    expect(matchesQuery(banned, 'menon banned')).toBe(true);
    // The officer and the subject are different people and stay distinguishable.
    expect(matchesQuery(banned, 'aiko')).toBe(true);
    expect(matchesQuery(banned, 'ravi tanaka menon')).toBe(true);
  });

  it('does not require a subject to have been resolved', () => {
    // A player merged away leaves entries whose subject cannot be named. They
    // are still searchable by everything else on the row.
    const orphan = entry({ subject: null, reason: 'Corrected a mis-keyed score' });
    expect(matchesQuery(orphan, 'mis-keyed')).toBe(true);
    expect(matchesQuery(orphan, '')).toBe(true);
  });
});

describe('sortLogs', () => {
  const a = entry({ id: 'aaa', created_at: '2026-08-01T10:00:00.000Z' });
  const b = entry({ id: 'bbb', created_at: '2026-08-03T10:00:00.000Z' });
  const c = entry({ id: 'ccc', created_at: '2026-08-02T10:00:00.000Z' });

  it('orders newest and oldest first', () => {
    expect(sortLogs([a, b, c], 'newest').map((l) => l.id)).toEqual(['bbb', 'ccc', 'aaa']);
    expect(sortLogs([a, b, c], 'oldest').map((l) => l.id)).toEqual(['aaa', 'ccc', 'bbb']);
  });

  it('does not drop or duplicate rows', () => {
    expect(sortLogs([a, b, c], 'newest')).toHaveLength(3);
    expect(sortLogs([], 'newest')).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [a, b, c];
    sortLogs(input, 'oldest');
    expect(input.map((l) => l.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('breaks an exact tie deterministically', () => {
    const t = '2026-08-05T09:00:00.000Z';
    const x = entry({ id: 'xxx', created_at: t });
    const y = entry({ id: 'yyy', created_at: t });
    expect(sortLogs([y, x], 'oldest').map((l) => l.id)).toEqual(['xxx', 'yyy']);
    expect(sortLogs([x, y], 'oldest').map((l) => l.id)).toEqual(['xxx', 'yyy']);
    expect(sortLogs([x, y], 'newest').map((l) => l.id)).toEqual(['yyy', 'xxx']);
  });

  it('compares instants, not strings, across offsets', () => {
    // Same moment, two spellings. A lexicographic sort puts these the wrong way.
    const utc = entry({ id: 'utc', created_at: '2026-08-05T00:30:00.000Z' });
    const off = entry({ id: 'off', created_at: '2026-08-04T18:00:00.000-07:00' }); // 01:00Z
    expect(sortLogs([utc, off], 'oldest').map((l) => l.id)).toEqual(['utc', 'off']);
  });
});

describe('visibleLogs', () => {
  const logs = [
    entry({ id: 'p1', action_type: 'player_banned', created_at: '2026-08-01T10:00:00.000Z', reason: 'Repeated no-shows' }),
    entry({ id: 'm1', action_type: 'match_voided', created_at: '2026-08-02T10:00:00.000Z', reason: 'Wrong scores entered' }),
    entry({ id: 'u1', action_type: 'kit_order_placed', created_at: '2026-08-03T10:00:00.000Z', reason: null }),
  ];

  it('keeps an unknown type in the All view', () => {
    const ids = visibleLogs(logs, { tab: 'all', query: '', order: 'newest' }).map((l) => l.id);
    expect(ids).toEqual(['u1', 'm1', 'p1']);
  });

  it('reaches an unknown type through its own tab', () => {
    expect(visibleLogs(logs, { tab: 'other', query: '', order: 'newest' }).map((l) => l.id))
      .toEqual(['u1']);
  });

  it('composes tab, search and order', () => {
    expect(visibleLogs(logs, { tab: 'matches', query: 'scores', order: 'newest' }).map((l) => l.id))
      .toEqual(['m1']);
    expect(visibleLogs(logs, { tab: 'members', query: 'scores', order: 'newest' })).toEqual([]);
  });
});

describe('abbreviateActor', () => {
  it('abbreviates the given name only', () => {
    expect(abbreviateActor('Aiko Tanaka')).toBe('A. Tanaka');
    expect(abbreviateActor('Ana de Silva')).toBe('A. de Silva');
  });

  it('leaves a single name alone', () => {
    expect(abbreviateActor('Prince')).toBe('Prince');
  });

  it('names the absence of an actor', () => {
    expect(abbreviateActor(null)).toBe('System');
    expect(abbreviateActor(undefined)).toBe('System');
    expect(abbreviateActor('   ')).toBe('System');
  });

  it('tolerates untidy whitespace', () => {
    expect(abbreviateActor('  Aiko   Tanaka  ')).toBe('A. Tanaka');
  });
});

describe('relativeWhen', () => {
  // Local time throughout: the helper counts local midnights and the reader is
  // in the same timezone as their laptop.
  const now = new Date(2026, 7, 10, 14, 0, 0); // 10 Aug 2026, 14:00 local

  it('keeps the clock time for today and yesterday', () => {
    expect(relativeWhen(new Date(2026, 7, 10, 19, 4).toISOString(), now)).toBe('Today 19:04');
    expect(relativeWhen(new Date(2026, 7, 10, 0, 5).toISOString(), now)).toBe('Today 00:05');
    expect(relativeWhen(new Date(2026, 7, 9, 21, 12).toISOString(), now)).toBe('Yesterday 21:12');
  });

  it('counts midnights, not elapsed hours', () => {
    // Ten minutes apart, across midnight — still two different days.
    const late = new Date(2026, 7, 9, 23, 50).toISOString();
    const early = new Date(2026, 7, 10, 0, 10).toISOString();
    expect(relativeWhen(late, now)).toBe('Yesterday 23:50');
    expect(relativeWhen(early, now)).toBe('Today 00:10');
  });

  it('is relative for the rest of the week', () => {
    expect(relativeWhen(new Date(2026, 7, 8, 11, 0).toISOString(), now)).toBe('2 days ago');
    expect(relativeWhen(new Date(2026, 7, 4, 11, 0).toISOString(), now)).toBe('6 days ago');
  });

  it('turns absolute once "N days ago" stops being convertible', () => {
    expect(relativeWhen(new Date(2026, 7, 3, 11, 0).toISOString(), now)).toBe('3 Aug 2026');
    expect(relativeWhen(new Date(2025, 10, 21, 11, 0).toISOString(), now)).toBe('21 Nov 2025');
  });

  it('does not claim the future is old', () => {
    expect(relativeWhen(new Date(2026, 7, 10, 23, 30).toISOString(), now)).toBe('Today 23:30');
  });

  it('shows an unparseable timestamp verbatim instead of hiding the row', () => {
    expect(relativeWhen('not-a-date', now)).toBe('not-a-date');
  });
});

describe('shortRef', () => {
  it('takes the first uuid segment', () => {
    expect(shortRef('4b1c2d3e-1111-2222-3333-444444444444')).toBe('4b1c2d3e');
  });

  it('degrades rather than throwing', () => {
    expect(shortRef('')).toBe('—');
  });
});
