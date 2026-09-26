import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00253, READ OFF DISK. Pins the properties its verify block checks at apply
// time, so a later edit to the file fails the suite before it reaches a
// database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00253_');

function confirmBody(): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
}

describe('00253: a receipt says how it was paid', () => {
  it('refuses to run before 00248 and 00252', () => {
    expect(sql).toContain("to_regclass('public.fee_submissions') IS NULL");
    expect(sql).toContain("RAISE EXCEPTION '00253: apply 00248 first'");
    expect(sql).toContain("proname = 'claim_named_fees_for_player'");
    expect(sql).toContain("RAISE EXCEPTION '00253: apply 00252 first'");
  });

  it('adds fee_submissions.method, defaulting to e_transfer, NULL or one of two', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS method text DEFAULT 'e_transfer';");
    expect(sql).toContain("CHECK (method IS NULL OR method IN ('e_transfer', 'sfu_rec'))");
  });

  it('allows a short reference on anything not stored as an e-transfer', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS fee_submissions_reference_check;');
    expect(sql).toContain("reference ~ '^[A-Za-z0-9-]{6,32}$'");
    expect(sql).toContain(
      "OR (method IS DISTINCT FROM 'e_transfer' AND reference ~ '^[A-Za-z0-9-]{4,32}$')",
    );
    // The column exists before the CHECK that reads it.
    expect(sql.indexOf('ADD COLUMN IF NOT EXISTS method')).toBeLessThan(
      sql.indexOf('ADD CONSTRAINT fee_submissions_reference_check'),
    );
  });

  it('drops the two-argument confirm before creating the three-argument one', () => {
    const drop = sql.indexOf('DROP FUNCTION IF EXISTS public.review_fee_submission_confirm(uuid, uuid);');
    const create = sql.indexOf('CREATE OR REPLACE FUNCTION public.review_fee_submission_confirm(');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(confirmBody()).toContain('p_method text DEFAULT NULL');
  });

  it('runs confirm as SECURITY DEFINER with a pinned search_path', () => {
    const body = confirmBody();
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('asks for a method when none is known, and keeps SFU Rec to dues', () => {
    const body = confirmBody();
    expect(body).toContain('v_method := coalesce(p_method, v_sub.method);');
    expect(body).toContain("IF v_method IS NULL THEN RETURN 'needs_method'; END IF;");
    expect(body).toContain("IF v_method NOT IN ('e_transfer', 'sfu_rec') THEN RETURN 'bad_method'; END IF;");
    expect(body).toContain("IF v_method = 'sfu_rec' AND v_fee.fee_type <> 'dues' THEN RETURN 'bad_method'; END IF;");
  });

  it('confirms a short reference only as SFU Rec, with its own refusal', () => {
    expect(confirmBody()).toMatch(
      /IF v_sub\.reference !~ '\^\[A-Za-z0-9-\]\{6,32\}\$' AND v_method <> 'sfu_rec' THEN\s+RETURN 'short_reference';/,
    );
  });

  it('closes the submission before it marks the fee paid, with the method on both', () => {
    const body = confirmBody();
    const close = body.indexOf("SET status = 'confirmed', reviewed_at = now(), reviewed_by = p_actor, method = v_method");
    const pay = body.indexOf('SET paid_at = now(), marked_by = p_actor, method = v_method, reference = v_sub.reference');
    expect(close).toBeGreaterThan(-1);
    expect(pay).toBeGreaterThan(close);
    expect(body).not.toContain("method = 'e_transfer'");
  });

  it('revokes confirm from PUBLIC, anon and authenticated and grants it to the service role', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text) FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.review_fee_submission_confirm(uuid, uuid, text) TO service_role;',
    );
  });

  it('verifies one overload, its arguments, its grants and both constraints', () => {
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    expect(verify).toContain("proname = 'review_fee_submission_confirm'");
    expect(verify).toContain('<> 1 THEN');
    expect(verify).toContain("'p_submission_id uuid, p_actor uuid, p_method text'");
    expect(verify).toContain("'search_path=public, pg_temp' = ANY (v_cfg)");
    expect(verify).toContain("v_acl ~ '(^|[{,])=X'");
    expect(verify).toContain("has_function_privilege('service_role', v_fn, 'EXECUTE')");
    expect(verify).toContain("conname = 'fee_submissions_method_check'");
    expect(verify).toContain("conname = 'fee_submissions_reference_check'");
  });

  it('commits, then reloads the PostgREST schema', () => {
    expect(sql.trimEnd()).toMatch(/COMMIT;\s+NOTIFY pgrst, 'reload schema';$/);
  });

  it('has no em dash', () => {
    expect(sql).not.toContain('\u2014');
  });
});
