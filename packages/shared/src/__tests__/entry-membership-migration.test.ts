import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRY_MEMBERSHIP_CASES } from '../utils/membership';

// 00260, READ OFF DISK. The SQL rule and the TypeScript rule are one table
// written twice; this is what keeps them the same table. It also pins the
// properties the migration's verify block checks at apply time, so a later edit
// fails the suite before it reaches a database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(suffix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  if (!name) throw new Error(`no migration ending ${suffix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('_internal_means_paid_dues.sql');

/** The body of one CREATE FUNCTION, from its header to the closing tag. */
function functionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
}

/** The VALUES rows of the $proof$ block, as the TypeScript table's shape. */
function proofCases() {
  const start = sql.indexOf('DO $proof$');
  const end = sql.indexOf('$proof$;', start + 10);
  expect(start).toBeGreaterThan(-1);
  const block = sql.slice(start, end);
  const row = /^\s*\('(\w+)', (true|false), (true|false), (true|false), '(\w+)'\),?$/gm;
  return [...block.matchAll(row)].map((m) => ({
    stored: m[1],
    exempt: m[2] === 'true',
    paid: m[3] === 'true',
    hasSeason: m[4] === 'true',
    expected: m[5],
  }));
}

describe('00260: internal means this season\'s club fee is paid', () => {
  it('proves the SQL rule against exactly the TypeScript table', () => {
    expect(proofCases()).toEqual(ENTRY_MEMBERSHIP_CASES);
  });

  it('raises on a mismatch rather than logging one', () => {
    const start = sql.indexOf('DO $proof$');
    expect(sql.slice(start, sql.indexOf('$proof$;', start + 10))).toContain("RAISE EXCEPTION '00260: ");
  });

  it('writes the rule once, as a pure function', () => {
    const rule = functionBody('entry_membership_rule');
    expect(rule).toContain('RETURNS membership_type');
    expect(rule).toContain('IMMUTABLE');
    expect(rule).toContain('SET search_path = public, pg_temp');
    expect(rule).toContain("WHEN p_stored = 'alumni' THEN 'alumni'::membership_type");
  });

  it('derives the group inside enter_tournament_event', () => {
    const body = functionBody('enter_tournament_event');
    expect(body).toContain('entry_membership_rule(');
    expect(body).toContain("f.fee_type = 'dues'");
    expect(body).toContain('f.paid_at IS NOT NULL');
    expect(body).toContain('t.season_id');
    expect(body).toContain('s.active_flag = TRUE');
    expect(body).toContain("'membership_unpaid'");
    expect(body).toContain("'membership_not_allowed'");
    expect(body).toContain('(COALESCE(p.is_exec, FALSE) OR COALESCE(p.fee_exempt, FALSE))');
    // The dues are read after the member's row is locked.
    expect(body.indexOf('FROM club_fees')).toBeGreaterThan(
      body.indexOf('FROM players p WHERE p.id = p_player_id FOR SHARE'),
    );
  });

  it('keeps both of 00200\'s lock lines byte-identical', () => {
    const body = functionBody('enter_tournament_event');
    expect(body).toContain('    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;');
    expect(body).toContain('    FROM players p WHERE p.id = p_player_id FOR SHARE;');
    expect(body.indexOf('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE')).toBeLessThan(
      body.indexOf('FROM players p WHERE p.id = p_player_id FOR SHARE'),
    );
  });

  it('keeps the signature and defaults 00200 left', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.enter_tournament_event(\n' +
        '  p_event_id    UUID,\n' +
        '  p_player_id   UUID,\n' +
        '  p_elo_before  INTEGER,\n' +
        '  p_doubles     BOOLEAN,\n' +
        '  p_waiver_hash TEXT DEFAULT NULL,\n' +
        '  p_user_agent  TEXT DEFAULT NULL\n' +
        ')',
    );
  });

  it('revokes both functions from PUBLIC, anon and authenticated, and grants service_role', () => {
    for (const sig of [
      'entry_membership_rule(membership_type, boolean, boolean, boolean)',
      'enter_tournament_event(uuid, uuid, integer, boolean, text, text)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('verifies, reloads the API schema, and commits', () => {
    expect(sql).toContain('DO $verify$');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
