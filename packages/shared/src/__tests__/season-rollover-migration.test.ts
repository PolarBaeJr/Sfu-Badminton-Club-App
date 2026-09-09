import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00261, READ OFF DISK. A daily pg_cron job hands the season over once the
// active one has ended and a successor has started. It must stay out of reach
// of client keys, never pick a rating-rewriting policy on its own, and be safe
// to re-run.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00261_');
const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.auto_rollover_season()');
const body = sql.slice(start, sql.indexOf('$function$;', start));

describe('00261 automatic season rollover', () => {
  it('exists once, under its release number', () => {
    expect(start).toBeGreaterThan(-1);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('_seasons_roll_over_on_their_own.sql'));
    expect(files).toEqual(['00261_seasons_roll_over_on_their_own.sql']);
  });

  it('keeps execute away from PUBLIC, anon and authenticated', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.auto_rollover_season() FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.auto_rollover_season() TO service_role;');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it("reads today in the club's timezone, not UTC", () => {
    expect(body).toContain("v_today := (NOW() AT TIME ZONE 'America/Vancouver')::date;");
    expect(body).not.toMatch(/current_date/i);
  });

  it('only rolls an ended season into a successor that has started after it', () => {
    expect(body).toContain('IF v_prev.end_date IS NULL OR v_prev.end_date >= v_today THEN');
    expect(body).toContain('AND start_date <= v_today');
    expect(body).toContain('AND start_date >  v_prev.start_date');
    expect(body).toContain('ORDER BY start_date ASC, created_at ASC');
  });

  it('defaults to carry and refuses an unknown policy instead of falling back', () => {
    expect(body).toContain("COALESCE(value->>'auto_rollover_policy', 'carry')");
    expect(body).toMatch(/IF v_policy NOT IN \('carry', 'soft', 'full'\) THEN\s+RAISE EXCEPTION/);
    expect(body).toContain('PERFORM activate_season(v_next.id, v_policy);');
  });

  it('does not overwrite settings a re-run finds already chosen', () => {
    expect(sql).toMatch(/SET value = jsonb_build_object\([\s\S]*?\) \|\| value,/);
  });

  it('reschedules idempotently at 09:10 UTC', () => {
    expect(sql).toContain(
      "SELECT cron.unschedule('season-rollover')\n WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'season-rollover');",
    );
    expect(sql).toMatch(/cron\.schedule\(\s*'season-rollover',\s*'10 9 \* \* \*',/);
    expect(sql.indexOf("cron.unschedule('season-rollover')")).toBeLessThan(
      sql.indexOf("cron.schedule(\n  'season-rollover'"),
    );
  });

  it('commits before reloading PostgREST', () => {
    expect(sql.indexOf('COMMIT;')).toBeGreaterThan(-1);
    expect(sql.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(sql.indexOf('COMMIT;'));
  });
});
