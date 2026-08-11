import { describe, it, expect } from 'vitest';
import {
  parseChallengeRules,
  FALLBACK_CHALLENGE_RULES,
  expiryState,
  challengeQuota,
  ACTIVE_CHALLENGE_STATUSES,
  partitionChallenges,
  challengeSearchKeys,
} from '../challenge-rules';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

describe('parseChallengeRules', () => {
  it('reads the four rules out of a settings blob', () => {
    expect(
      parseChallengeRules({
        elo_range: 150,
        ladder_range: 3,
        max_active_challenges: 5,
        challenge_expiry_hours: 48,
      }),
    ).toEqual({ eloRange: 150, ladderRange: 3, maxActive: 5, expiryHours: 48 });
  });

  it('accepts the JSON-as-string numbers the settings form writes', () => {
    const rules = parseChallengeRules({ max_active_challenges: '5', challenge_expiry_hours: ' 24 ' });
    expect(rules.maxActive).toBe(5);
    expect(rules.expiryHours).toBe(24);
  });

  // The whole point of the defensive contract in platform_setting_int(): a bad
  // value must fall back, never resolve to 0. A max of 0 would lock every
  // member out of a feature the database would have allowed.
  it.each([null, undefined, {}, 'nonsense', { max_active_challenges: '' }, { max_active_challenges: 'x' }])(
    'falls back rather than resolving to zero for %p',
    (value) => {
      expect(parseChallengeRules(value).maxActive).toBe(FALLBACK_CHALLENGE_RULES.maxActive);
    },
  );

  it('matches the defaults the SQL itself falls back to', () => {
    expect(parseChallengeRules(null)).toEqual(FALLBACK_CHALLENGE_RULES);
    expect(FALLBACK_CHALLENGE_RULES).toEqual({
      maxActive: 3,
      expiryHours: 72,
      eloRange: 9999,
      ladderRange: 50,
    });
  });
});

describe('expiryState', () => {
  it('says nothing about a status that can no longer expire', () => {
    for (const status of ['accepted', 'completed', 'rejected', 'cancelled', 'walkover_confirmed']) {
      expect(expiryState(at(5), status, NOW)).toEqual({ kind: 'none', hoursLeft: null, label: null });
    }
  });

  it('says nothing when the row carries no deadline', () => {
    expect(expiryState(null, 'proposed', NOW).kind).toBe('none');
    expect(expiryState('not a date', 'proposed', NOW).kind).toBe('none');
  });

  it('counts down in days, then hours, then minutes', () => {
    expect(expiryState(at(70), 'proposed', NOW).label).toBe('2d left');
    expect(expiryState(at(30), 'proposed', NOW).label).toBe('30h left');
    expect(expiryState(at(0.5), 'proposed', NOW).label).toBe('30m left');
  });

  it('turns urgent inside twelve hours and not before', () => {
    expect(expiryState(at(12), 'proposed', NOW).kind).toBe('open');
    expect(expiryState(at(11.9), 'proposed', NOW).kind).toBe('urgent');
  });

  // Truncated, not rounded: with 90 minutes left "1h" is a promise the clock can
  // keep and "2h" is not.
  it('never rounds the remaining time up', () => {
    expect(expiryState(at(1.9), 'proposed', NOW).label).toBe('1h left');
  });

  it('reports a lapsed deadline as expired', () => {
    expect(expiryState(at(-1), 'proposed', NOW)).toMatchObject({ kind: 'expired', label: 'Expired' });
    expect(expiryState(at(0), 'proposed', NOW).kind).toBe('expired');
  });

  it('covers partially_confirmed, which is still awaiting an answer', () => {
    expect(expiryState(at(3), 'partially_confirmed', NOW).kind).toBe('urgent');
  });
});

describe('ACTIVE_CHALLENGE_STATUSES', () => {
  // The list validate_challenge_creation counts. It is exported precisely so
  // the counting query and the meter share one definition; pinning it here is
  // what makes a silent edit to either side fail loudly.
  it('is exactly the set the SQL cap counts', () => {
    expect([...ACTIVE_CHALLENGE_STATUSES]).toEqual(['proposed', 'partially_confirmed', 'accepted']);
  });

  it('excludes every status that is already resolved', () => {
    for (const done of ['completed', 'walkover_confirmed', 'rejected', 'cancelled', 'expired']) {
      expect(ACTIVE_CHALLENGE_STATUSES).not.toContain(done);
    }
  });
});

describe('challengeQuota', () => {
  it('reports what is used against the club’s cap', () => {
    expect(challengeQuota(2, 3)).toEqual({ used: 2, max: 3, full: false, ratio: 2 / 3 });
  });

  it('is full at the cap, not one past it', () => {
    expect(challengeQuota(3, 3).full).toBe(true);
    expect(challengeQuota(2, 3).full).toBe(false);
  });

  it('stays drawable when a settings row says zero or the count overshoots', () => {
    expect(challengeQuota(2, 0)).toMatchObject({ full: true, ratio: 1 });
    expect(challengeQuota(5, 3).ratio).toBe(1);
  });

  // A failed count query hands back null; the caller coalesces to 0, but a
  // negative could only come from a bug and must not produce a backwards bar.
  it('never draws a negative bar', () => {
    expect(challengeQuota(0, 3).ratio).toBe(0);
    expect(challengeQuota(-1, 3).ratio).toBe(0);
  });
});

