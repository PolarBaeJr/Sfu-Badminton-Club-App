import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, PERMISSION_ROLES } from '../access-level';

// REMOVAL IS A MIGRATION, made self-enforcing.
//
// Migration 00087 pins all 113 capability strings in a CHECK constraint, and
// that constraint is there for the REVOKES. An unknown element in `grants` is
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

describe('migration 00087 and the vocabulary', () => {
  const sql = migration('00087_');

  it('pins exactly the capabilities this build has', () => {
    const stored = arrayLiteralAfter(sql, 'players_permission_vocabulary_check');
    expect(stored.length).toBe(CAPABILITIES.length);
    expect([...stored].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('pins exactly the roles this build has', () => {
    // Written as `permission_role IN ('a', 'b', …)` rather than as an array, so
    // it is matched separately.
    const from = sql.indexOf('players_permission_role_check');
    const check = sql.slice(from, sql.indexOf(';', sql.indexOf('CHECK', from)));
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
