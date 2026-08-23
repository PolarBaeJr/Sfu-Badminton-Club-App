import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// CLEARING THE MERGE REVIEW — the half 00163 documented and did not write.
//
// 00163 gave merge_players a way to say "this completed but somebody should
// look at it" and its COMMENT ON COLUMN promised the console would clear the
// flag once actioned. Nothing did. An admin could void the self-play match and
// the danger badge would stay on the roster for good, which turns the prompt
// into furniture after the first time it is ignored.
//
// What is pinned here is the contract that makes the flag trustworthy: only a
// merge-capable actor clears it, clearing it twice is refused rather than
// silently re-written, and the review's contents survive into the audit row —
// because this is the moment the self-play match ids stop being readable
// anywhere else.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
}));

// The harness console-access-capability.test.ts uses, trimmed to the calls this
// action makes: the gate and the action are real, only the database and session
// are stubbed.
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
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
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      // A COPY, for the reason the sibling harness gives: a shared reference
      // would make the "what it was" audit snapshot read back as "what it is",
      // which is exactly the assertion this file cares about.
      async single() {
        const res = run();
        const hit = res.data?.[0];
        return hit
          ? { data: { ...hit }, error: null }
          : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
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

import { resolveEloReview } from '../actions/players';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const SURVIVOR = 'cccccccc-0000-4000-8000-000000000001';
const CLEAN = 'cccccccc-0000-4000-8000-000000000002';
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000001';

const ELO_REVIEW = {
  state: 'elo',
  at: '2026-08-23T04:00:00Z',
  merged_from: 'dddddddd-0000-4000-8000-000000000001',
  merged_from_name: 'Matthew Cheng (duplicate)',
  self_play_matches: ['m-1', 'm-2'],
  self_play_tournament_matches: ['t-1'],
  discarded: { club_fees: 2 },
};

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
  elo_review: null,
  ...extra,
});

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const audits = () => store.db.audit_logs ?? [];
const errorOf = (res: { ok: boolean } | { ok: false; error: string }) =>
  'error' in res ? res.error : '';

beforeEach(() => {
  store.db = {
    players: [
      person(ADMIN, { role: 'admin', is_exec: true }),
      person(SURVIVOR, { elo_review: { ...ELO_REVIEW } }),
      person(CLEAN),
      person(MEMBER),
    ],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

describe('resolveEloReview', () => {
  it('clears the flag', async () => {
    expect(rowFor(SURVIVOR).elo_review).toBeTruthy();
    const res = await resolveEloReview(SURVIVOR);
    expect(res.ok).toBe(true);
    expect(rowFor(SURVIVOR).elo_review).toBe(null);
  });

  it('refuses somebody who cannot run a merge', async () => {
    store.actor = rowFor(MEMBER);
    const res = await resolveEloReview(SURVIVOR);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('players.merge.write');
    // AND THE FLAG IS STILL THERE. A refusal that had already written would be
    // the bug this whole file exists to prevent.
    expect(rowFor(SURVIVOR).elo_review).toBeTruthy();
  });

  it('refuses a second clear rather than writing an empty audit row', async () => {
    await resolveEloReview(SURVIVOR);
    const after = audits().length;
    const res = await resolveEloReview(SURVIVOR);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('nothing left to review');
    expect(audits().length).toBe(after);
  });

  it('refuses a member who was never merged', async () => {
    const res = await resolveEloReview(CLEAN);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('nothing left to review');
  });

  // THE POINT OF THE AUDIT ROW. players.elo_review is NULL after this and the
  // merge's own entry is however far back in the log, so if the ids are not
  // here they are gone — dismissing the prompt would destroy the evidence it
  // was pointing at.
  it('keeps the self-play match ids in the audit row', async () => {
    await resolveEloReview(SURVIVOR);
    const entry = audits().at(-1)!;
    expect(entry.actor_id).toBe(ADMIN);
    expect(entry.target_id).toBe(SURVIVOR);
    expect((entry.old_value as Row).elo_review).toMatchObject({
      self_play_matches: ['m-1', 'm-2'],
      self_play_tournament_matches: ['t-1'],
    });
    expect((entry.new_value as Row).elo_review).toBe(null);
    expect(entry.reason).toContain('3 self-play');
    expect(entry.reason).toContain('Matthew Cheng (duplicate)');
  });

  // 'player_updated' deliberately, matching resolvePrivilegeClaimReview: it is
  // what isAccessChange() and the /accounts card key off.
  it('logs it as a player_updated change', async () => {
    await resolveEloReview(SURVIVOR);
    expect(audits().at(-1)!.action_type).toBe('player_updated');
  });

  // Allowed ON PURPOSE, and the opposite of resolvePrivilegeClaimReview. There
  // is no self-promotion edge here, and the club has ONE admin whose own
  // duplicate rows are the ones waiting to be merged — a rule that left the
  // only person able to act unable to act would recreate the refusal 00163 was
  // written to remove.
  it('lets an admin clear a review on their own row', async () => {
    rowFor(ADMIN).elo_review = { ...ELO_REVIEW };
    const res = await resolveEloReview(ADMIN);
    expect(res.ok).toBe(true);
    expect(rowFor(ADMIN).elo_review).toBe(null);
    expect(audits().at(-1)!.actor_id).toBe(ADMIN);
  });

  // A flag that parses to nothing is not a review — parseEloReview returns null
  // for it and the badge does not render, so the action must agree rather than
  // clearing a row the console never showed as needing it.
  it('treats a review that describes nothing as nothing to review', async () => {
    rowFor(CLEAN).elo_review = { state: 'elo', self_play_matches: [], discarded: {} };
    const res = await resolveEloReview(CLEAN);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain('nothing left to review');
  });
});
