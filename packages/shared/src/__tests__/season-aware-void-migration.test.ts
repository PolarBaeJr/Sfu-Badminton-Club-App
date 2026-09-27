import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00249, READ OFF DISK. Voiding a match from a past season must correct that
// season's archived final rating and leave the live `ratings` row alone; a
// current-season (or unassigned) match still moves the live rating.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00249_');
const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.reverse_match_result(p_match_id uuid)');
const body = sql.slice(start, sql.indexOf('$function$;', start));

describe('00249 season-aware reverse_match_result', () => {
  it('replaces reverse_match_result', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('treats only a match from a non-active season as past', () => {
    expect(body).toContain('SELECT id INTO v_active_season FROM seasons WHERE active_flag = TRUE LIMIT 1;');
    expect(body).toMatch(
      /v_past_season := v_match\.season_id IS NOT NULL\s+AND v_active_season IS NOT NULL\s+AND v_match\.season_id <> v_active_season;/,
    );
  });

  it('corrects the archived season row for a past match, and the live row otherwise', () => {
    const past = body.indexOf('IF v_past_season THEN');
    const other = body.indexOf('ELSE', past);
    expect(past).toBeGreaterThan(-1);
    expect(body.slice(past, other)).toContain('UPDATE season_final_ratings');
    expect(body.slice(past, other)).not.toContain('UPDATE ratings');
    expect(body.slice(other, body.indexOf('END IF;', other))).toContain('UPDATE ratings');
  });

  it('still refuses anything but a confirmed match and still voids it', () => {
    expect(body).toContain("IF v_match.result_status != 'confirmed' THEN RAISE EXCEPTION");
    expect(body).toContain("UPDATE matches SET result_status = 'voided'");
  });

  it('keeps execute away from PUBLIC, anon and authenticated', () => {
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public.reverse_match_result(uuid) FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('GRANT  EXECUTE ON FUNCTION public.reverse_match_result(uuid) TO service_role;');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('commits before reloading PostgREST', () => {
    expect(sql.indexOf('COMMIT;')).toBeGreaterThan(-1);
    expect(sql.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(sql.indexOf('COMMIT;'));
  });
});