describe('partitionChallenges', () => {
  const row = (id: string, status: string, created_by: string, confirmation_status = 'accepted') => ({
    id,
    challenge: { status, created_by, confirmation_status },
  });
  const keys = (list: { id: string }[]) => list.map((r) => r.id);

  it('pins what the viewer has been asked and has not answered', () => {
    const p = partitionChallenges([row('a', 'proposed', 'them', 'pending')], 'me');
    expect(keys(p.incoming)).toEqual(['a']);
  });

  it('does not pin the viewer’s own challenge, however it was answered', () => {
    const p = partitionChallenges([row('a', 'proposed', 'me', 'pending')], 'me');
    expect(keys(p.incoming)).toEqual([]);
    expect(keys(p.outgoing)).toEqual(['a']);
  });

  // The bug this function was extracted to fix. The hourly sweep writes
  // status='expired'; the old filters listed only completed / walkover /
  // rejected / cancelled as finished, so a lapsed challenge stayed in the live
  // sections asking for an answer that no longer means anything.
  it('files a swept-expired challenge under archived and nowhere else', () => {
    const p = partitionChallenges(
      [row('mine', 'expired', 'me', 'accepted'), row('theirs', 'expired', 'them', 'pending')],
      'me',
    );
    expect(keys(p.archived).sort()).toEqual(['mine', 'theirs']);
    expect(keys(p.incoming)).toEqual([]);
    expect(keys(p.outgoing)).toEqual([]);
    expect(keys(p.active)).toEqual([]);
  });

  it.each(['completed', 'walkover_confirmed', 'rejected', 'cancelled', 'expired'])(
    'treats %s as finished',
    (status) => {
      const p = partitionChallenges([row('a', status, 'me', 'pending')], 'me');
      expect(keys(p.archived)).toEqual(['a']);
      expect(keys(p.incoming)).toEqual([]);
      expect(keys(p.outgoing)).toEqual([]);
    },
  );

  // Live but unresolved. These must not fall through every bucket and vanish.
  it.each(['disputed', 'walkover_pending'])('keeps %s visible', (status) => {
    const mine = partitionChallenges([row('a', status, 'me')], 'me');
    expect(keys(mine.outgoing)).toEqual(['a']);
    expect(keys(mine.archived)).toEqual([]);
  });

  it('shows an unanswered partially_confirmed challenge as both pinned and active', () => {
    const p = partitionChallenges([row('a', 'partially_confirmed', 'them', 'pending')], 'me');
    expect(keys(p.incoming)).toEqual(['a']);
    expect(keys(p.active)).toEqual(['a']);
  });

  // Every label in the challenge_status enum (00001_schema.sql:50).
  const ALL_STATUSES = [
    'proposed', 'partially_confirmed', 'accepted', 'rejected', 'expired',
    'cancelled', 'completed', 'disputed', 'walkover_pending', 'walkover_confirmed',
  ];
  const TERMINAL = ['rejected', 'expired', 'cancelled', 'completed', 'walkover_confirmed'];

  it('leaves nothing unfiled', () => {
    for (const status of ALL_STATUSES) {
      for (const owner of ['me', 'them']) {
        const p = partitionChallenges([row('a', status, owner, 'pending')], 'me');
        const filed = p.incoming.length + p.active.length + p.outgoing.length + p.archived.length;
        expect(filed, `${status} / created_by=${owner}`).toBeGreaterThan(0);
      }
    }
  });

  // The invariant that keeps "leaves nothing unfiled" honest: archived alone
  // satisfies that count, so without this a finished challenge could also be
  // sitting in a live section and both tests would still pass. Today `active`
  // has no terminal check of its own and is safe only because no terminal
  // status is accepted or partially_confirmed — this is what states that.
  it.each(TERMINAL)('files %s in no live section at all', (status) => {
    for (const owner of ['me', 'them']) {
      const p = partitionChallenges([row('a', status, owner, 'pending')], 'me');
      expect(p.incoming.length + p.active.length + p.outgoing.length, `created_by=${owner}`).toBe(0);
      expect(p.archived).toHaveLength(1);
    }
  });
});

describe('challengeSearchKeys', () => {
  it('indexes a member by their name and by their handle', () => {
    expect(challengeSearchKeys([{ full_name: 'Kiera Watanabe', handle: 'kiera' }]))
      .toEqual(['Kiera Watanabe', 'kiera']);
  });

  // Stored bare so a substring match answers "kiera" and "@kiera" alike.
  it('stores the handle without its @', () => {
    expect(challengeSearchKeys([{ full_name: 'K', handle: 'kiera' }])).toContain('kiera');
    expect(challengeSearchKeys([{ full_name: 'K', handle: 'kiera' }])).not.toContain('@kiera');
  });

  it('still indexes a member who has no handle yet', () => {
    expect(challengeSearchKeys([{ full_name: 'Kiera Watanabe', handle: null }]))
      .toEqual(['Kiera Watanabe']);
  });

  it('drops blanks and missing people rather than indexing empty strings', () => {
    expect(challengeSearchKeys([null, undefined, { full_name: '  ', handle: null }])).toEqual([]);
  });

  it('deduplicates, since the creator is usually also a participant', () => {
    expect(
      challengeSearchKeys([
        { full_name: 'Kiera Watanabe', handle: 'kiera' },
        { full_name: 'Kiera Watanabe', handle: 'kiera' },
      ]),
    ).toEqual(['Kiera Watanabe', 'kiera']);
  });
});
