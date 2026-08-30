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
 *   1. Every function that READS max_events_per_player must take both locks,
 *      IN ORDER, with the count on the far side of the row lock. 3/3 today, no
 *      exemptions. This is the invariant with teeth.
 *
 *   2. The set of functions that INSERT an entrant is a closed, classified
 *      list. Most members of it legitimately never read the cap, so asserting
 *      a lock on them would be an assertion with more exemptions than
 *      subjects. A census forces the next writer to be classified instead.
 *
 * ORDER IS ASSERTED, NOT JUST PRESENCE — codex round 28. The first version of
 * this file asked only whether both lock statements appeared somewhere in the
 * body, which a regression that moved the count ABOVE the row lock walks
 * straight through: both statements are still there, the count is still
 * unserialised, and the test stays green. That is the same shape as the
 * `recomputeEventStandings` defect (a gate at the bottom of a function passes
 * any "A is present and so is B" check), and it is the whole failure this file
 * exists to catch.
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
      'UNCLASSIFIED IN THE SAFE SENSE — this is a KNOWN OPEN GAP, not a cleared ' +
      'one, and it is the R2 residual the owner has not gated. Promotion writes ' +
      'a bracket entry for a member who is already entered in the pool event ' +
      'that fed it. It reads no cap, takes no tournament row, and has no source-' +
      'event parameter, so it cannot re-ask whether the pool entry it is ' +
      'promoting is still live.\n\n' +
      'IT CAN OVER-ADMIT. seedBracketFromPool snapshots the standings and then ' +
      'calls this function once per qualifier, holding no lock on the source ' +
      'event across that gap (apps/admin/src/lib/tournament-actions/' +
      'brackets.ts:583,602,699). A withdrawal landing in that gap frees the ' +
      "member's pool slot; they spend it entering another event, whose count " +
      'correctly sees the withdrawn pool row as gone; the promotion then re-adds ' +
      'them to the bracket off the stale snapshot. Two live entries under a cap ' +
      'of one. `rankableIds` (_internal.ts:2200) only excludes withdrawals ' +
      'visible AT SNAPSHOT TIME, so it does not close this.\n\n' +
      'What bounds the damage: it is admin-only — no member can reach it — and ' +
      'it cannot double-charge, because the tournament fee is one row per member ' +
      'per tournament, enforced by the partial unique index ' +
      'club_fees_tournament_player_key on (tournament_id, player_id), not one row ' +
      'per entry. The fees page builds a Set of player ids for the same reason.\n\n' +
      'The fix is a redesign with an open product question (skip the qualifier ' +
      'and move the next finisher up, or refuse the generation and leave a ' +
      'half-built draw), so it is filed rather than built. countsCap stays false ' +
      'because it describes what the body DOES, and the body reads no cap.',
  },
};

/** Every migration, in apply order. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{5}_.*\.sql$/.test(f)).sort();
}

/**
 * Postgres spells some types two ways and the migrations use both. Signatures
 * are compared for identity, so `timestamptz` and `timestamp with time zone`
 * have to collapse or one function looks like two.
 */
function normaliseType(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^timestamp with time zone$/, 'timestamptz')
    .replace(/^timestamp without time zone$/, 'timestamp')
    .replace(/^character varying$/, 'varchar')
    .replace(/^double precision$/, 'float8');
}

/** `p_event_id uuid` -> `uuid`; a bare `uuid` (as DROP writes it) stays `uuid`. */
function argTypes(argText: string, named: boolean): string {
  if (!argText.trim()) return '';
  return argText
    .split(',')
    .map((a) => a.replace(/\s+DEFAULT[\s\S]*$/i, '').trim())
    .map((a) => {
      const parts = a.split(/\s+/);
      return normaliseType(named && parts.length > 1 ? parts.slice(1).join(' ') : a);
    })
    .join(',');
}

type Resolved = { body: string; file: string; args: string };

