import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE CROSS-EVENT ENTRY CAP, AND WHO IS ALLOWED TO WRITE THE FIELD WITHOUT IT.
 *
 * `tournaments.max_events_per_player` bounds how many of one tournament's
 * events a single member may be entered in. Counting it is a CROSS-EVENT
 * question, so the event's advisory key does not serialise it: two entries into
 * two DIFFERENT events of the same tournament take two different keys and both
 * read the same pre-write count. 00201 closed that by making every counter also
 * take the tournament row `FOR UPDATE` — one row, one queue, regardless of
 * which event each entry is for.
 *
 * That fix is a discipline, not a constraint, and nothing in the schema keeps
 * it. A fourth function that counts the cap without the row lock would reopen
 * the race exactly as it stood before 00201, and would read as correct on
 * review because the advisory lock IS there. This test is the thing that
 * notices.
 *
 * IT IS DELIBERATELY TWO SEPARATE ASSERTIONS, because "takes the tournament
 * lock" is NOT a property of field writers in general:
 *
 *   1. Every function that READS max_events_per_player must take both locks.
 *      3/3 today, no exemptions. This is the invariant with teeth.
 *
 *   2. The set of functions that INSERT an entrant is a closed, classified
 *      list. Most members of it legitimately never read the cap, so asserting
 *      a lock on them would be an assertion with more exemptions than
 *      subjects. A census forces the next writer to be classified instead.
 *
 * Source-level, over the migrations, so it runs in CI with no database — the
 * same reason field-write-fence.test.ts parses application code rather than
 * asking Postgres.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

/**
 * WHO COUNTS THE CAP. Exactly these three, and each is an entry path a member
 * or an exec can drive: self-entry, admin bulk add, and pairing.
 */
const CAP_READERS = new Set(['enter_tournament_event', 'add_participants_under_field_lock', 'pair_tournament_entrants']);

/**
 * WHO WRITES AN ENTRANT ROW, and why each one is or is not a cap counter.
 *
 * The three above are omitted here only in the sense that they appear with
 * `countsCap: true`; the list is the whole set, and the test fails if the
 * migrations grow a member it does not name.
 */
const ENTRANT_WRITERS: Record<string, { countsCap: boolean; why: string }> = {
  enter_tournament_event: {
    countsCap: true,
    why: 'A member entering an event themselves. The original cap subject.',
  },
  add_participants_under_field_lock: {
    countsCap: true,
    why: 'An exec adding entrants in bulk. Same cap, same count, same locks.',
  },
  pair_tournament_entrants: {
    countsCap: true,
    why:
      'Forming a pair. Counts BOTH halves, and discounts the loose participant ' +
      'row in this event because the pair consumes it rather than adding to it.',
  },
  unpair_tournament_pair: {
    countsCap: false,
    why:
      'CAP-NEUTRAL BY ARITHMETIC. It deletes one pair row and inserts the two ' +
      'participant rows that replace it, in the SAME event. The cap counts ' +
      'participants and pairs together, so each member ends on the number they ' +
      'started with. Nothing to serialise.',
  },
  swap_tournament_pair_member: {
    countsCap: false,
    why:
      'CAP-NEUTRAL BY REFUSAL. The incoming player must ALREADY hold a live ' +
      'participant row in this event — the function refuses with "Add them to ' +
      'the waiting list first" otherwise — and that row is deleted as they join ' +
      'the pair. They are counted before and after. The outgoing player leaves, ' +
      'which only ever lowers a count.',
  },
  promote_pool_qualifier: {
    countsCap: false,
    why:
      'EXEMPT ON PURPOSE, and this is the one entry in this list that is a ' +
      'decision rather than arithmetic. Promotion writes a bracket entry for a ' +
      'member who is already entered in the pool event that fed it, and pool and ' +
      'bracket are two rows in tournament_events — so the promoted member ends ' +
      'the tournament counted twice for one competitive path.\n\n' +
      'It is not charged against the cap, and it deliberately does not take the ' +
      'tournament row. The direction of the error is what makes that safe: ' +
      'promotion can only ever push a count UP, so the failure mode is refusing ' +
      'a later legitimate entry, never admitting one past the limit. A member ' +
      'cannot reach it at all — seedBracketFromPool drives it ' +
      '(apps/admin/src/lib/tournament-actions/brackets.ts:699) off a pool the ' +
      'exec has already finished.\n\n' +
      'AND IT CANNOT DOUBLE-CHARGE: the tournament fee is one row per member per ' +
      'tournament, enforced by the partial unique index ' +
      'club_fees_tournament_player_key on (tournament_id, player_id), not one row ' +
      'per entry. The fees page adds player ids to a Set for the same reason.\n\n' +
      'If the cap should ever discount a promoted entry, the place to do it is ' +
      'the count in the three readers above — not a lock here.',
  },
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{5}_.*\.sql$/.test(f)).sort();
}

