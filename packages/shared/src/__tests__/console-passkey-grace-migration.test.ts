import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00262, READ OFF DISK. Pins the properties its verify block checks at apply
// time, so a later edit to the file fails the suite before it reaches a
// database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00262_');

function body(signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
}

describe('00262: a console passkey is required after two weeks', () => {
  it('refuses to run without admin_access_level and passkey_credentials', () => {
    expect(sql).toContain("to_regprocedure('public.admin_access_level(uuid)') IS NULL");
    expect(sql).toContain("to_regclass('public.passkey_credentials') IS NULL");
  });

  it('stores only the start, keyed on the auth user, with no foreign key at all', () => {
    const ddl = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS public.console_passkey_grace'),
      sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS public.console_passkey_grace')),
    );
    expect(ddl).toContain('user_id    uuid PRIMARY KEY');
    expect(ddl).toContain('started_at timestamptz NOT NULL DEFAULT now()');
    expect(ddl).not.toMatch(/REFERENCES/i);
  });

  it('is readable by service_role alone', () => {
    expect(sql).toContain('ALTER TABLE public.console_passkey_grace ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.console_passkey_grace FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(sql).toContain('GRANT SELECT ON TABLE public.console_passkey_grace TO service_role;');
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('answers only for the caller, counting console passkeys only', () => {
    const fn = body('public.console_passkey_grace_start()');
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(fn).toContain('v_uid     uuid := auth.uid();');
    expect(fn).toContain("IF v_uid IS NULL THEN\n    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';");
    expect(fn).toContain("pc.enrolled_via = 'admin'");
    // No row for someone without console access: the check comes before the
    // only INSERT.
    const accessCheck = fn.indexOf('public.admin_access_level(v_uid) IS NULL');
    expect(accessCheck).toBeGreaterThan(-1);
    expect(accessCheck).toBeLessThan(fn.indexOf('INSERT INTO console_passkey_grace'));
  });

  it('is executable by authenticated and nobody less', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.console_passkey_grace_start() FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.console_passkey_grace_start() TO authenticated;');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.reset_console_passkey_grace() FROM PUBLIC, anon, authenticated;',
    );
  });

  it('resets the window when console access is lost, the login changes or the row goes', () => {
    const fn = body('public.reset_console_passkey_grace()');
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain("TG_OP = 'DELETE'");
    expect(fn).toContain('NEW.user_id IS DISTINCT FROM OLD.user_id');
    expect(fn).toContain('DELETE FROM public.console_passkey_grace WHERE user_id = OLD.user_id;');
    expect(sql).toContain(
      'AFTER UPDATE OF role, is_exec, is_trainer, user_id OR DELETE ON public.players',
    );
  });

  it('verifies itself before committing', () => {
    const verify = sql.slice(sql.indexOf('DO $verify$'), sql.indexOf('$verify$;'));
    expect(verify).toContain('relrowsecurity');
    expect(verify).toContain("has_table_privilege('anon', 'public.console_passkey_grace', 'SELECT')");
    expect(verify).toContain("has_table_privilege('service_role', 'public.console_passkey_grace', 'SELECT')");
    expect(verify).toContain("has_function_privilege('anon', v_fn, 'EXECUTE')");
    expect(verify).toContain("has_function_privilege('authenticated', v_fn, 'EXECUTE')");
    expect(verify).toContain("v_acl ~ '(^|[{,])=X'");
    expect(verify).toContain("tgname = 'reset_console_passkey_grace_trg'");
  });

  it('commits, then reloads the PostgREST schema', () => {
    expect(sql).toMatch(/COMMIT;\s*\n\s*NOTIFY pgrst, 'reload schema';\s*$/);
  });

  it('has no em dash', () => {
    expect(sql).not.toContain('—');
  });
});
