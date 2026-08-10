import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, PERMISSION_ROLES } from '../access-level';

// REMOVAL IS A MIGRATION, made self-enforcing.
//
// The vocabulary CHECK pins every capability string, and that constraint is
// there for the REVOKES. An unknown element in `grants` is
// harmless — the resolver drops it and nobody gains anything. An unknown
// element in `revokes` is the opposite: it fails to REMOVE something, and the
// something it fails to remove might be permissions.write. So deleting a
// capability from the code while a stored revoke still names it is the one way
// this model can widen a person by accident.
//
// A CHECK is not re-validated when code changes, so the constraint cannot catch
// that on its own. What catches it is this test: the two lists have to agree, so
// a capability cannot be added or removed without the migration that adds it to
// the constraint — or, for a removal, the UPDATE that strips it from every
// stored array.
//
// Reading the SQL as text is crude and it is the point. Anything cleverer would
// be a THIRD place the vocabulary is written down.

const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

/** The single-quoted strings inside the first ARRAY[…] literal after a marker. */
function arrayLiteralAfter(sql: string, marker: string): string[] {
  const from = sql.indexOf(marker);
  if (from === -1) throw new Error(`marker not found: ${marker}`);
  const open = sql.indexOf('ARRAY[', from);
  const close = sql.indexOf(']', open);
  return [...sql.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('the migrations and the vocabulary', () => {
  const sql = migration('00087_');
  // THE VOCABULARY CHECK KEEPS MOVING, so the assertion follows it and nothing
  // else does. 00087 pinned 113 strings; 00088 renamed fourteen of them to
  // `<area>.page` and added two, reaching 115; 00089 adds `players.read` and
  // reaches 116. Each drops the constraint and re-adds it, so the LATEST one is
  // the only one whose list is live. The role list and the privilege guard still
  // live in 00087, which is applied on staging and is not edited, and pointing
  // them anywhere else would fail on a missing marker rather than on a real
  // disagreement.
  const vocabularySql = migration('00089_');
  // The RENAME lives in 00088 and stays pinned there. Following it to 00089
  // would look like it still passed while quietly checking nothing: 00089 renames
  // nothing, so `dropped` would be empty and the mapping assertion would never
  // run again.
  const renameSql = migration('00088_');

  it('pins exactly the capabilities this build has', () => {
    const stored = arrayLiteralAfter(vocabularySql, 'players_permission_vocabulary_check');
    expect(stored.length).toBe(CAPABILITIES.length);
    expect([...stored].sort()).toEqual([...CAPABILITIES].sort());
  });

  // Every capability 00087 pinned and 00088 does not is a string that may still
  // be sitting in somebody's stored revokes, and a revoke that stops naming a
  // capability the code has is a revoke that silently stops biting. So a removal
  // has to be a RENAME with a mapping, and this is the assertion that there is
  // one for each — the exact hazard 00087's header describes, tested rather than
  // described.
  it('maps every capability 00087 had and 00088 does not', () => {
    const before = arrayLiteralAfter(sql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(renameSql, 'players_permission_vocabulary_check'));
    const dropped = before.filter((capability) => !after.has(capability));
    expect(dropped.length, 'nothing was renamed — check the marker').toBeGreaterThan(0);
    for (const capability of dropped) {
      expect(
        renameSql.includes(`('${capability}',`),
        `${capability} left the vocabulary with no rename in 00088`,
      ).toBe(true);
    }
  });

  // ...and 00089 is where that rule is tested in the other direction. Its header
  // claims it needs no rewrite of the stored arrays BECAUSE it removes nothing,
  // and this is that claim as an assertion rather than a sentence: a purely
  // additive migration is the only kind that may skip the UPDATE step, so the day
  // somebody drops a string here without one, the file's own reasoning fails
  // with it.
  it('removes nothing in 00089, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(renameSql, 'players_permission_vocabulary_check');
    const after = new Set(arrayLiteralAfter(vocabularySql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  it('pins exactly the roles this build has', () => {
    // THE ROLE LIST MOVED, for the same reason the vocabulary list did: 00087
    // pinned the four VP jobs, and 00091 drops and re-adds the constraint with
    // `custom` alongside them. Both files write a list; only the LATEST one is
    // live, so the assertion follows it there.
    //
    // Written as `permission_role IN ('a', 'b', …)` rather than as an array, so
    // it is matched separately.
    const roleSql = migration('00091_');
    const from = roleSql.indexOf('players_permission_role_check');
    const check = roleSql.slice(from, roleSql.indexOf(';', roleSql.indexOf('CHECK', from)));
    const roles = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect([...roles].sort()).toEqual([...PERMISSION_ROLES].sort());
  });

  // The three columns the resolver reads, and the guard trigger that stops a
  // member writing them to their own row through PostgREST. Without the guard
  // lines, players_update_own (00005) lets the exec whose access these columns
  // limit clear them and take everything back.
  it('guards all three columns in both branches of the privilege trigger', () => {
    const from = sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns');
    const body = sql.slice(from);
    const [insertBranch, updateBranch] = body.split('IF TG_OP = \'INSERT\' THEN')[1]!
      .split('RETURN NEW;\n  END IF;');
    for (const column of ['permission_role', 'permission_grants', 'permission_revokes']) {
      expect(insertBranch!.includes(column), `INSERT branch misses ${column}`).toBe(true);
      expect(updateBranch!.includes(column), `UPDATE branch misses ${column}`).toBe(true);
    }
    // portfolio is gone from both, and the column with it.
    expect(body.includes('NEW.portfolio')).toBe(false);
  });
});
