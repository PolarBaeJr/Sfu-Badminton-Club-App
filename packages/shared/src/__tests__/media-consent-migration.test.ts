import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00255, READ OFF DISK. Photo and video consent: off unless turned on, the
// time owned by the database, a member switch that works whatever their
// standing, and a guest switch reached only through the service role.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00255_');
// Comments stripped, so the prose header cannot satisfy or trip an assertion.
const code = sql.replace(/--[^\n]*/g, '');

function fnBody(name: string): { fn: string; header: string } {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const fn = code.slice(start, code.indexOf('$function$;', start));
  return { fn, header: fn.slice(0, fn.indexOf('AS $function$')) };
}

const stamp = fnBody('stamp_media_consent_changed_at');
const member = fnBody('set_my_media_consent');
const guest = fnBody('set_guest_media_consent');
const MEMBER_SIG = 'public.set_my_media_consent(boolean)';
const GUEST_SIG = 'public.set_guest_media_consent(text, boolean)';

describe('00255 photo and video consent', () => {
  it('finds all three functions', () => {
    expect(stamp.fn.length).toBeGreaterThan(0);
    expect(member.fn.length).toBeGreaterThan(0);
    expect(guest.fn.length).toBeGreaterThan(0);
  });

  it('adds both columns to both tables, off by default', () => {
    for (const table of ['players', 'guest_waiver_signings']) {
      expect(code).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS media_consent boolean NOT NULL DEFAULT false,\\s+ADD COLUMN IF NOT EXISTS media_consent_changed_at timestamptz;`,
        ),
      );
    }
  });

  it('requires a time whenever consent is on, on both tables', () => {
    expect(code).toContain(
      'ADD CONSTRAINT players_media_consent_has_time\n  CHECK (NOT media_consent OR media_consent_changed_at IS NOT NULL);',
    );
    expect(code).toContain(
      'ADD CONSTRAINT guest_waiver_signings_media_consent_has_time\n  CHECK (NOT media_consent OR media_consent_changed_at IS NOT NULL);',
    );
  });

  it('stamps the time with a plain trigger function on both tables', () => {
    expect(stamp.header).not.toContain('SECURITY DEFINER');
    expect(stamp.fn).toContain('NEW.media_consent_changed_at := now();');
    expect(stamp.fn).toContain('NEW.media_consent_changed_at := OLD.media_consent_changed_at;');
    for (const table of ['players', 'guest_waiver_signings']) {
      expect(code).toContain(
        `CREATE TRIGGER stamp_media_consent_trg\n  BEFORE INSERT OR UPDATE ON public.${table}\n  FOR EACH ROW EXECUTE FUNCTION public.stamp_media_consent_changed_at();`,
      );
    }
  });

  it('pins the member switch: SECURITY DEFINER, fixed search_path, no player id', () => {
    expect(member.header).toContain('public.set_my_media_consent(p_consent boolean)');
    expect(member.header).toContain('SECURITY DEFINER');
    expect(member.header).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(member.fn).toContain('public.get_player_id(auth.uid())');
  });

  // A pending, suspended or banned member must always be able to withdraw.
  it('checks no standing in the member switch', () => {
    expect(member.fn).not.toMatch(/is_banned|status|active_flag/);
  });

  it('grants the member switch to authenticated and service_role only', () => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION ${MEMBER_SIG} FROM PUBLIC, anon, authenticated;`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${MEMBER_SIG} TO authenticated, service_role;`);
  });

  it('grants the guest switch to service_role only, and checks the token shape', () => {
    expect(guest.header).toContain('SECURITY DEFINER');
    expect(guest.header).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(code).toContain(`REVOKE ALL ON FUNCTION ${GUEST_SIG} FROM PUBLIC, anon, authenticated;`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${GUEST_SIG} TO service_role;`);
    expect(guest.fn).toContain("p_token !~ '^[0-9a-f]{48}$'");
    expect(guest.fn).toContain("HINT = 'guest_media_consent_not_found'");
    const grants = [...code.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*;/g)].map((m) => m[0]);
    expect(grants).toEqual([
      `GRANT EXECUTE ON FUNCTION ${MEMBER_SIG} TO authenticated, service_role;`,
      `GRANT EXECUTE ON FUNCTION ${GUEST_SIG} TO service_role;`,
    ]);
  });

  // players_select opens any approved member's row to every member, so the
  // column grant is the only privacy there is.
  it('spreads a guest withdrawal to every signing under the email, but never a consent', () => {
    expect(guest.fn).toMatch(
      /IF NOT p_consent THEN\s+UPDATE public\.guest_waiver_signings g\s+SET media_consent = false\s+WHERE g\.email = v_email/,
    );
    expect(guest.fn).not.toMatch(/SET media_consent = true/);
  });

  it('grants members no column privilege on players', () => {
    expect(code).not.toMatch(/GRANT\s+UPDATE\s*\(/);
    expect(code).not.toMatch(/GRANT\s+SELECT\s*\(/);
  });

  it('leaves the privileged-column guard and the signing function alone, and drops nothing', () => {
    expect(code).not.toContain('guard_player_privileged_columns');
    expect(code).not.toContain('sign_guest_waiver(');
    expect(code).not.toMatch(/DROP\s+FUNCTION/i);
  });

  it('verifies before it commits and reloads PostgREST after', () => {
    const verify = code.indexOf('DO $verify$');
    const commit = code.indexOf('COMMIT;');
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(commit);
    expect(code.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(commit);
  });
});