/**
 * The FINAL body of every function signature the migrations leave in place.
 *
 * KEYED BY NAME **AND ARGUMENT TYPES** — codex round 28. Keying by name alone
 * collapses overloads: two co-existing signatures of one name become one entry,
 * the later definition masks the earlier, and a live overload that inserts
 * entrants without the cap simply never appears in the census. The key is the
 * thing Postgres itself uses to tell functions apart, so it is the thing this
 * parse has to use.
 *
 * Resolved across the whole directory, latest definition wins, DROPs applied:
 * a function is created once and then rewritten by CREATE OR REPLACE in later
 * migrations, and asking an early file about a discipline a later one
 * introduced would fail on history rather than on the code that runs.
 *
 * The body is bounded by its own dollar-quote tag, not by the next CREATE. A
 * statement slice would carry the trailing REVOKE/GRANT/COMMENT text of the
 * migration into the body and let an unrelated mention vote.
 */
function finalFunctionBodies(): Map<string, Resolved> {
  const live = new Map<string, Resolved>();
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    // Applied in file order alongside the creates below, so a DROP-then-CREATE
    // of a changed signature in one migration lands the way Postgres lands it.
    for (const d of sql.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)/gi)) {
      live.delete(`${d[1]!.toLowerCase()}(${argTypes(d[2]!, false)})`);
    }

    const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*RETURNS/gi;
    let m: RegExpExecArray | null;
    while ((m = head.exec(sql)) !== null) {
      const name = m[1]!.toLowerCase();
      const args = argTypes(m[2]!, true);
      const open = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(m.index));
      if (!open) continue;
      const tag = open[1]!;
      const bodyStart = m.index + open.index + open[0].length;
      const bodyEnd = sql.indexOf(tag, bodyStart);
      if (bodyEnd === -1) continue;
      live.set(`${name}(${args})`, { body: sql.slice(bodyStart, bodyEnd), file, args });
    }
  }
  return live;
}

/** Comments cannot vote: a body that only MENTIONS the cap is not a counter. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

const BODIES = finalFunctionBodies();

/** Signature key -> bare name, for reporting a census by the name a human uses. */
function nameOf(key: string): string {
  return key.slice(0, key.indexOf('('));
}

/** Every live signature of one name. More than one is an overload. */
function signaturesOf(name: string): string[] {
  return [...BODIES.keys()].filter((k) => nameOf(k) === name).sort();
}

/**
 * The single live body of a name that is asserted to have exactly one. Every
 * caller of this is downstream of the overload test below, which is what makes
 * "the body" a well-defined thing to talk about.
 */
function soleBody(name: string): Resolved {
  const keys = signaturesOf(name);
  expect(keys.length, `${name} has ${keys.length} live signatures: ${keys.join(', ')}`).toBe(1);
  return BODIES.get(keys[0]!)!;
}

const CLASSIFIED = [...new Set([...CAP_READERS, ...Object.keys(ENTRANT_WRITERS)])].sort();

