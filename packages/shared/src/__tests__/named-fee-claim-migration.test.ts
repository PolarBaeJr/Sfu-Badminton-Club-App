import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00252, READ OFF DISK. A named (manual) dues payment may carry an email, and a
// players row created with or changed to that email claims it, unless the
// member already has dues that season. The claim must never fail a signup.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00252_');
const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_named_fees_for_player()');
const body = sql.slice(start, sql.indexOf('$function$;', start));

describe('00252 named payments claimed by email', () => {
  it('refuses to run before 00249', () => {
    const pre = sql.slice(sql.indexOf('DO $pre$'), sql.indexOf('$pre$;'));
    expect(pre).toContain("proname = 'reverse_match_result'");
    expect(pre).toContain("prosrc LIKE '%season_final_ratings%'");
    expect(pre).toContain('RAISE EXCEPTION');
  });

  it('adds manual_email idempotently, only on a named dues row, in normalised form', () => {
    expect(sql).toContain('ALTER TABLE public.club_fees ADD COLUMN IF NOT EXISTS manual_email text;');
    expect(sql).toContain('ALTER TABLE public.club_fees DROP CONSTRAINT IF EXISTS club_fees_manual_email_shape;');
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT club_fees_manual_email_shape'), sql.indexOf('COMMENT ON COLUMN'));
    expect(check).toContain('manual_name IS NOT NULL');
    expect(check).toContain('player_id IS NULL');
    expect(check).toContain("fee_type = 'dues'");
    expect(check).toContain('manual_email = lower(btrim(manual_email))');
    expect(check).toContain('char_length(manual_email) <= 254');
  });

  it('allows one named payment per email per season', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS club_fees_manual_email_season_key\s+ON public\.club_fees \(season_id, lower\(manual_email\)\)\s+WHERE player_id IS NULL AND fee_type = 'dues' AND manual_email IS NOT NULL;/,
    );
  });

  it('skips empty and tombstoned addresses and unchanged updates', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("NEW.email LIKE '%@deleted.invalid'");
    expect(body).toContain("TG_OP = 'UPDATE' AND OLD.email IS NOT DISTINCT FROM NEW.email");
  });

  it('claims into player_id and clears both manual columns, but never over existing dues', () => {
    expect(body).toContain('SET player_id = NEW.id, manual_name = NULL, manual_email = NULL');
    expect(body).toContain('lower(f.manual_email) = NEW.email');
    const guard = body.slice(body.indexOf('AND NOT EXISTS'), body.indexOf('FOR UPDATE'));
    expect(guard).toContain('d.player_id = NEW.id');
    expect(guard).toContain("d.fee_type = 'dues'");
    expect(guard).toContain('d.season_id = f.season_id');
  });

  it('audits each claim and turns a failure into a warning, not a failed signup', () => {
    expect(body).toContain("'manual_fee_claimed', 'club_fee'");
    expect(body).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(body).toContain('RAISE WARNING');
    expect(body).toContain('RETURN NULL;');
  });

  it('is a locked-down SECURITY DEFINER trigger on players insert and email change', () => {
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.claim_named_fees_for_player() FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('DROP TRIGGER IF EXISTS claim_named_fees_trg ON public.players;');
    expect(sql).toMatch(
      /CREATE TRIGGER claim_named_fees_trg AFTER INSERT OR UPDATE OF email ON public\.players\s+FOR EACH ROW EXECUTE FUNCTION public\.claim_named_fees_for_player\(\);/,
    );
  });

  it('verifies itself and commits before reloading PostgREST', () => {
    expect(sql).toContain('DO $verify$');
    expect(sql.indexOf('COMMIT;')).toBeGreaterThan(sql.indexOf('DO $verify$'));
    expect(sql.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(sql.indexOf('COMMIT;'));
  });
});
