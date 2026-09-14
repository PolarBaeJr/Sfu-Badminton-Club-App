import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// LINKING A DISCORD ACCOUNT FROM THE CONSOLE, which 00165 left with no admin
// path at all: the only way a link row appeared was the member running /link
// and spending a token.
//
// What is pinned here is what makes that safe to hand to an officer. Only a
// holder of the capability may do it, the id is validated rather than trusted
// because it arrives as a client-controlled POST field, a snowflake belonging
// to somebody else is refused by name rather than by constraint error, and the
// account being DISPLACED is recorded in the audit row's reason: the tombstone
// naming it is deleted by the bot the moment the sweep clears it, and a
// degraded audit retry drops old_value/new_value, so the reason is the one
// place it reliably survives.
//
// WHAT THIS FILE CANNOT PROVE, stated so nobody mistakes a green run for it:
// PostgREST is mocked, so the trigger that tombstones the displaced account
// never executes here. That the write is one upsert conflicting on player_id,
// rather than a delete-then-insert, is argued at the call site and is not
// testable in this repo.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
}));

// The elo-review-resolve harness, EXTENDED. That one implements select, insert,
// update, eq and single, with no upsert and no constraint of any kind, which
// would make every assertion below vacuous: the action's only write is an
// upsert, and two of these cases are about a UNIQUE index refusing one.
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
    let payload: Row = {};
    let conflictColumn: string | null = null;

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): {
      data: Row[] | null;
      error: { message: string; code?: string } | null;
    } => {
      // THE UNIQUE INDEX ON discord_user_id, enforced before anything is
      // written so a refusal leaves the table untouched, which is what the
      // refusal cases assert. Shaped like a PostgREST error rather than thrown,
      // because supabase-js RESOLVES with { error } instead of rejecting, and
      // an action that forgot to read `error` has to fail here.
      if (op === 'insert' || op === 'upsert') {
        if (table === 'player_discord_links' && payload.discord_user_id !== undefined) {
          const clash = (store.db[table] ?? []).find(
            (r) =>
              r.discord_user_id === payload.discord_user_id
              && r.player_id !== payload.player_id,
          );
          if (clash) {
            return {
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "player_discord_links_discord_user_id_key"',
              },
            };
          }
        }
      }
      if (op === 'upsert') {
        const rows = (store.db[table] ??= []);
        // ON CONFLICT (<column>) DO UPDATE: the matching row is replaced in
        // place rather than added beside, which is the whole difference between
        // this and an insert.
        const existing = conflictColumn
          ? rows.find((r) => r[conflictColumn!] === payload[conflictColumn!])
          : undefined;
        if (existing) {
          Object.assign(existing, payload);
          return { data: [existing], error: null };
        }
        rows.push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      upsert(p: Row, opts?: { onConflict?: string }) {
        op = 'upsert';
        payload = p;
        conflictColumn = opts?.onConflict ?? null;
        return api;
      },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      // A COPY, for the reason the sibling harness gives: a shared reference
      // would make the "what it was" audit snapshot read back as "what it is".
      async single() {
        const res = run();
        const hit = res.data?.[0];
        return hit
          ? { data: { ...hit }, error: null }
          : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
      },
      // Absent from the harness this was copied from, and every read the action
      // makes uses it. No row is an ANSWER here, not an error.
      async maybeSingle() {
        const res = run();
        const hit = res.data?.[0];
        return hit ? { data: { ...hit }, error: null } : { data: null, error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));

// The real resolver, against the actor's real row.
vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permissionsOf, permits } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(store.actor);
      if (!permits(level, permissionsOf(level, store.actor), capability)) {
        throw new Error(`Missing capability: ${capability}`);
      }
      return store.actor;
    },
  };
});

import { forceLinkDiscordAccount, previewDiscordForceLink } from '../actions/players';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const PLAIN = 'bbbbbbbb-0000-4000-8000-000000000003';

const SNOWFLAKE = '214300000000000000';
const OLD_SNOWFLAKE = '109900000000000000';
const OTHERS_SNOWFLAKE = '330000000000000000';

const person = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: `Person ${id.slice(0, 4)}`,
  role: 'player',
  is_exec: false,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
  ...extra,
});

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const links = () => store.db.player_discord_links ?? [];
const linkFor = (playerId: string) => links().find((l) => l.player_id === playerId);
const audits = () => store.db.audit_logs ?? [];
const errorOf = (res: { ok: boolean } | { ok: false; error: string }) =>
  'error' in res ? res.error : '';

