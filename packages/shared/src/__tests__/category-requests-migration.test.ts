import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00279, READ OFF DISK. Pins the properties its verify block checks at apply
// time, so a later edit to the file fails the suite before it reaches a
// database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00279_');
const previous = migration('00278_');

/** The body of one CREATE FUNCTION, from its header to the closing tag. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = source.indexOf('$function$;', start);
  return source.slice(start, end);
}

/** The (table, column) rows of a merge_players_disposable body. */
function disposableRows(source: string): string[] {
  const body = functionBody(source, 'merge_players_disposable');
  return [...body.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`).sort();
}

/** The CREATE TABLE statement for the request table. */
function tableDdl(): string {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS public.tournament_category_requests (');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(');', start));
}

const ADVISORY = "pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text))";

describe('00279: a category change after play is a request', () => {
  it('keeps the table to the service role: RLS on, no policy, no publication', () => {
    expect(sql).toContain('ALTER TABLE public.tournament_category_requests ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.tournament_category_requests FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT ALL ON TABLE public.tournament_category_requests TO service_role;');
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/ALTER PUBLICATION/i);
  });

  it('allows one pending request per team', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS tournament_category_requests_one_pending\s+ON public\.tournament_category_requests \(pair_id\) WHERE status = 'pending'/,
    );
  });

  it('names no member as the subject of a request, only the officers who asked and decided', () => {
    const ddl = tableDdl();
    expect(ddl).not.toMatch(/\bplayer_id\b/);
    // On the column's own line: the data-export parser reads it there.
    expect(ddl).toMatch(/^\s*requested_by\s+uuid REFERENCES public\.players\(id\) ON DELETE SET NULL,$/m);
    expect(ddl).toMatch(/^\s*resolved_by\s+uuid REFERENCES public\.players\(id\) ON DELETE SET NULL,$/m);
    expect(ddl).toContain("CHECK (length(btrim(reason)) BETWEEN 1 AND 500)");
    expect(ddl).toContain('CHECK (from_category IS DISTINCT FROM to_category)');
    expect(ddl).toContain("CHECK ((status = 'pending') = (resolved_at IS NULL))");
  });

  it('takes the field key before any row lock in the approver', () => {
    const body = functionBody(sql, 'approve_pair_category_request');
    const advisory = body.indexOf(ADVISORY);
    expect(advisory).toBeGreaterThan(-1);
    expect(body.indexOf('FOR UPDATE')).toBeGreaterThan(advisory);
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('refuses a stale category before it writes one', () => {
    const body = functionBody(sql, 'approve_pair_category_request');
    const stale = body.indexOf("'stale_category'");
    expect(stale).toBeGreaterThan(-1);
    expect(body.indexOf('UPDATE tournament_pairs SET team_category')).toBeGreaterThan(stale);
  });

  it('revokes both functions from anon and authenticated by name', () => {
    for (const sig of ['approve_pair_category_request(uuid, uuid)', 'merge_players_disposable()']) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('keeps all fourteen disposable rows from 00278 and adds both request columns', () => {
    const before = disposableRows(previous);
    expect(before).toHaveLength(14);
    expect(disposableRows(sql)).toEqual(
      [...before, 'tournament_category_requests.requested_by', 'tournament_category_requests.resolved_by'].sort(),
    );
  });

  it('verifies itself and says which migration failed', () => {
    expect(sql).toContain("RAISE EXCEPTION E'00279 verification failed:");
    expect(sql).toContain('merge_players_disposable()) <> 16');
    expect(sql).toMatch(/COMMIT;\s+NOTIFY pgrst, 'reload schema';\s*$/);
  });
});
