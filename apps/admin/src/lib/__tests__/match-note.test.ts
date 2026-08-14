import { describe, it, expect } from 'vitest';
import {
  MATCH_ADMIN_NOTE_TABLE,
  MATCH_NOTE_READ_CAPABILITIES,
  canReadMatchNotes,
  fetchMatchNotes,
  isMissingNoteTableError,
} from '../match-note';
import {
  CAPABILITIES,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  UNRESTRICTED,
  type Capability,
  type Permissions,
} from '../permissions';

// THE PRIVATE HALF OF THE MATCH LEDGER.
//
// Two claims are worth defending here, and they fail in opposite directions.
// Too narrow, and an exec writes a void reason they cannot read back. Too wide,
// and the thing 00117 exists to hide is handed to everyone who can open the
// page. Both are silent from the screen.

describe('who may read a match admin note', () => {
  // A composed person is a level plus an explicit set — that is what
  // resolvePermissions hands the gates. `{ kind: 'unrestricted' }` is the state
  // a row is in before anybody edits it, and resolves to the LEVEL's baseline.
  const restricted = (capabilities: Capability[]): Permissions =>
    ({ kind: 'restricted', capabilities: new Set(capabilities) });

  it('names only capabilities that exist', () => {
    // A typo would be a string nobody holds, so the read would be refused to
    // everyone including admins — and nothing would say so.
    for (const capability of MATCH_NOTE_READ_CAPABILITIES) {
      expect(CAPABILITIES, `${capability} is not in the vocabulary`).toContain(capability);
    }
  });

  it('covers every capability that AUTHORS a note', () => {
    // The rule is "you may read what you may write", so this list must be the
    // list of write gates on lib/actions/matches.ts's three note writers:
    // adminCreateMatch, voidMatch, convertMatchToCasual. Written out by hand
    // rather than derived, for the same reason capability-equivalence.test.ts
    // is: a derivation from the constant would agree with the constant however
    // wrong the constant is.
    expect([...MATCH_NOTE_READ_CAPABILITIES].sort()).toEqual([
      'matches.convert.write',
      'matches.create.write',
      'matches.void.write',
    ]);
  });

  it('admits an admin', () => {
    expect(canReadMatchNotes('admin', UNRESTRICTED)).toBe(true);
  });

  it('refuses somebody with no console access at all', () => {
    expect(canReadMatchNotes(null, UNRESTRICTED)).toBe(false);
  });

  it('refuses an unrestricted trainer and an unrestricted exec', () => {
    // Neither baseline holds a single `matches.*` write — TRAINER_BASELINE is
    // three read-shaped capabilities and EXEC_BASELINE narrowed to twelve
    // reads. So the notes are invisible to an officer until somebody
    // deliberately gives them one of the three writes, which is the intended
    // shape: the club owner's execs get the ledger, not its margins.
    expect(TRAINER_BASELINE.some((c) => MATCH_NOTE_READ_CAPABILITIES.includes(c))).toBe(false);
    expect(EXEC_BASELINE.some((c) => MATCH_NOTE_READ_CAPABILITIES.includes(c))).toBe(false);
    expect(canReadMatchNotes('trainer', UNRESTRICTED)).toBe(false);
    expect(canReadMatchNotes('exec', UNRESTRICTED)).toBe(false);
  });

  it('admits an exec holding ANY ONE of the three writes', () => {
    // THE WHOLE REASON THIS IS A UNION. A void-only officer types a reason into
    // the void dialog; gating the read on matches.create.write would leave them
    // staring at a ledger that says nothing about the note they just wrote.
    for (const capability of MATCH_NOTE_READ_CAPABILITIES) {
      expect(
        canReadMatchNotes('exec', restricted(['matches.page', capability])),
        `${capability} should be enough to read notes`,
      ).toBe(true);
    }
  });

  it('refuses an exec who holds only the ledger page', () => {
    // `matches.page` was the rejected alternative: it is the READ that lets
    // somebody look at the club's results, held by a strictly wider group than
    // the three writers, and it is roughly the audience this change exists to
    // exclude.
    expect(canReadMatchNotes('exec', restricted(['matches.page']))).toBe(false);
  });
});

