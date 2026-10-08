import { describe, it, expect } from 'vitest';
import {
  PAIR_NOTES,
  PARTICIPANT_NOTES,
  TOURNAMENT_MATCH_NOTES,
  WALKOVER_NOTES,
  canReadPrivateNotes,
  fetchPrivateNotes,
  isMissingTableError,
  writePrivateNote,
  type PrivateNoteTable,
} from '../private-notes';
import {
  CAPABILITIES,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  UNRESTRICTED,
  type Capability,
  type Permissions,
} from '../permissions';

// THE OTHER FOUR COLUMNS OF EXEC FREE TEXT.
//
// The sibling of match-note.test.ts, and the same two claims fail in opposite
// directions: too narrow and an exec writes a disqualification reason they
// cannot read back, too wide and the thing 00118 exists to hide goes to
// everyone who can open the page. Both are silent from the screen.

const ALL_TABLES: [string, PrivateNoteTable][] = [
  ['participant', PARTICIPANT_NOTES],
  ['pair', PAIR_NOTES],
  ['tournament match', TOURNAMENT_MATCH_NOTES],
  ['walkover', WALKOVER_NOTES],
];

const restricted = (capabilities: Capability[]): Permissions =>
  ({ kind: 'restricted', capabilities: new Set(capabilities) });

describe('the tables 00118 creates', () => {
  it('names a table and a key for each, and no two share a table', () => {
    // A copy-paste slip here would silently write one parent's notes into
    // another's table, where the foreign key would reject them — or worse,
    // would not.
    const tables = ALL_TABLES.map(([, spec]) => spec.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const [name, spec] of ALL_TABLES) {
      expect(spec.table, `${name} table`).toMatch(/^[a-z_]+$/);
      expect(spec.key, `${name} key`).toMatch(/^[a-z_]+_id$/);
    }
  });

  it('never names a parent table', () => {
    // The whole point is that the text is NOT on the parent row. If one of
    // these ever pointed back at its parent the migration would be undone by a
    // constant.
    const parents = [
      'tournament_participants', 'tournament_pairs', 'tournament_matches', 'walkovers',
    ];
    for (const [, spec] of ALL_TABLES) {
      expect(parents).not.toContain(spec.table);
    }
  });
});

describe('who may read a private note', () => {
  it('names only capabilities that exist', () => {
    // A typo would be a string nobody holds, so the read would be refused to
    // everyone including admins — and nothing would say so.
    for (const [name, spec] of ALL_TABLES) {
      for (const capability of spec.capabilities) {
        expect(CAPABILITIES, `${capability} (${name}) is not in the vocabulary`).toContain(capability);
      }
    }
  });

  it('covers exactly the capabilities that AUTHOR each note', () => {
    // Written out by hand rather than derived: a derivation from the constant
    // would agree with the constant however wrong the constant is. These are
    // the requireCapability() arguments on the six writers.
    //
    // exitDrawImpl is the single writer of both entry tables, which is why
    // those two are one-element sets rather than an oversight.
    //
    // `…walkover.write` joined the match set with FIX-LIST #18 and is a genuine
    // fourth WRITER, not a widening for convenience: enterWalkoverImpl now
    // records the exec's sentence in tournament_match_notes instead of in
    // tournament_matches.walkover_reason, which 00113 broadcasts to every
    // subscriber. The rule the set encodes is unchanged — you may read what you
    // may write — and the officer who awards walkovers must be able to read
    // back the reason they gave for one.
    expect([...PARTICIPANT_NOTES.capabilities]).toEqual(['tournaments.draw.exit.write']);
    expect([...PAIR_NOTES.capabilities]).toEqual(['tournaments.draw.exit.write']);
    expect([...TOURNAMENT_MATCH_NOTES.capabilities].sort()).toEqual([
      'tournaments.results.doublenoshow.write',
      'tournaments.results.unvoid.write',
      'tournaments.results.void.write',
      'tournaments.results.walkover.write',
    ]);
    expect([...WALKOVER_NOTES.capabilities].sort()).toEqual([
      'walkovers.confirm.write',
      'walkovers.reject.write',
    ]);
  });

  it('never gates a note read on a PAGE capability', () => {
    // `tournaments.page` / `walkovers.page` were the obvious alternative and
    // are the rejected one: a page capability is the READ of the screen, held
    // by anyone allowed merely to look, which is a strictly wider audience than
    // the authors — and it is that audience this change exists to exclude.
    for (const [name, spec] of ALL_TABLES) {
      for (const capability of spec.capabilities) {
        expect(capability.endsWith('.page'), `${capability} (${name}) is a page read`).toBe(false);
      }
    }
  });

  it('admits an admin and refuses somebody with no console access', () => {
    for (const [name, spec] of ALL_TABLES) {
      expect(canReadPrivateNotes('admin', UNRESTRICTED, spec), name).toBe(true);
      expect(canReadPrivateNotes(null, UNRESTRICTED, spec), name).toBe(false);
    }
  });

  it('refuses an unrestricted trainer and an unrestricted exec', () => {
    // Neither baseline holds any of these writes, so the notes are invisible to
    // an officer until somebody deliberately grants one — the same shape 00117
    // established for the match ledger.
    for (const [name, spec] of ALL_TABLES) {
      expect(TRAINER_BASELINE.some((c) => spec.capabilities.includes(c)), name).toBe(false);
      expect(EXEC_BASELINE.some((c) => spec.capabilities.includes(c)), name).toBe(false);
      expect(canReadPrivateNotes('trainer', UNRESTRICTED, spec), name).toBe(false);
      expect(canReadPrivateNotes('exec', UNRESTRICTED, spec), name).toBe(false);
    }
  });

  it('admits an exec holding ANY ONE of a table\'s writes', () => {
    // THE WHOLE REASON THESE ARE UNIONS. An unvoid-only officer opening the
    // restore panel has to be able to read the reason a void-only officer
    // wrote, or the panel quotes nothing back at the person restoring.
    for (const [name, spec] of ALL_TABLES) {
      for (const capability of spec.capabilities) {
        expect(
          canReadPrivateNotes('exec', restricted([capability]), spec),
          `${capability} should be enough for ${name} notes`,
        ).toBe(true);
      }
    }
  });

  it('does not let one table\'s write unlock another\'s notes', () => {
    // The sets are per-table on purpose rather than pooled into one "may read
    // exec notes" grant: a walkover officer has no business reading why an
    // entry was disqualified.
    expect(canReadPrivateNotes('exec', restricted(['walkovers.confirm.write']), PARTICIPANT_NOTES)).toBe(false);
    expect(canReadPrivateNotes('exec', restricted(['tournaments.draw.exit.write']), WALKOVER_NOTES)).toBe(false);
    expect(canReadPrivateNotes('exec', restricted(['tournaments.draw.exit.write']), TOURNAMENT_MATCH_NOTES)).toBe(false);
  });
});

