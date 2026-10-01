import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00278, READ OFF DISK. Pins the properties its verify block checks at apply
// time, so a later edit to the file fails the suite before it reaches a
// database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const sql = migration('00278_');
const previousEnter = migration('00276_');

/** The body of one CREATE FUNCTION, from its header to the closing tag. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = source.indexOf('$function$;', start);
  return source.slice(start, end);
}

/** The capacity block of enter_tournament_event, up to the entry cap. */
function capacityBlock(body: string): string {
  const start = body.indexOf('-- ---- capacity');
  const end = body.indexOf('-- ---- per-member entry cap', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

const ADVISORY = "pg_advisory_xact_lock(hashtext('tournament_event_field')";
const TOURNAMENT_LOCK = 'FROM tournaments t WHERE t.id = v_tournament FOR UPDATE';
const EVENT_LOCK = 'FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE';

const SIGNATURES = [
  'fill_event_from_waitlist(uuid, uuid, uuid)',
  'join_event_waitlist(uuid, uuid, boolean, text, text)',
  'leave_event_waitlist(uuid, uuid)',
  'remove_from_event_waitlist(uuid, uuid)',
  'set_event_waitlist(uuid, boolean, boolean, uuid)',
  'enter_tournament_event(uuid, uuid, integer, boolean, text, text)',
  'merge_players_disposable()',
];

describe('00278: an optional waitlist per event', () => {
  it('adds the two switches, off and automatic by default', () => {
    expect(sql).toContain(
      'ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS waitlist_enabled boolean NOT NULL DEFAULT false;',
    );
    expect(sql).toContain(
      'ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS waitlist_auto_promote boolean NOT NULL DEFAULT true;',
    );
  });

  it('keeps the table to the service role, with one waiting row per member per event', () => {
    expect(sql).toContain('ALTER TABLE public.tournament_event_waitlist ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.tournament_event_waitlist FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT ALL ON TABLE public.tournament_event_waitlist TO service_role;');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS tournament_event_waitlist_one_waiting\s+ON public\.tournament_event_waitlist \(event_id, player_id\) WHERE status = 'waiting'/,
    );
  });

  it('takes the field key, then the tournament row, then the event row', () => {
    for (const name of ['fill_event_from_waitlist', 'join_event_waitlist', 'set_event_waitlist', 'enter_tournament_event']) {
      const body = functionBody(sql, name);
      const advisory = body.indexOf(ADVISORY);
      const tournament = body.indexOf(TOURNAMENT_LOCK);
      const event = body.indexOf(EVENT_LOCK);
      expect(advisory, `${name}: advisory key`).toBeGreaterThan(-1);
      expect(tournament, `${name}: tournament lock after the key`).toBeGreaterThan(advisory);
      expect(event, `${name}: event lock after the tournament`).toBeGreaterThan(tournament);
    }
    for (const name of ['leave_event_waitlist', 'remove_from_event_waitlist']) {
      const body = functionBody(sql, name);
      const advisory = body.indexOf(ADVISORY);
      expect(advisory, `${name}: advisory key`).toBeGreaterThan(-1);
      expect(body.indexOf('FOR UPDATE'), `${name}: row lock after the key`).toBeGreaterThan(advisory);
    }
  });

  it('counts the entry cap after the tournament lock in the fill', () => {
    const body = functionBody(sql, 'fill_event_from_waitlist');
    const count = body.indexOf('FROM tournament_participants tp');
    expect(count).toBeGreaterThan(body.indexOf(TOURNAMENT_LOCK));
    expect(body).toMatch(/max_events_per_player/);
  });

  it('leaves the event_full arithmetic as 00276 had it, adding only whether a waitlist exists', () => {
    const before = capacityBlock(functionBody(previousEnter, 'enter_tournament_event'));
    const after = capacityBlock(functionBody(sql, 'enter_tournament_event'));
    expect(after.replaceAll(", 'waitlist', COALESCE(v_waitlist, FALSE)", '')).toBe(before);
    expect(after.match(/'event_full', 'waitlist', COALESCE\(v_waitlist, FALSE\)/g)).toHaveLength(2);
  });

  it('refuses an entry while anybody is waiting, after the event lock and before capacity', () => {
    const body = functionBody(sql, 'enter_tournament_event');
    const queue = body.indexOf("'reason', 'waitlist_queue'");
    expect(queue).toBeGreaterThan(body.indexOf(EVENT_LOCK));
    expect(queue).toBeLessThan(body.indexOf('-- ---- capacity'));
    expect(body).toMatch(/e\.waitlist_enabled[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE/);
  });

  it('keeps the 00276 header of enter_tournament_event', () => {
    const header = (source: string) => {
      const body = functionBody(source, 'enter_tournament_event');
      return body.slice(0, body.indexOf('AS $function$'));
    };
    expect(header(sql)).toBe(header(previousEnter));
  });

  it('revokes every function from the client roles and grants it to service_role', () => {
    for (const sig of SIGNATURES) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(sql, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('keeps the twelve disposable rows from 00248 and adds both waitlist columns', () => {
    const body = functionBody(sql, 'merge_players_disposable');
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
        'tournament_event_waitlist.player_id',
        'tournament_event_waitlist.resolved_by',
      ].sort(),
    );
    const verify = sql.slice(sql.indexOf('DO $verify$'));
    expect(verify).toContain('FROM public.merge_players_unhandled()');
    expect(verify).toContain('<> 14');
  });

  it('commits once and ends by reloading the PostgREST schema', () => {
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});
