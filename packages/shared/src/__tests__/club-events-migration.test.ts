import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00244, READ OFF DISK. The properties below are the ones the file's own
// verify block checks at apply time; pinning them here means a later edit to
// the file fails the suite before it ever reaches a database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00244_');

/** The body of one CREATE FUNCTION, from its header to the closing tag. */
function functionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
}

const LOCK = 'SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;';
const COUNT = 'SELECT count(*) INTO v_taken FROM public.club_event_signups WHERE event_id = p_event_id;';
const INSERT = 'INSERT INTO public.club_event_signups (event_id, player_id) VALUES (p_event_id, p_player_id);';

describe('00244: club events', () => {
  for (const name of ['club_event_sign_up', 'club_event_withdraw']) {
    it(`${name} is SECURITY DEFINER with a pinned search_path`, () => {
      const body = functionBody(name);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    });

    it(`${name} is revoked from PUBLIC, anon and authenticated`, () => {
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${name}(uuid, uuid) FROM PUBLIC, anon, authenticated;`,
      );
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(uuid, uuid) TO service_role;`);
    });
  }

  it('signs up by locking the event, then counting, then inserting', () => {
    const body = functionBody('club_event_sign_up');
    const lock = body.indexOf(LOCK);
    const count = body.indexOf(COUNT);
    const insert = body.indexOf(INSERT);
    expect(lock).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(count);
    // The verify block checks the same three statements in the live function.
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    for (const statement of [LOCK, COUNT, INSERT]) expect(verify).toContain(statement);
  });

  it('keeps the nine disposable rows from 00242, adds the two club event ones, and not digest_deliveries', () => {
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
      ].sort(),
    );
    expect(body).not.toContain('digest_deliveries');
  });

  it('asserts the merge guard is empty before it commits', () => {
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    expect(verify).toContain('FROM public.merge_players_unhandled()');
  });

  it('refuses to run before 00242', () => {
    expect(sql).toContain("WHERE tbl = 'discord_outbox' AND col = 'requested_by'");
    expect(sql).toContain('00244: apply 00242 first');
  });
});