describe('surviving a database that has not had 00118 applied', () => {
  it('recognises every code that means "no such table"', () => {
    for (const code of ['PGRST205', 'PGRST202', '42P01']) {
      expect(isMissingTableError({ code }, 'tournament_match_notes'), code).toBe(true);
    }
  });

  it('recognises the message when no code is populated, per table', () => {
    // THE LINE THAT COULD NOT SIMPLY BE IMPORTED FROM match-note.ts, whose
    // backstop hard-codes `match_admin_notes`. Reusing it unchanged would have
    // failed exactly this case for all four tables here.
    for (const [name, spec] of ALL_TABLES) {
      expect(
        isMissingTableError(
          { message: `Could not find the table 'public.${spec.table}' in the schema cache` },
          spec.table,
        ),
        name,
      ).toBe(true);
    }
  });

  it('does NOT swallow the missing-COLUMN codes 00116 swallows', () => {
    // The predicate this one was almost copied from. PGRST204 and 42703 mean a
    // column is absent from a table that EXISTS, which for these tables is not
    // a pre-migration state — it is drift, and it must be loud.
    expect(isMissingTableError({ code: 'PGRST204' }, 'tournament_match_notes')).toBe(false);
    expect(isMissingTableError({ code: '42703' }, 'tournament_match_notes')).toBe(false);
  });

  it('does NOT swallow a real failure', () => {
    expect(isMissingTableError({ code: '23505', message: 'duplicate key value' }, 'x')).toBe(false);
    expect(isMissingTableError({ code: '42501', message: 'permission denied' }, 'x')).toBe(false);
    expect(isMissingTableError(null, 'x')).toBe(false);
  });
});

describe('fetching the notes for the rows on screen', () => {
  const clientReturning = (
    result: { data: Record<string, string>[] | null; error: unknown },
    seen: { table?: string; column?: string; ids?: string[] } = {},
  ) =>
    ({
      from(table: string) {
        seen.table = table;
        return {
          select: () => ({
            in: (column: string, values: string[]) => {
              seen.column = column;
              seen.ids = values;
              return Promise.resolve(result);
            },
          }),
        };
      },
    }) as never;

  it('asks the private table by its own key column', async () => {
    for (const [name, spec] of ALL_TABLES) {
      const seen: { table?: string; column?: string } = {};
      await fetchPrivateNotes(clientReturning({ data: [], error: null }, seen), spec, ['p1']);
      expect(seen.table, name).toBe(spec.table);
      expect(seen.column, name).toBe(spec.key);
    }
  });

  it('does not query at all for an empty screen', async () => {
    const seen: { table?: string } = {};
    const notes = await fetchPrivateNotes(
      clientReturning({ data: [], error: null }, seen), TOURNAMENT_MATCH_NOTES, [],
    );
    expect(notes.size).toBe(0);
    expect(seen.table).toBeUndefined();
  });

  it('keys the notes by parent id', async () => {
    const notes = await fetchPrivateNotes(
      clientReturning({ data: [{ match_id: 'm2', note: 'wrong pair entered' }], error: null }),
      TOURNAMENT_MATCH_NOTES,
      ['m1', 'm2'],
    );
    expect(notes.get('m2')).toBe('wrong pair entered');
    // A row with no note is ABSENT, not empty-string — the renderers draw
    // nothing for undefined, and "" would draw a labelled strip with no words.
    expect(notes.has('m1')).toBe(false);
  });

  it('renders nothing rather than breaking the page pre-migration', async () => {
    const notes = await fetchPrivateNotes(
      clientReturning({ data: null, error: { code: 'PGRST205', message: 'not in schema cache' } }),
      WALKOVER_NOTES,
      ['w1'],
    );
    expect(notes.size).toBe(0);
  });

  it('throws on any other failure', async () => {
    await expect(
      fetchPrivateNotes(
        clientReturning({ data: null, error: { code: '42501', message: 'permission denied' } }),
        WALKOVER_NOTES,
        ['w1'],
      ),
    ).rejects.toThrow('permission denied');
  });
});

