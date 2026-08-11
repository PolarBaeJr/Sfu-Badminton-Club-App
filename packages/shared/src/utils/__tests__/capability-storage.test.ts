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
  // ...and 00097 adds `tournaments.draw.waivers.read`, reaching 117. THE LIVE
  // LIST IS THIS ONE, and only this one.
  const vocabularySql = migration('00097_');
  // The RENAME lives in 00088 and stays pinned there. Following it forward
  // would look like it still passed while quietly checking nothing: no later
  // migration renames anything, so `dropped` would be empty and the mapping
  // assertion would never run again.
  const renameSql = migration('00088_');
  // 00089 stays pinned for the same reason, in the other direction. Its own
  // "purely additive, therefore no rewrite of stored arrays" claim is asserted
  // below against 00088; moving this pointer to 00097 would silently retire that
  // assertion instead of extending it. 00097 makes the same claim and gets its
  // own assertion, chained off this one.
  const additiveSql = migration('00089_');

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
    const after = new Set(arrayLiteralAfter(additiveSql, 'players_permission_vocabulary_check'));
    expect(before.filter((capability) => !after.has(capability))).toEqual([]);
  });

  // 00097 makes the same claim as 00089 and is held to it the same way, chained
  // off the previous link rather than jumping back to 00088 — so the chain from
  // the last RENAME to the live list is unbroken, and every hop in it is
  // asserted to remove nothing.
  it('removes nothing in 00097 either, which is why it needs no rewrite', () => {
    const before = arrayLiteralAfter(additiveSql, 'players_permission_vocabulary_check');
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

  // ------------------------------------------------------------------
  // 00093 — the baselines table
  // ------------------------------------------------------------------
  // A THIRD COPY OF THE VOCABULARY exists as of 00093: permission_baselines
  // constrains its own `capabilities` array to the same strings. Two copies
  // in SQL can drift, and the direction this one drifts in is a baseline that
  // stores a string the code does not know and therefore hands out nothing. So
  // it is pinned exactly as the players copy is, against the same array.
  describe('the baselines table', () => {
    // TWO POINTERS, ON PURPOSE. 00093 created the table and owns the live
    // definition of guard_player_privileged_columns; 00097 re-adds only the
    // vocabulary CHECK. Following the guard assertion to 00097 would fail on a
    // missing function rather than on a real disagreement, and following the
    // vocabulary assertion back to 00093 would check a list that is no longer
    // the live one.
    const baselineGuardSql = migration('00093_');
    const baselineSql = migration('00097_');

    it('pins the same vocabulary the players columns pin', () => {
      const stored = arrayLiteralAfter(baselineSql, 'permission_baselines_vocabulary_check');
      expect(stored.length).toBe(CAPABILITIES.length);
      expect([...stored].sort()).toEqual([...CAPABILITIES].sort());
    });

    // The two SQL copies, compared to each other rather than only to the code.
    // Both assertions above could pass while the constraints were written in
    // different migrations against different builds; this one says they are the
    // same list today.
    it('agrees with the players vocabulary check', () => {
      const players = arrayLiteralAfter(vocabularySql, 'players_permission_vocabulary_check');
      const baselines = arrayLiteralAfter(baselineSql, 'permission_baselines_vocabulary_check');
      expect([...baselines].sort()).toEqual([...players].sort());
    });

    // THE GUARD IS REPLACED WHOLESALE by 00093 (CREATE OR REPLACE takes the
    // whole body), so the live definition is that file's — and everything 00087
    // protected has to still be in it. A column dropped in the copy is a guard
    // silently removed, which is the failure 00072's header describes.
    it('carries every guarded column forward and adds the baseline label', () => {
      const from = baselineGuardSql.indexOf(
        'CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns',
      );
      expect(from, '00093 must replace the guard').toBeGreaterThan(-1);
      const body = baselineGuardSql.slice(from);
      const [insertBranch, updateBranch] = body.split('IF TG_OP = \'INSERT\' THEN')[1]!
        .split('RETURN NEW;\n  END IF;');
      const columns = [
        'permission_role',
        'permission_grants',
        'permission_revokes',
        'permission_baseline_id',
      ];
      for (const column of columns) {
        expect(insertBranch!.includes(column), `INSERT branch misses ${column}`).toBe(true);
        expect(updateBranch!.includes(column), `UPDATE branch misses ${column}`).toBe(true);
      }
      // Everything 00087's UPDATE branch named, still named here. Read off that
      // file rather than listed by hand, so a column added to the guard later
      // cannot be dropped by the next replacement without this failing.
      const previous = sql.slice(
        sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns'),
      );
      for (const [, column] of previous.matchAll(/NEW\.([a-z_]+)\s+IS DISTINCT FROM/g)) {
        expect(updateBranch!.includes(`NEW.${column}`), `00093 dropped ${column}`).toBe(true);
      }
    });
  });
});