describe('surviving a database that has not had 00117 applied', () => {
  it('recognises every code that means "no such table"', () => {
    // PostgREST answers PGRST205 out of its schema cache, PGRST202 on an older
    // reader, and Postgres itself raises 42P01 if the statement gets past the
    // cache.
    for (const code of ['PGRST205', 'PGRST202', '42P01']) {
      expect(isMissingNoteTableError({ code }), code).toBe(true);
    }
  });

  it('recognises the message when no code is populated', () => {
    expect(
      isMissingNoteTableError({
        message: `Could not find the table 'public.${MATCH_ADMIN_NOTE_TABLE}' in the schema cache`,
      }),
    ).toBe(true);
  });

  it('does NOT swallow the missing-COLUMN codes 00116 swallows', () => {
    // The predicate this one was almost copied from. PGRST204 and 42703 mean a
    // column is absent from a table that exists, which for THIS table is not a
    // pre-migration state — it is a schema that has drifted, and it must be
    // loud.
    expect(isMissingNoteTableError({ code: 'PGRST204' })).toBe(false);
    expect(isMissingNoteTableError({ code: '42703' })).toBe(false);
  });

  it('does NOT swallow a real failure', () => {
    // If it did, a genuine error after 00117 lands would still end in a green
    // "Match created" toast and the exec would believe a note was recorded that
    // was not — the same fiction this feature exists to prevent, arriving
    // through the console instead of the database.
    expect(isMissingNoteTableError({ code: '23505', message: 'duplicate key value' })).toBe(false);
    expect(isMissingNoteTableError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingNoteTableError(null)).toBe(false);
  });
});

describe('fetching the notes for the matches on screen', () => {
  const clientReturning = (
    result: { data: { match_id: string; note: string }[] | null; error: unknown },
    seen: { table?: string; ids?: string[] } = {},
  ) =>
    ({
      from(table: string) {
        seen.table = table;
        return {
          select: () => ({
            in: (_column: string, values: string[]) => {
              seen.ids = values;
              return Promise.resolve(result);
            },
          }),
        };
      },
    }) as never;

  it('asks the private table, never `matches`', () => {
    const seen: { table?: string } = {};
    return fetchMatchNotes(clientReturning({ data: [], error: null }, seen), ['m1']).then(() => {
      expect(seen.table).toBe('match_admin_notes');
    });
  });

  it('does not query at all for an empty ledger', async () => {
    const seen: { table?: string } = {};
    const notes = await fetchMatchNotes(clientReturning({ data: [], error: null }, seen), []);
    expect(notes.size).toBe(0);
    expect(seen.table).toBeUndefined();
  });

  it('keys the notes by match id', async () => {
    const notes = await fetchMatchNotes(
      clientReturning({ data: [{ match_id: 'm2', note: 'entered by hand at the desk' }], error: null }),
      ['m1', 'm2'],
    );
    expect(notes.get('m2')).toBe('entered by hand at the desk');
    // A match with no note is ABSENT, not empty-string — the page renders
    // nothing for undefined, and "" would draw a labelled strip with no words.
    expect(notes.has('m1')).toBe(false);
  });

  it('renders an empty ledger of notes rather than breaking the page pre-migration', async () => {
    const notes = await fetchMatchNotes(
      clientReturning({ data: null, error: { code: 'PGRST205', message: 'not in schema cache' } }),
      ['m1'],
    );
    expect(notes.size).toBe(0);
  });

  it('throws on any other failure', async () => {
    await expect(
      fetchMatchNotes(
        clientReturning({ data: null, error: { code: '42501', message: 'permission denied' } }),
        ['m1'],
      ),
    ).rejects.toThrow('permission denied');
  });
});