describe('writing a note without ever costing the audit row', () => {
  interface Seen {
    table?: string;
    op?: 'upsert' | 'delete';
    row?: Record<string, unknown>;
    onConflict?: string;
    eq?: [string, string];
  }

  const writer = (error: unknown, seen: Seen = {}) =>
    ({
      from(table: string) {
        seen.table = table;
        return {
          upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => {
            seen.op = 'upsert';
            seen.row = row;
            seen.onConflict = opts.onConflict;
            return Promise.resolve({ error });
          },
          delete: () => ({
            eq: (column: string, value: string) => {
              seen.op = 'delete';
              seen.eq = [column, value];
              return Promise.resolve({ error });
            },
          }),
        };
      },
    }) as never;

  it('upserts on the parent key, with the author', async () => {
    const seen: Seen = {};
    const result = await writePrivateNote(
      writer(null, seen), PARTICIPANT_NOTES, 'p1', 'no-showed the quarter', 'exec-1',
    );
    expect(result).toEqual({ recorded: true, error: null });
    expect(seen.table).toBe('tournament_participant_notes');
    expect(seen.op).toBe('upsert');
    expect(seen.onConflict).toBe('participant_id');
    expect(seen.row).toMatchObject({
      participant_id: 'p1',
      note: 'no-showed the quarter',
      author_id: 'exec-1',
    });
    // Sent explicitly as well as by trigger: the trigger fires on UPDATE, and
    // the INSERT half of an upsert would otherwise keep the default.
    expect(seen.row?.updated_at).toBeTypeOf('string');
  });

  it('DELETES the row for an empty or absent note', async () => {
    // The columns being replaced were nullable and two call sites wrote
    // `reason ?? null` / `reason || null`, so clearing was reachable and meant
    // "there is no longer a reason here". A NOT NULL `note` cannot say that, so
    // the absence of a row does.
    for (const empty of ['', '   ', null, undefined]) {
      const seen: Seen = {};
      const result = await writePrivateNote(writer(null, seen), WALKOVER_NOTES, 'w1', empty, 'exec-1');
      expect(result.recorded, JSON.stringify(empty)).toBe(true);
      expect(seen.op).toBe('delete');
      expect(seen.eq).toEqual(['walkover_id', 'w1']);
    }
  });

  it('trims, so a note of spaces does not become a strip with no words', async () => {
    const seen: Seen = {};
    await writePrivateNote(writer(null, seen), WALKOVER_NOTES, 'w1', '  rejected  ', 'exec-1');
    expect(seen.row?.note).toBe('rejected');
  });

  it('reports a missing table as not-recorded, WITHOUT throwing', async () => {
    // The pre-migration state. It must not throw: every caller runs this after
    // its parent write has committed and before logAudit, so a throw here would
    // skip the audit row and leave an unaudited destructive act. That is the
    // bug 00117 shipped and then fixed, and this is what stops it recurring at
    // six new call sites.
    for (const code of ['PGRST205', 'PGRST202', '42P01']) {
      const result = await writePrivateNote(
        writer({ code, message: 'no' }), TOURNAMENT_MATCH_NOTES, 'm1', 'voided', 'exec-1',
      );
      expect(result, code).toEqual({ recorded: false, error: null });
    }
  });

  it('reports a REAL failure as not-recorded with an error, and still does not throw', async () => {
    // Loud, but returned rather than raised: the caller logs it to Sentry, puts
    // `note_recorded: false` in the audit row, and carries on to write that row.
    // A blanket swallow would instead end in a green toast after 00118 is
    // applied, and the exec would believe a reason was recorded that was not.
    const result = await writePrivateNote(
      writer({ code: '42501', message: 'permission denied' }), PAIR_NOTES, 'p1', 'dq', 'exec-1',
    );
    expect(result.recorded).toBe(false);
    expect(result.error).toBe('permission denied');
  });

  it('never throws, for any error shape at all', async () => {
    for (const error of [{ code: '23505' }, { message: 'boom' }, {}, { code: null, message: null }]) {
      await expect(
        writePrivateNote(writer(error), WALKOVER_NOTES, 'w1', 'text', 'exec-1'),
      ).resolves.toBeTruthy();
    }
  });
});
