import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00254, READ OFF DISK. A guest with no account signs the waiver and privacy
// policy. It is a deliberate anonymous write path, and everything that keeps
// it narrow is a line in this file: the function is service_role only, the
// table is readable by service_role only and writable by nobody, the versions
// are the database's, and a signing names no member.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00254_');
// Comments stripped, so the prose header cannot satisfy or trip an assertion.
const code = sql.replace(/--[^\n]*/g, '');
const SIGNATURE = 'public.sign_guest_waiver(text, text, boolean, text, text, text)';
const fnStart = code.indexOf('CREATE OR REPLACE FUNCTION public.sign_guest_waiver(');
const fn = code.slice(fnStart, code.indexOf('$function$;', fnStart));
const header = fn.slice(0, fn.indexOf('AS $function$'));
const tableStart = code.indexOf('CREATE TABLE IF NOT EXISTS public.guest_waiver_signings (');
const table = code.slice(tableStart, code.indexOf('\n);', tableStart));

describe('00254 guests sign the waiver', () => {
  it('finds the function and the table', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(tableStart).toBeGreaterThan(-1);
  });

  it('pins the function as SECURITY DEFINER with a fixed search_path', () => {
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain('SET search_path = public, pg_temp');
  });

  it('revokes the function from PUBLIC, anon and authenticated, and grants only service_role', () => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM PUBLIC, anon, authenticated;`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role;`);
    const grants = [...code.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*;/g)].map((m) => m[0]);
    expect(grants).toEqual([`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO service_role;`]);
  });

  it('locks the table: RLS on, no policy, SELECT to service_role and nothing else', () => {
    expect(code).toContain('ALTER TABLE public.guest_waiver_signings ENABLE ROW LEVEL SECURITY;');
    expect(code).not.toMatch(/CREATE\s+POLICY/i);
    expect(code).toContain(
      'REVOKE ALL ON TABLE public.guest_waiver_signings FROM PUBLIC, anon, authenticated, service_role;',
    );
    const tableGrants = [...code.matchAll(/GRANT\s+[A-Z, ]+\s+ON\s+(?:TABLE\s+)?public\.guest_waiver_signings[^;]*;/g)].map(
      (m) => m[0],
    );
    expect(tableGrants).toEqual(['GRANT SELECT ON TABLE public.guest_waiver_signings TO service_role;']);
    expect(code).not.toMatch(/GRANT\s+[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*guest_waiver_signings/);
  });

  it('refuses a row without the age attestation and a token of the wrong shape', () => {
    expect(table).toContain('CHECK (age_attestation IS TRUE)');
    expect(table).toContain("CHECK (token ~ '^[0-9a-f]{48}$')");
    expect(table).toContain("ip_hash ~ '^[0-9a-f]{64}$'");
  });

  // deleted-identity.test.ts reads a `player_id` line as purge coverage, and
  // the member export classes this table as not about players.
  it('names no member: no player_id column and no foreign key', () => {
    expect(table).not.toMatch(/^\s*player_id\b/m);
    expect(table).not.toContain('REFERENCES');
  });

  it('reads the versions from legal_documents and takes none from the caller', () => {
    expect(fn).toContain("FROM public.legal_documents d WHERE d.document = 'waiver'");
    expect(fn).toContain("FROM public.legal_documents d WHERE d.document = 'privacy_policy'");
    expect(header).not.toMatch(/p_\w*version/);
  });

  it('serialises per email, dedupes a resubmit, and throttles by email and by IP', () => {
    expect(fn).toContain("pg_advisory_xact_lock(hashtext('guest_waiver:' || v_email))");
    expect(fn).toContain("g.accepted_at > now() - interval '10 minutes'");
    // The name must match too, or an email alone would reveal a stranger's name.
    expect(fn).toMatch(/WHERE g\.email = v_email\s+AND g\.full_name = v_name/);
    expect(fn).toContain("interval '24 hours') >= 5");
    expect(fn).toContain("interval '1 hour') >= 60");
    expect(fn).toContain('p_ip_hash IS NOT NULL');
    for (const hint of ['guest_waiver_age', 'guest_waiver_no_document', 'guest_waiver_email_limit', 'guest_waiver_ip_limit']) {
      expect(fn).toContain(`HINT = '${hint}'`);
    }
  });

  it('verifies before it commits and reloads PostgREST after', () => {
    const verify = code.indexOf('DO $verify$');
    const commit = code.indexOf('COMMIT;');
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(commit);
    expect(code.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(commit);
  });

  // pgcrypto lives in `extensions`, which the pinned search_path excludes.
  it('uses no pgcrypto', () => {
    expect(code).not.toContain('extensions.');
    expect(code).not.toContain('digest(');
  });
});