beforeEach(() => {
  store.db = {
    players: [
      person(ADMIN, { role: 'admin', is_exec: true, full_name: 'The Admin' }),
      person(TARGET, { full_name: 'Target Member' }),
      person(OTHER, { full_name: 'Someone Else' }),
      person(PLAIN),
    ],
    player_discord_links: [
      { player_id: OTHER, discord_user_id: OTHERS_SNOWFLAKE, linked_at: '2026-01-01T00:00:00Z', last_synced_at: '2026-01-02T00:00:00Z' },
    ],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

describe('forceLinkDiscordAccount', () => {
  it('refuses an actor without the capability, and writes nothing', async () => {
    store.actor = rowFor(PLAIN);
    const res = await forceLinkDiscordAccount(TARGET, SNOWFLAKE, 'they asked me to');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('players.discordlink.write');
    // AND NOTHING WAS WRITTEN. A refusal that had already linked would be the
    // bug this file exists to prevent.
    expect(linkFor(TARGET)).toBeUndefined();
    expect(audits().length).toBe(0);
  });

  // The id is a client-controlled POST field, not something the panel decides.
  it('refuses a malformed snowflake', async () => {
    const res = await forceLinkDiscordAccount(TARGET, 'matthew#1234', 'typed the username');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('not a Discord user ID');
    expect(linkFor(TARGET)).toBeUndefined();
  });

  it('requires a reason', async () => {
    const res = await forceLinkDiscordAccount(TARGET, SNOWFLAKE, '   ');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('Say why');
    expect(linkFor(TARGET)).toBeUndefined();
  });

  // NAMED, rather than left to the constraint. "duplicate key value violates
  // unique constraint" tells an exec nothing about what to do next.
  it('refuses a snowflake that belongs to another member, and names them', async () => {
    const res = await forceLinkDiscordAccount(TARGET, OTHERS_SNOWFLAKE, 'they asked me to');
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('Someone Else');
    expect(linkFor(TARGET)).toBeUndefined();
    // And the other member's link is untouched.
    expect(linkFor(OTHER)!.discord_user_id).toBe(OTHERS_SNOWFLAKE);
  });

  it('links a member who had none', async () => {
    const res = await forceLinkDiscordAccount(TARGET, SNOWFLAKE, 'they cannot run /link');
    expect(res.ok).toBe(true);
    expect(linkFor(TARGET)!.discord_user_id).toBe(SNOWFLAKE);
    expect(res.ok && res.data.displacedDiscordUserId).toBe(null);
  });

  it('replaces an existing link and returns the displaced account', async () => {
    store.db.player_discord_links!.push({
      player_id: TARGET,
      discord_user_id: OLD_SNOWFLAKE,
      linked_at: '2026-02-01T00:00:00Z',
      last_synced_at: '2026-02-02T00:00:00Z',
    });
    const res = await forceLinkDiscordAccount(TARGET, SNOWFLAKE, 'they lost that account');
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.displacedDiscordUserId).toBe(OLD_SNOWFLAKE);
    // ONE ROW, REPLACED IN PLACE. A second row for the same member would mean
    // the write was an insert, which the player_id primary key would refuse in
    // the real database.
    expect(links().filter((l) => l.player_id === TARGET).length).toBe(1);
    expect(linkFor(TARGET)!.discord_user_id).toBe(SNOWFLAKE);
  });

  // The bot re-syncs this member's roles from scratch rather than trusting a
  // sync that happened to the account that just left.
  it('clears last_synced_at on the replace', async () => {
    store.db.player_discord_links!.push({
      player_id: TARGET,
      discord_user_id: OLD_SNOWFLAKE,
      linked_at: '2026-02-01T00:00:00Z',
      last_synced_at: '2026-02-02T00:00:00Z',
    });
    await forceLinkDiscordAccount(TARGET, SNOWFLAKE, 'they lost that account');
    expect(linkFor(TARGET)!.last_synced_at).toBe(null);
  });

  // THE POINT OF THE AUDIT ROW. The tombstone naming the displaced account is
  // deleted by the bot as soon as the sweep clears it, and a degraded audit
  // retry drops old_value/new_value, so `reason` is the one field that keeps it.
  it('records the displaced account in the audit reason', async () => {
    store.db.player_discord_links!.push({
      player_id: TARGET,
      discord_user_id: OLD_SNOWFLAKE,
      linked_at: '2026-02-01T00:00:00Z',
      last_synced_at: null,
    });
    await forceLinkDiscordAccount(TARGET, SNOWFLAKE, 'they lost that account');
    const entry = audits().at(-1)!;
    expect(entry.action_type).toBe('discord_link_forced');
    expect(entry.actor_id).toBe(ADMIN);
    expect(entry.target_type).toBe('player');
    expect(entry.target_id).toBe(TARGET);
    expect(entry.reason).toContain('they lost that account');
    expect(entry.reason).toContain(OLD_SNOWFLAKE);
    expect((entry.old_value as Row).discord_user_id).toBe(OLD_SNOWFLAKE);
    expect((entry.new_value as Row).discord_user_id).toBe(SNOWFLAKE);
  });
});

describe('previewDiscordForceLink', () => {
  it('refuses an actor without the capability', async () => {
    store.actor = rowFor(PLAIN);
    const res = await previewDiscordForceLink(TARGET, SNOWFLAKE);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('players.discordlink.write');
  });

  it('reports the conflict without writing anything', async () => {
    const res = await previewDiscordForceLink(TARGET, OTHERS_SNOWFLAKE);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.conflictPlayerId).toBe(OTHER);
    expect(res.ok && res.data.conflictPlayerName).toBe('Someone Else');
    expect(linkFor(TARGET)).toBeUndefined();
    expect(audits().length).toBe(0);
  });

  it('reports the account a link would displace', async () => {
    store.db.player_discord_links!.push({
      player_id: TARGET,
      discord_user_id: OLD_SNOWFLAKE,
      linked_at: '2026-02-01T00:00:00Z',
      last_synced_at: null,
    });
    const res = await previewDiscordForceLink(TARGET, SNOWFLAKE);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.currentDiscordUserId).toBe(OLD_SNOWFLAKE);
    expect(res.ok && res.data.targetName).toBe('Target Member');
    expect(res.ok && res.data.conflictPlayerId).toBe(null);
    // Still the old one: a preview that wrote would be a dry run in name only.
    expect(linkFor(TARGET)!.discord_user_id).toBe(OLD_SNOWFLAKE);
  });
});