/**
 * The FINAL body of every function the migrations define, latest definition
 * wins. This has to be resolved across the whole directory: a function is
 * created once and then rewritten by CREATE OR REPLACE in later migrations, and
 * asking an early file about a discipline a later one introduced would fail on
 * history rather than on the code that runs.
 *
 * The body is bounded by its own dollar-quote tag, not by the next CREATE. A
 * statement slice would carry the trailing REVOKE/GRANT/COMMENT text of the
 * migration into the body and let an unrelated mention vote.
 */
function finalFunctionBodies(): Map<string, { body: string; file: string }> {
  const bodies = new Map<string, { body: string; file: string }>();
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = head.exec(sql)) !== null) {
      const name = m[1]!.toLowerCase();
      const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(m.index));
      if (!open) continue;
      const tag = open[1]!;
      const bodyStart = m.index + open.index + open[0].length;
      const bodyEnd = sql.indexOf(tag, bodyStart);
      if (bodyEnd === -1) continue;
      bodies.set(name, { body: sql.slice(bodyStart, bodyEnd), file });
    }
  }
  return bodies;
}

/** Comments cannot vote: a body that only MENTIONS the cap is not a counter. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

const BODIES = finalFunctionBodies();

describe('cross-event entry cap — the lock discipline 00201 established', () => {
  it('resolves function bodies at all (a census that matches nothing proves nothing)', () => {
    expect(BODIES.size).toBeGreaterThan(50);
    expect(BODIES.has('enter_tournament_event')).toBe(true);
  });

  const capReaders = [...BODIES.entries()]
    .filter(([, v]) => /max_events_per_player/i.test(stripComments(v.body)))
    .map(([name]) => name)
    .sort();

  it('the set of cap counters is exactly the three entry paths', () => {
    expect(
      capReaders,
      'A function started reading max_events_per_player. Classify it: if it is ' +
        'an entry path it must take both locks below; if it is not, it should ' +
        'not be reading the cap at all.',
    ).toEqual([...CAP_READERS].sort());
  });

  for (const fn of [...CAP_READERS].sort()) {
    it(`${fn} counts the cap under the tournament row lock, not just the event key`, () => {
      const entry = BODIES.get(fn);
      expect(entry, `${fn} is not defined by any migration`).toBeDefined();
      const body = stripComments(entry!.body);

      expect(
        /pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*'tournament_event_field'/i.test(body),
        `${fn} (${entry!.file}) counts the cap without taking the event field ` +
          'advisory lock. The count and the insert must be one serialised step.',
      ).toBe(true);

      expect(
        /FROM\s+tournaments\b[\s\S]{0,400}?FOR\s+UPDATE/i.test(body),
        `${fn} (${entry!.file}) counts max_events_per_player without taking the ` +
          'tournaments row FOR UPDATE. The advisory lock is keyed on ONE event, ' +
          'so it does not serialise two entries into two different events of the ' +
          'same tournament — which is exactly what a cross-event cap counts. ' +
          'See 00201.',
      ).toBe(true);
    });
  }
});

describe('cross-event entry cap — the entrant-writer census', () => {
  const writers = [...BODIES.entries()]
    .filter(([, v]) => /INSERT\s+INTO\s+tournament_(participants|pairs)\b/i.test(stripComments(v.body)))
    .map(([name]) => name)
    .sort();

  it('finds the entrant writers at all', () => {
    expect(writers.length).toBeGreaterThan(3);
  });

  it('every function that writes an entrant row is classified', () => {
    expect(
      writers,
      'A new function inserts a tournament entrant. Add it to ENTRANT_WRITERS ' +
        'with a reason: either it counts max_events_per_player under both locks, ' +
        'or state why its write cannot move a member\'s cross-event count.',
    ).toEqual(Object.keys(ENTRANT_WRITERS).sort());
  });

  it('the classification agrees with what the bodies actually do', () => {
    for (const [fn, meta] of Object.entries(ENTRANT_WRITERS)) {
      const body = stripComments(BODIES.get(fn)!.body);
      expect(
        /max_events_per_player/i.test(body),
        `${fn} is classified countsCap=${meta.countsCap} but its body says otherwise`,
      ).toBe(meta.countsCap);
      expect(meta.why.length, `${fn} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});
