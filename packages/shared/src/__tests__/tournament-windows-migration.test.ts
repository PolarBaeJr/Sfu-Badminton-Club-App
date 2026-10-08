import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOW_STATE_CASES } from '../utils/tournament-windows';

// 00276, READ OFF DISK. entry_window_state and windowState are one rule written
// twice; this keeps them the same rule, and pins what the migration's verify
// block checks at apply time so a later edit fails before it reaches a database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(suffix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  if (!name) throw new Error(`no migration ending ${suffix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('_registration_and_checkin_windows.sql');

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
  const value = String.raw`(NULL|'[^']+')`;
  const row = new RegExp(String.raw`^\s*\(${value}, ${value}, '([^']+)', '(\w+)'\),?$`, 'gm');
  const lit = (v: string) => (v === 'NULL' ? null : v.slice(1, -1));
  return [...block.matchAll(row)].map((m) => ({
    opens: lit(m[1]!),
    closes: lit(m[2]!),
    now: m[3],
    expected: m[4],
  }));
}

describe('00276: registration and check-in windows', () => {
  it('proves the SQL rule against exactly the TypeScript table', () => {
    expect(proofCases()).toEqual(WINDOW_STATE_CASES);
  });

  it('raises on a mismatch rather than logging one', () => {
    const start = sql.indexOf('DO $proof$');
    expect(sql.slice(start, sql.indexOf('$proof$;', start + 10))).toContain("RAISE EXCEPTION '00276: ");
  });

  it('writes the rule once, as a pure function', () => {
    const rule = functionBody('entry_window_state');
    expect(rule).toContain('IMMUTABLE');
    expect(rule).toContain('SET search_path = public, pg_temp');
    expect(rule).toContain("WHEN p_opens IS NOT NULL AND p_now < p_opens THEN 'not_open_yet'");
    expect(rule).toContain("WHEN p_closes IS NOT NULL AND p_now >= p_closes THEN 'closed'");
  });

  it('gates self-entry off the locked rows, after the status refusal', () => {
    const body = functionBody('enter_tournament_event');
    expect(body).toContain('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;');
    expect(body).toMatch(/t\.registration_opens_at[^;]*FROM tournaments t WHERE t\.id = v_tournament FOR UPDATE/);
    expect(body).toMatch(/e\.event_type::TEXT[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE/);
    expect(body).toMatch(/e\.registration_opens_at[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE/);
    expect(body).toContain('v_reg_opens  := COALESCE(v_e_reg_opens, v_t_reg_opens);');
    expect(body).toContain('v_reg_closes := COALESCE(v_e_reg_closes, v_t_reg_closes);');
    expect(body.indexOf("'registration_not_open'")).toBeGreaterThan(body.indexOf("'registration_closed'"));
    expect(body).toContain("'registration_window_closed'");
  });

  it('gates only the member\'s own check-in, and reads the parent without a lock', () => {
    const body = functionBody('set_field_entry_status');
    expect(body).toContain("IF p_new_status = 'checked_in' AND p_actor IS NULL AND v_before <> 'checked_in' THEN");
    expect(body).toContain("'checkin_not_open'");
    expect(body).toContain("'checkin_window_closed'");
    expect(body).not.toMatch(/FROM\s+tournaments\b[\s\S]{0,200}FOR\s+(UPDATE|SHARE)/);
    // After the undo guard, before the write decision.
    expect(body.indexOf("'checkin_not_open'")).toBeGreaterThan(body.indexOf("'not_undoable'"));
    expect(body.indexOf("'checkin_not_open'")).toBeLessThan(body.indexOf('v_already := (v_before = p_new_status);'));
  });

  it('locks all three functions to service_role', () => {
    for (const sig of [
      'entry_window_state(timestamptz, timestamptz, timestamptz)',
      'enter_tournament_event(uuid, uuid, integer, boolean, text, text)',
      'set_field_entry_status(uuid, boolean, text, uuid)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('ends with one COMMIT and then the schema reload', () => {
    expect(sql.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(sql.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});
