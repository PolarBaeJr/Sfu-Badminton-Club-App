import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00248, READ OFF DISK. Pins the properties its verify block checks at apply
// time, so a later edit to the file fails the suite before it reaches a
// database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00248_');

/** The body of one CREATE FUNCTION, from its header to the closing tag. */
function functionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
}

/** The CREATE TABLE statement for fee_submissions. */
function tableBody(): string {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS public.fee_submissions');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(');', start));
}

describe('00248: e-transfer receipts', () => {
  it('adds an event arm to the shape CHECK and keeps club_event_id out of the other three', () => {
    expect(sql).toContain("CHECK (fee_type IN ('dues', 'tournament', 'reinstatement', 'event'))");
    expect(sql).toMatch(/WHEN 'event' THEN club_event_id IS NOT NULL AND player_id IS NOT NULL/);
    for (const arm of ['dues', 'tournament', 'reinstatement']) {
      const start = sql.indexOf(`WHEN '${arm}' THEN`);
      const end = sql.indexOf('WHEN', start + 5);
      expect(sql.slice(start, end), arm).toContain('club_event_id IS NULL');
    }
    expect(sql).toContain('ELSE FALSE');
  });

  it('keeps one event fee per member per event', () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS club_fees_event_player_key\n  ON public.club_fees (club_event_id, player_id) WHERE fee_type = 'event';",
    );
  });

  it('adds payment_reminded_at to club_fees', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS payment_reminded_at timestamptz');
  });

  it('ties a submission to its fee through the composite key, ON UPDATE CASCADE', () => {
    expect(sql).toContain('UNIQUE (id, player_id)');
    expect(tableBody()).toContain(
      'FOREIGN KEY (club_fee_id, player_id)\n    REFERENCES public.club_fees (id, player_id) ON UPDATE CASCADE ON DELETE CASCADE',
    );
  });

  it('gives fee_submissions.player_id no key of its own to players', () => {
    const playerLine = tableBody()
      .split('\n')
      .find((l) => l.trim().startsWith('player_id'));
    expect(playerLine).toBeDefined();
    expect(playerLine).not.toContain('REFERENCES');
    // The one reference to players is reviewed_by.
    expect(tableBody().match(/REFERENCES public\.players/g)).toHaveLength(1);
    expect(tableBody()).toContain('reviewed_by     uuid REFERENCES public.players(id) ON DELETE SET NULL');
  });

  it('allows one pending submission per fee', () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS fee_submissions_one_pending\n  ON public.fee_submissions (club_fee_id) WHERE status = 'submitted';",
    );
  });

  it('lets members read their own and write nothing', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.fee_submissions FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT SELECT ON TABLE public.fee_submissions TO authenticated;');
    const policies = [...sql.matchAll(/CREATE POLICY (\w+) ON public\.fee_submissions\s+FOR (\w+)/g)];
    expect(policies.map((m) => m[2])).toEqual(['SELECT']);
    expect(sql).not.toMatch(/ON public\.fee_submissions\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it('makes fee-proofs private, 8 MiB, three image types, with one INSERT policy', () => {
    expect(sql).toMatch(/'fee-proofs',\s+'fee-proofs',\s+FALSE,\s+8388608,\s+ARRAY\['image\/jpeg', 'image\/png', 'image\/webp'\]/);
    const storagePolicies = [...sql.matchAll(/CREATE POLICY \w+ ON storage\.objects\s+FOR (\w+)/g)];
    expect(storagePolicies.map((m) => m[1])).toEqual(['INSERT']);
    expect(sql).toContain("(storage.foldername(name))[1] = auth.uid()::text");
  });

  it('revokes every new function from PUBLIC and anon', () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(fns.length).toBeGreaterThanOrEqual(6);
    for (const fn of fns) {
      expect(sql, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
    }
  });

  it('runs the review RPCs as SECURITY DEFINER for the service role only', () => {
    for (const fn of ['review_fee_submission_confirm', 'review_fee_submission_reject']) {
      const body = functionBody(fn);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`));
    }
  });

  it('closes the submission before it marks the fee paid', () => {
    const body = functionBody('review_fee_submission_confirm');
    const close = body.indexOf("SET status = 'confirmed'");
    const pay = body.indexOf("SET paid_at = now(), marked_by = p_actor, method = 'e_transfer'");
    expect(close).toBeGreaterThan(-1);
    expect(pay).toBeGreaterThan(close);
  });

  it('answers the Paid badge with a boolean, for members and not anon', () => {
    const body = functionBody('player_season_paid');
    expect(body).toContain('RETURNS boolean');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(body).toContain("<> 'waived'");
    expect(body).toContain('NOT coalesce(p.is_exec, FALSE)');
    expect(body).toContain('NOT coalesce(p.fee_exempt, FALSE)');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.player_season_paid(uuid) FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.player_season_paid(uuid) TO authenticated, service_role;');
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.player_season_paid\(uuid\) TO[^;]*anon/);
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    expect(verify).toContain("has_function_privilege('anon', 'public.player_season_paid(uuid)', 'EXECUTE')");
  });

  it('files an event fee without clobbering one already there', () => {
    expect(functionBody('club_event_signup_fee')).toContain(
      "ON CONFLICT (club_event_id, player_id) WHERE fee_type = 'event' DO NOTHING",
    );
  });

  it('keeps the eleven disposable rows from 00244 and adds fee_submissions.reviewed_by', () => {
    const body = functionBody('merge_players_disposable');
    const rows = [...body.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(rows.sort()).toEqual(
      [
        'notifications.player_id',
        'push_subscriptions.player_id',
        'calendar_feed_tokens.player_id',
        'ratings.player_id',
        'reliability_metrics.player_id',
        'discord_outbox.requested_by',
        'data_api_consumers.created_by',
        'data_api_keys.minted_by',
        'data_api_keys.revoked_by',
        'club_event_signups.player_id',
        'club_events.created_by',
        'fee_submissions.reviewed_by',
      ].sort(),
    );
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    expect(verify).toContain('FROM public.merge_players_unhandled()');
    expect(verify).toContain('<> 12');
  });

  it('refuses to run before 00247', () => {
    expect(sql).toContain('00248: apply 00247 first');
  });
});
