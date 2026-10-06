import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00273, READ OFF DISK. A tournament's own courts: a private table, a court_id
// on matches kept in step with the members' text by trigger, and one live match
// per court enforced by a partial unique index.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00273_');
// Comments stripped, so the prose header cannot satisfy or trip an assertion.
const code = sql.replace(/--[^\n]*/g, '');

function fnHeader(name: string): string {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return code.slice(start, code.indexOf('AS $function$', start));
}

describe('00273 tournament courts', () => {
  it('is one transaction, and reloads PostgREST after it', () => {
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(code.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(code.indexOf('COMMIT;'));
  });

  it('keeps tournament_courts private', () => {
    expect(code).toContain('ALTER TABLE public.tournament_courts ENABLE ROW LEVEL SECURITY;');
    expect(code).toContain('REVOKE ALL ON public.tournament_courts FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('GRANT ALL ON public.tournament_courts TO service_role;');
    expect(code).not.toMatch(/CREATE POLICY/i);
    expect(code).not.toMatch(/ALTER PUBLICATION/i);
  });

  it('caps a label at 20 characters and backs the app check with a unique index', () => {
    expect(code).toContain('CHECK (length(btrim(label)) BETWEEN 1 AND 20)');
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS tournament_courts_label_key\s+ON public\.tournament_courts \(tournament_id, lower\(btrim\(label\)\)\);/);
  });

  it('allows one live match per court', () => {
    expect(code).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS tournament_matches_one_live_per_court\s+ON public\.tournament_matches \(court_id\) WHERE status = 'live' AND court_id IS NOT NULL;/,
    );
  });

  it('links a match to a court and lets the court go without losing the match', () => {
    expect(code).toContain('ADD COLUMN IF NOT EXISTS court_id uuid REFERENCES public.tournament_courts(id) ON DELETE SET NULL');
  });

  it('syncs the text on writes to either column, and a rename onto unfinished matches', () => {
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OF court_id, court ON public\.tournament_matches/);
    expect(code).toMatch(/AFTER UPDATE OF label ON public\.tournament_courts/);
    expect(code).toContain("AND status IN ('pending', 'ready', 'live')");
  });

  it('runs both trigger functions as definer with a pinned search_path, service_role only', () => {
    for (const name of ['tournament_matches_court_sync', 'tournament_courts_label_sync']) {
      const header = fnHeader(name);
      expect(header).toContain('SECURITY DEFINER');
      expect(header).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${name}() TO service_role;`);
    }
  });

  it('refuses a court of another tournament', () => {
    expect(code).toContain("RAISE EXCEPTION 'That court belongs to another tournament'");
  });

  it('adds no player foreign key, so merge_players is unaffected', () => {
    expect(code).not.toMatch(/REFERENCES public\.players/i);
  });

  it('ends with a verify block that raises on failure', () => {
    const verify = code.slice(code.indexOf('DO $verify$'));
    expect(verify).toContain('00273 verification failed');
    expect(verify).toContain('has_table_privilege');
    expect(verify).toContain('relrowsecurity');
    expect(verify).toContain('supabase_realtime');
    expect(code.indexOf('DO $verify$')).toBeLessThan(code.indexOf('COMMIT;'));
  });
});