describe('cross-event entry cap — the lock discipline 00201 established', () => {
  it('resolves function bodies at all (a census that matches nothing proves nothing)', () => {
    expect(BODIES.size).toBeGreaterThan(50);
    expect(signaturesOf('enter_tournament_event').length).toBe(1);
  });

  it('no classified function is an overload (name-keyed reasoning would be unsound)', () => {
    for (const name of CLASSIFIED) {
      const keys = signaturesOf(name);
      expect(
        keys.length,
        `${name} now has ${keys.length} live signatures (${keys.join(', ')}). Every ` +
          'classification in this file talks about "the body" of a name, which only ' +
          'means something while a name is one function. Drop the dead overload, or ' +
          'classify each signature separately.',
      ).toBe(1);
    }
  });

  const capReaders = [...BODIES.entries()]
    .filter(([, v]) => /max_events_per_player/i.test(stripComments(v.body)))
    .map(([key]) => nameOf(key))
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
      const entry = soleBody(fn);
      const body = stripComments(entry.body);
      const where = `${fn} (${entry.file})`;

      const fence = /pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*'tournament_event_field'/i.exec(body);
      expect(
        fence,
        `${where} counts the cap without taking the event field advisory lock. ` +
          'The count and the insert must be one serialised step.',
      ).not.toBeNull();

      const rowLock = /FROM\s+tournaments\b[\s\S]{0,400}?FOR\s+UPDATE/i.exec(body);
      expect(
        rowLock,
        `${where} counts max_events_per_player without taking the tournaments ` +
          'row FOR UPDATE. The advisory lock is keyed on ONE event, so it does ' +
          'not serialise two entries into two different events of the same ' +
          'tournament — which is exactly what a cross-event cap counts. See 00201.',
      ).not.toBeNull();

      expect(
        rowLock!.index > fence!.index,
        `${where} takes the tournaments row BEFORE the event field key. 00196 ` +
          'fixed the lock order as advisory -> tournaments -> tournament_events; ' +
          'reversing it here deadlocks against every other field writer.',
      ).toBe(true);

      // THE READ ORDER. The cap VALUE is read by the same SELECT that takes the
      // row lock, so its offset is legitimately a little before the FROM clause
      // the regex above anchors on -- what must never happen is a read in an
      // EARLIER statement, which is a cap value that can be stale by the time
      // it is compared. Same statement or later; never a `;` in between.
      for (const cap of body.matchAll(/max_events_per_player/gi)) {
        const inSameStatement = cap.index! < rowLock!.index && !body.slice(cap.index!, rowLock!.index).includes(';');
        expect(
          cap.index! > rowLock!.index || inSameStatement,
          `${where} reads max_events_per_player in a statement that completes ` +
            'before the tournaments row is locked. The value it compares against ' +
            'is then a value another transaction may already have changed.',
        ).toBe(true);
      }

      // THE COUNT ORDER, which is the assertion codex round 28 was missing. The
      // cross-event count is the read the row lock exists to serialise; running
      // it above the lock leaves both lock statements present and the race wide
      // open. Recognised by its join: the cap spans a tournament's events, so
      // the count has to reach tournament_events to scope itself.
      const counts = [...body.matchAll(/FROM\s+tournament_(?:participants|pairs)\s+\w+\s+JOIN\s+tournament_events\b/gi)];
      expect(
        counts.length,
        `${where} reads the cap but has no cross-event count to compare it to. ` +
          'Either the count moved somewhere this test cannot see it, or the cap ' +
          'is being read and not enforced.',
      ).toBeGreaterThan(0);
      for (const c of counts) {
        expect(
          c.index! > rowLock!.index,
          `${where} counts the member's other entries BEFORE taking the ` +
            'tournaments row FOR UPDATE. Both lock statements are still in the ' +
            'body, so presence alone would pass — but a count read above the ' +
            'lock is exactly the pre-00201 race: two entries into two different ' +
            'events take two different advisory keys and both read the same ' +
            'pre-write count.',
        ).toBe(true);
      }
    });
  }
});

describe('cross-event entry cap — the entrant-writer census', () => {
  // `public.` is optional in an INSERT target and the migrations use both
  // spellings, so the schema qualifier has to be optional here too -- codex
  // round 28. A writer that spelled it out would otherwise be invisible.
  const writers = [...BODIES.entries()]
    .filter(([, v]) => /INSERT\s+INTO\s+(?:public\.)?tournament_(participants|pairs)\b/i.test(stripComments(v.body)))
    .map(([key]) => nameOf(key))
    .sort();

  it('finds the entrant writers at all', () => {
    expect(writers.length).toBeGreaterThan(3);
  });

  it('every function that writes an entrant row is classified', () => {
    expect(
      [...new Set(writers)],
      'A new function inserts a tournament entrant. Add it to ENTRANT_WRITERS ' +
        'with a reason: either it counts max_events_per_player under both locks, ' +
        'or state why its write cannot move a member\'s cross-event count.',
    ).toEqual(Object.keys(ENTRANT_WRITERS).sort());
  });

  it('the classification agrees with what the bodies actually do', () => {
    for (const [fn, meta] of Object.entries(ENTRANT_WRITERS)) {
      const body = stripComments(soleBody(fn).body);
      expect(
        /max_events_per_player/i.test(body),
        `${fn} is classified countsCap=${meta.countsCap} but its body says otherwise`,
      ).toBe(meta.countsCap);
      expect(meta.why.length, `${fn} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});
