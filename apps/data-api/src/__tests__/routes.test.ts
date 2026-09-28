import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCS_HTML } from '../docs-page.js';
import { QUERY_PARAMS } from '../params.js';
import { DATA_API_SCOPES } from '../scopes.js';
import { ROUTES } from '../server.js';
import { get, grant, newKey, playerRow, startHarness, type Harness } from './helpers.js';

const CONSUMER = 'aaaaaaaa-0000-0000-0000-000000000001';
const REF_A = 'a'.repeat(64);
const REF_B = 'b'.repeat(64);
const MATCH_REF = 'd'.repeat(64);
const SEASON = '15af1db0-ac97-499d-b583-98082a921368';
const TOURNAMENT = '22222222-0000-0000-0000-000000000001';
const EVENT = '33333333-0000-0000-0000-000000000001';

let h: Harness;
let key: string;

function matchRow(i = 0): Record<string, unknown> {
  return {
    match_ref: MATCH_REF,
    source: 'club',
    status: 'confirmed',
    counts_toward_stats: true,
    played_at: `2026-09-1${i % 10}T04:11:55.123456+00:00`,
    updated_at: '2026-09-14T05:00:00+00:00',
    season_id: SEASON,
    season_name: 'Fall 2026',
    discipline: 'singles',
    kind: 'ranked',
    rated: true,
    format: 'best_of_3',
    games_per_match: 3,
    points_per_game: 21,
    walkover: null,
    winner_side: 'a',
    score_summary: '21-15, 21-18',
    games: [
      { game: 1, a: 21, b: 15, notes: 'leak' },
      { game: 2, a: 21, b: 18 },
    ],
    sides: {
      a: [
        {
          player_ref: REF_A,
          won: true,
          rating: { before: 1200, after: 1216, delta: 16, player_id: 'leak' },
          points_scored: 42,
          points_allowed: 33,
          games_won: 2,
          games_lost: 0,
          full_name: 'leak',
          email: 'leak',
        },
      ],
      b: [{ player_ref: REF_B, won: false, rating: null, points_scored: 33, points_allowed: 42, games_won: 0, games_lost: 2 }],
    },
    tournament: null,
    // Columns a later migration might add. None may reach a consumer.
    notes: 'leak',
    walkover_reason: 'leak',
    player_id: 'leak',
  };
}

function seasonRow(): Record<string, unknown> {
  return {
    id: SEASON,
    name: 'Fall 2026',
    term: 'fall',
    year: 2026,
    start_date: '2026-09-01',
    end_date: '2026-12-15',
    active: true,
    club_matches: 3,
    tournament_matches: 2,
    players_with_matches: 4,
    sessions: 10,
    tournaments: 1,
    events: 2,
    hidden_flag: false,
  };
}

function tournamentRow(): Record<string, unknown> {
  return {
    id: TOURNAMENT,
    name: 'Fall Open',
    season_id: SEASON,
    season_name: 'Fall 2026',
    start_date: '2026-10-01',
    end_date: '2026-10-02',
    status: 'completed',
    suspended: false,
    event_multiplier: 1.5,
    placement_bonus_enabled: true,
    // Never served: only an entry path may read the cap (00201's fence).
    max_events_per_player: 2,
    suspension_reason: 'leak',
    waiver_text: 'leak',
  };
}

function eventRow(): Record<string, unknown> {
  return {
    id: EVENT,
    event_type: 'mens_doubles',
    format: 'single_elimination',
    match_format: 'best_of_3',
    games_per_match: 3,
    points_per_game: 21,
    max_participants: 16,
    seeding_method: 'elo',
    elo_multiplier: 1,
    placement_bonus_enabled: true,
    status: 'completed',
    group_count: null,
    qualifiers_per_group: null,
    seeded_from_event_id: null,
    notes: 'leak',
  };
}

function all(fn: string): Record<string, unknown>[] {
  return h.calls.filter((c) => c.fn === fn).map((c) => c.body);
}

function answerAll(): void {
  const published = new Set([REF_A, REF_B]);
  Object.assign(h.rpcs, {
    data_api_player_published: (b: Record<string, unknown>) =>
      published.has(b.p_player_ref as string) ? [{ published: true }] : [],
    data_api_matches: () => [matchRow()],
    data_api_match_by_ref: (b: Record<string, unknown>) => (b.p_match_ref === MATCH_REF ? [matchRow()] : []),
    data_api_head_to_head: () => [
      { relation: 'opponents', discipline: 'singles', matches: 3, wins: 2, losses: 1 },
      { relation: 'partners', discipline: 'doubles', matches: 1, wins: 1, losses: 0 },
    ],
    data_api_player_seasons: () => [
      {
        season_id: SEASON,
        season_name: 'Fall 2026',
        active: true,
        start_date: '2026-09-01',
        discipline: 'singles',
        matches: 3,
        wins: 2,
        losses: 1,
        games_won: 5,
        games_lost: 3,
        points_scored: 150,
        points_allowed: 120,
        final_singles_elo: null,
        final_doubles_elo: null,
      },
      {
        season_id: '44444444-0000-0000-0000-000000000001',
        season_name: 'Summer 2026',
        active: false,
        start_date: '2026-05-01',
        discipline: null,
        matches: null,
        wins: null,
        losses: null,
        games_won: null,
        games_lost: null,
        points_scored: null,
        points_allowed: null,
        final_singles_elo: 1210,
        final_doubles_elo: 1100,
      },
    ],
    data_api_rating_history: () => [
      {
        at: '2026-09-14T04:11:55+00:00',
        discipline: 'singles',
        kind: 'match',
        source: 'club',
        match_ref: MATCH_REF,
        before: 1200,
        after: 1216,
        delta: 16,
        player_id: 'leak',
      },
    ],
    data_api_seasons: (b: Record<string, unknown>) =>
      b.p_season_id === undefined || b.p_season_id === SEASON ? [seasonRow()] : [],
    data_api_season_header: (b: Record<string, unknown>) =>
      b.p_season_id === SEASON ? [{ id: SEASON, name: 'Fall 2026', active: true }] : [],
    data_api_season_standings: () => [
      {
        source: 'live',
        player_ref: REF_A,
        singles_elo: 1216,
        doubles_elo: 1000,
        singles_rank: 1,
        doubles_rank: 2,
        matches: 3,
        wins: 2,
        losses: 1,
        full_name: 'leak',
      },
    ],
    data_api_tournaments: (b: Record<string, unknown>) =>
      b.p_tournament_id === undefined || b.p_tournament_id === TOURNAMENT ? [tournamentRow()] : [],
    data_api_tournament_events: (b: Record<string, unknown>) => (b.p_tournament_id === TOURNAMENT ? [eventRow()] : []),
    data_api_tournament_entrants: () => [
      {
        event_id: EVENT,
        player_refs: [REF_A, REF_B],
        seed: 1,
        status: 'active',
        final_position: 1,
        group_number: null,
        points: null,
        elo_before: null,
        elo_after: null,
        elo_change: null,
        combined_elo: 2216,
        pair_name: 'leak',
      },
    ],
    data_api_tournament_draw: () => [
      {
        match_ref: MATCH_REF,
        round_number: 1,
        round_name: 'Final',
        phase: 'bracket',
        bracket_position: 1,
        match_number: 1,
        is_bye: false,
        is_third_place: false,
        scheduled_time: '2026-10-02T20:00:00+00:00',
        status: 'completed',
        winner_to: null,
        loser_to: null,
        withheld: false,
        sides: { a: [{ player_ref: REF_A }], b: [{ player_ref: REF_B }] },
        winner_side: 'a',
        games: [{ game: 1, a: 21, b: 10 }],
        court: 'leak',
        walkover_reason: 'leak',
      },
      {
        match_ref: 'e'.repeat(64),
        round_number: 1,
        round_name: 'Semi',
        phase: 'bracket',
        bracket_position: 2,
        match_number: 2,
        is_bye: false,
        is_third_place: false,
        scheduled_time: null,
        status: 'disputed',
        winner_to: { match_ref: MATCH_REF, position: 'b' },
        loser_to: null,
        withheld: true,
        // A withheld slot must never carry sides even if the database sent them.
        sides: { a: [{ player_ref: REF_A }], b: [] },
        winner_side: 'a',
        games: [{ game: 1, a: 21, b: 19 }],
      },
    ],
    data_api_sessions: () => [
      {
        id: '55555555-0000-0000-0000-000000000001',
        name: 'Tuesday drop-in',
        season_id: SEASON,
        season_name: 'Fall 2026',
        date: '2027-01-19',
        starts_at: '2027-01-20T02:00:00+00:00',
        ends_at: '2027-01-20T04:00:00+00:00',
        location: 'Gym',
        status: 'scheduled',
        track: 'drop_in',
        require_scan_to_check_in: true,
        rsvp_going: 12,
        attended: 0,
        notes: 'leak',
      },
    ],
    data_api_club_events: () => [
      {
        id: '66666666-0000-0000-0000-000000000001',
        title: 'Social',
        kind: 'social',
        location: 'Hall',
        starts_at: '2027-01-25T02:00:00+00:00',
        ends_at: null,
        status: 'published',
        cancelled_at: null,
        capacity: 40,
        cost_cents: 500,
        signup_opens_at: null,
        signup_closes_at: null,
        signups: 7,
        description: 'leak',
      },
    ],
  });
}

beforeEach(async () => {
  h = await startHarness();
  h.players = [playerRow(REF_A), playerRow(REF_B)];
  answerAll();
  key = newKey();
  grant(h, key, [...DATA_API_SCOPES]);
});
afterEach(async () => {
  await h.close();
});

async function body(path: string): Promise<Record<string, unknown>> {
  const res = await get(h, path, key);
  expect(res.status, path).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function concrete(template: string): string {
  return template
    .replace(':other_ref', REF_B)
    .replace(':match_ref', MATCH_REF)
    .replace(':ref', REF_A)
    .replace(':event_id', EVENT)
    .replace(':id', template.startsWith('/v1/seasons') ? SEASON : TOURNAMENT);
}

const KEYED = ROUTES.filter((r) => r.scope !== null);

describe('every keyed route', () => {
  it.each(KEYED.map((r) => [r.template, r.scope!] as const))('%s answers 200 with an all-scopes key', async (template) => {
    await body(concrete(template));
  });

  it.each(KEYED.map((r) => [r.template, r.scope!] as const))('%s 403s a key without %s', async (template, scope) => {
    const other = newKey();
    grant(
      h,
      other,
      DATA_API_SCOPES.filter((s) => s !== scope),
      '77777777-2222-3333-4444-555555555555',
    );
    const res = await get(h, concrete(template), other);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', detail: `this key does not carry ${scope}` });
    expect(h.calls.map((c) => c.fn)).toEqual(['data_api_verify_key']);
  });

  it.each(KEYED.map((r) => [r.template] as const))('%s 405s a POST before auth', async (template) => {
    const res = await get(h, concrete(template), undefined, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(h.calls).toHaveLength(0);
  });

  it.each(KEYED.filter((r) => r.strict).map((r) => [r.template] as const))(
    '%s 400s an unknown parameter without asking the database',
    async (template) => {
      const res = await get(h, `${concrete(template)}?bogus=1`, key);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', parameter: 'bogus' });
      expect(h.calls.map((c) => c.fn)).toEqual(['data_api_verify_key']);
    },
  );

  it.each(KEYED.filter((r) => r.template.includes(':')).map((r) => [r.template] as const))(
    '%s 404s a malformed path value without asking the database',
    async (template) => {
      const bad = template.replace(/:[a-z_]+/g, 'nope');
      const res = await get(h, bad, key);
      expect(res.status).toBe(404);
      expect(h.calls.map((c) => c.fn)).toEqual(['data_api_verify_key']);
    },
  );

  it('the two routes that predate parameters still ignore the query string', async () => {
    expect((await get(h, '/v1/players?bogus=1', key)).status).toBe(200);
    expect((await get(h, `/v1/players/${REF_A}?bogus=1`, key)).status).toBe(200);
  });
});

describe('/v1/players season', () => {
  it('fills the season block from the active season', async () => {
    h.rpcs.data_api_active_season = () => [{ ...seasonRow(), hidden_flag: false }];
    const b = await body('/v1/players');
    expect(b.season).toEqual({
      id: SEASON,
      name: 'Fall 2026',
      term: 'fall',
      year: 2026,
      start_date: '2026-09-01',
      end_date: '2026-12-15',
    });
  });

  it('falls back to null, never 503, when the season read fails', async () => {
    h.failFn = { fn: 'data_api_active_season', status: 500 };
    const b = await body('/v1/players');
    expect(b.season).toBeNull();
    expect(b.count).toBe(2);
    const warn = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'season_unavailable');
    expect(warn).toEqual({ level: 'warn', msg: 'season_unavailable', fn: 'data_api_active_season', upstream_status: 500 });
  });
});

describe('/v1/matches', () => {
  it('passes every filter through and asks for one row more than the page', async () => {
    const q = new URLSearchParams({
      season: SEASON.toUpperCase(),
      since: '2026-09-01T00:00:00Z',
      until: '2026-10-01T00:00:00Z',
      player: REF_A,
      opponent: REF_B,
      type: 'singles',
      source: 'club',
      rated: 'true',
      status: 'all',
      updated_since: '2026-09-02T00:00:00Z',
      limit: '5',
      offset: '10',
    });
    await body(`/v1/matches?${q}`);
    expect(all('data_api_matches')).toEqual([
      {
        p_consumer_id: CONSUMER,
        p_season: SEASON,
        p_since: '2026-09-01T00:00:00.000Z',
        p_until: '2026-10-01T00:00:00.000Z',
        p_player_ref: REF_A,
        p_opponent_ref: REF_B,
        p_type: 'singles',
        p_source: 'club',
        p_rated: true,
        p_status: 'all',
        p_updated_since: '2026-09-02T00:00:00.000Z',
        p_limit: 6,
        p_offset: 10,
      },
    ]);
  });

  it('sets next_offset only when another page follows', async () => {
    h.rpcs.data_api_matches = (b) => Array.from({ length: b.p_limit as number }, (_, i) => matchRow(i));
    const full = await body('/v1/matches?limit=2&offset=4');
    expect(full).toMatchObject({ count: 2, limit: 2, offset: 4, next_offset: 6 });
    expect(full.matches).toHaveLength(2);

    h.rpcs.data_api_matches = () => [matchRow()];
    expect(await body('/v1/matches?limit=2&offset=6')).toMatchObject({ count: 1, next_offset: null });
  });

  it.each([
    ['limit=0', 'limit'],
    ['limit=501', 'limit'],
    ['offset=-1', 'offset'],
    ['offset=100001', 'offset'],
    ['since=2026-09-01', 'since'],
    ['since=2026-09-01T00:00:00%2B01:00', 'since'],
    ['until=yesterday', 'until'],
    ['since=2026-09-02T00:00:00Z&until=2026-09-01T00:00:00Z', 'until'],
    ['since=2026-09-02T00:00:00Z&until=2026-09-02T00:00:00Z', 'until'],
    ['player=abc', 'player'],
    ['opponent=' + REF_B, 'opponent'],
    ['type=mixed', 'type'],
    ['source=ladder', 'source'],
    ['rated=1', 'rated'],
    ['status=pending', 'status'],
    ['season=fall', 'season'],
    ['limit=5&limit=6', 'limit'],
  ])('400s %s naming %s', async (query, parameter) => {
    const res = await get(h, `/v1/matches?${query}`, key);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', parameter });
  });

  it('serves the whitelisted shape and nothing else', async () => {
    const b = await body('/v1/matches');
    expect(Object.keys(b)).toEqual(['generated_at', 'count', 'limit', 'offset', 'next_offset', 'matches']);
    const m = (b.matches as Record<string, unknown>[])[0]!;
    expect(m).toEqual({
      match_ref: MATCH_REF,
      source: 'club',
      status: 'confirmed',
      counts_toward_stats: true,
      played_at: '2026-09-10T04:11:55Z',
      updated_at: '2026-09-14T05:00:00Z',
      season: { id: SEASON, name: 'Fall 2026' },
      type: 'singles',
      kind: 'ranked',
      rated: true,
      format: 'best_of_3',
      games_per_match: 3,
      points_per_game: 21,
      walkover: null,
      winner_side: 'a',
      score_summary: '21-15, 21-18',
      games: [
        { game: 1, a: 21, b: 15 },
        { game: 2, a: 21, b: 18 },
      ],
      sides: {
        a: [
          {
            player_ref: REF_A,
            won: true,
            rating: { before: 1200, after: 1216, delta: 16 },
            points_scored: 42,
            points_allowed: 33,
            games_won: 2,
            games_lost: 0,
          },
        ],
        b: [
          { player_ref: REF_B, won: false, rating: null, points_scored: 33, points_allowed: 42, games_won: 0, games_lost: 2 },
        ],
      },
      tournament: null,
    });
    expect(JSON.stringify(b)).not.toContain('leak');
  });

  it('shapes the tournament block and both walkover forms', async () => {
    h.rpcs.data_api_matches = () => [
      {
        ...matchRow(),
        source: 'tournament',
        walkover: { winner_side: 'b', reason: 'leak' },
        tournament: {
          id: TOURNAMENT,
          event_id: EVENT,
          event_type: 'mens_singles',
          round_number: 2,
          round_name: 'Final',
          phase: 'bracket',
          is_third_place: false,
          court: 'leak',
        },
      },
      { ...matchRow(), walkover: { type: 'forfeit', forfeit_side: 'b', reason: 'leak' } },
    ];
    const [t, c] = (await body('/v1/matches')).matches as Record<string, unknown>[];
    expect(t!.walkover).toEqual({ winner_side: 'b' });
    expect(t!.tournament).toEqual({
      id: TOURNAMENT,
      event_id: EVENT,
      event_type: 'mens_singles',
      round_number: 2,
      round_name: 'Final',
      phase: 'bracket',
      is_third_place: false,
    });
    expect(c!.walkover).toEqual({ type: 'forfeit', forfeit_side: 'b' });
    expect(JSON.stringify([t, c])).not.toContain('leak');
  });
});

describe('/v1/matches/{match_ref}', () => {
  it('returns one match and 404s an unknown ref', async () => {
    const b = await body(`/v1/matches/${MATCH_REF}`);
    expect((b.match as Record<string, unknown>).match_ref).toBe(MATCH_REF);
    expect(all('data_api_match_by_ref')).toEqual([{ p_consumer_id: CONSUMER, p_match_ref: MATCH_REF }]);
    expect((await get(h, `/v1/matches/${'f'.repeat(64)}`, key)).status).toBe(404);
  });
});

describe('/v1/players/{ref}/...', () => {
  it.each(['matches', 'seasons', 'ratings', `vs/${REF_B}`])('%s 404s an unpublished ref after one check', async (tail) => {
    const res = await get(h, `/v1/players/${'c'.repeat(64)}/${tail}`, key);
    expect(res.status).toBe(404);
    expect(h.calls.map((c) => c.fn)).toEqual(['data_api_verify_key', 'data_api_player_published']);
  });

  it('matches pins the player from the path and lets opponent stand alone', async () => {
    const b = await body(`/v1/players/${REF_A}/matches?opponent=${REF_B}&limit=3`);
    expect(b.player_ref).toBe(REF_A);
    expect(all('data_api_matches')).toEqual([
      { p_consumer_id: CONSUMER, p_opponent_ref: REF_B, p_player_ref: REF_A, p_limit: 4, p_offset: 0 },
    ]);
    const res = await get(h, `/v1/players/${REF_A}/matches?player=${REF_B}`, key);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', parameter: 'player' });
  });

  it('vs checks both refs, folds the totals and adds recent matches', async () => {
    const b = await body(`/v1/players/${REF_A}/vs/${REF_B}?type=singles`);
    expect(all('data_api_player_published').map((x) => x.p_player_ref)).toEqual([REF_A, REF_B]);
    expect(all('data_api_head_to_head')).toEqual([
      { p_consumer_id: CONSUMER, p_player_ref: REF_A, p_other_ref: REF_B, p_type: 'singles' },
    ]);
    expect(all('data_api_matches')).toEqual([
      { p_consumer_id: CONSUMER, p_type: 'singles', p_player_ref: REF_A, p_opponent_ref: REF_B, p_limit: 10 },
    ]);
    expect(b).toMatchObject({
      player_ref: REF_A,
      other_ref: REF_B,
      as_opponents: { singles: { matches: 3, wins: 2, losses: 1 }, doubles: { matches: 0, wins: 0, losses: 0 } },
      as_partners: { doubles: { matches: 1, wins: 1, losses: 0 } },
    });
    expect(b.recent).toHaveLength(1);
  });

  it('vs 404s a player against themself', async () => {
    expect((await get(h, `/v1/players/${REF_A}/vs/${REF_A}`, key)).status).toBe(404);
    expect(all('data_api_head_to_head')).toHaveLength(0);
  });

  it('vs 404s when the other player is unpublished', async () => {
    expect((await get(h, `/v1/players/${REF_A}/vs/${'c'.repeat(64)}`, key)).status).toBe(404);
    expect(all('data_api_head_to_head')).toHaveLength(0);
  });

  it('seasons groups rows per season, zero-fills and carries the final rating', async () => {
    const b = await body(`/v1/players/${REF_A}/seasons`);
    const zero = { matches: 0, wins: 0, losses: 0, games_won: 0, games_lost: 0, points_scored: 0, points_allowed: 0 };
    expect(b.seasons).toEqual([
      {
        season: { id: SEASON, name: 'Fall 2026', active: true, start_date: '2026-09-01' },
        singles: { matches: 3, wins: 2, losses: 1, games_won: 5, games_lost: 3, points_scored: 150, points_allowed: 120 },
        doubles: zero,
        final_rating: null,
      },
      {
        season: { id: '44444444-0000-0000-0000-000000000001', name: 'Summer 2026', active: false, start_date: '2026-05-01' },
        singles: zero,
        doubles: zero,
        final_rating: { singles: 1210, doubles: 1100 },
      },
    ]);
  });

  it('ratings pages the journal and strips unknown columns', async () => {
    const b = await body(`/v1/players/${REF_A}/ratings?type=singles&season=${SEASON}&limit=1`);
    expect(all('data_api_rating_history')).toEqual([
      { p_consumer_id: CONSUMER, p_player_ref: REF_A, p_type: 'singles', p_season: SEASON, p_limit: 2, p_offset: 0 },
    ]);
    expect(b).toMatchObject({ player_ref: REF_A, count: 1, limit: 1, offset: 0, next_offset: null });
    expect(b.history).toEqual([
      {
        at: '2026-09-14T04:11:55Z',
        type: 'singles',
        kind: 'match',
        source: 'club',
        match_ref: MATCH_REF,
        before: 1200,
        after: 1216,
        delta: 16,
      },
    ]);
  });
});

describe('/v1/seasons', () => {
  it('lists seasons with totals and nothing else', async () => {
    const b = await body('/v1/seasons');
    expect(all('data_api_seasons')).toEqual([{ p_consumer_id: CONSUMER }]);
    expect(b.seasons).toEqual([
      {
        id: SEASON,
        name: 'Fall 2026',
        term: 'fall',
        year: 2026,
        start_date: '2026-09-01',
        end_date: '2026-12-15',
        active: true,
        totals: { club_matches: 3, tournament_matches: 2, players_with_matches: 4, sessions: 10, tournaments: 1, events: 2 },
      },
    ]);
  });

  it('one season, lowercasing the id; unknown is 404', async () => {
    await body(`/v1/seasons/${SEASON.toUpperCase()}`);
    expect(all('data_api_seasons')).toEqual([{ p_consumer_id: CONSUMER, p_season_id: SEASON }]);
    expect((await get(h, `/v1/seasons/${TOURNAMENT}`, key)).status).toBe(404);
  });

  it('standings checks the season first and whitelists each row', async () => {
    const b = await body(`/v1/seasons/${SEASON}/standings`);
    expect(b).toMatchObject({ source: 'live', count: 1, season: { id: SEASON, name: 'Fall 2026', active: true } });
    expect(b.standings).toEqual([
      {
        player_ref: REF_A,
        singles_elo: 1216,
        doubles_elo: 1000,
        singles_rank: 1,
        doubles_rank: 2,
        record: { matches: 3, wins: 2, losses: 1 },
      },
    ]);
    const res = await get(h, `/v1/seasons/${TOURNAMENT}/standings`, key);
    expect(res.status).toBe(404);
    expect(all('data_api_season_standings')).toHaveLength(1);
    // The header, never the totals scan.
    expect(all('data_api_seasons')).toHaveLength(0);
  });
});

describe('/v1/tournaments', () => {
  it('lists, filtered by season', async () => {
    const b = await body(`/v1/tournaments?season=${SEASON}`);
    expect(all('data_api_tournaments')).toEqual([{ p_consumer_id: CONSUMER, p_season: SEASON }]);
    expect(JSON.stringify(b)).not.toContain('leak');
    expect((b.tournaments as Record<string, unknown>[])[0]).toMatchObject({
      id: TOURNAMENT,
      season: { id: SEASON, name: 'Fall 2026' },
      suspended: false,
    });
    expect((b.tournaments as Record<string, unknown>[])[0]).not.toHaveProperty('max_events_per_player');
  });

  it('detail nests entrants under their event', async () => {
    const b = await body(`/v1/tournaments/${TOURNAMENT}`);
    const t = b.tournament as Record<string, unknown>;
    const events = t.events as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    expect(events[0]!.entrants).toEqual([
      {
        players: [{ player_ref: REF_A }, { player_ref: REF_B }],
        seed: 1,
        status: 'active',
        final_position: 1,
        group: null,
        points: null,
        elo: { before: null, after: null, change: null },
        combined_elo: 2216,
      },
    ]);
    expect(JSON.stringify(b)).not.toContain('leak');
    expect((await get(h, `/v1/tournaments/${SEASON}`, key)).status).toBe(404);
  });

  it('event draw withholds a slot entirely and never serves a court', async () => {
    const b = await body(`/v1/tournaments/${TOURNAMENT}/events/${EVENT}`);
    expect(all('data_api_tournament_draw')).toEqual([{ p_consumer_id: CONSUMER, p_event_id: EVENT }]);
    const [shown, withheld] = b.draw as Record<string, unknown>[];
    expect(shown).toMatchObject({ withheld: false, sides: { a: [{ player_ref: REF_A }], b: [{ player_ref: REF_B }] } });
    expect(withheld).toMatchObject({
      withheld: true,
      sides: null,
      winner_side: null,
      games: null,
      winner_to: { match_ref: MATCH_REF, position: 'b' },
    });
    expect(JSON.stringify(b)).not.toContain('leak');
    expect(shown).not.toHaveProperty('court');
  });

  it('event 404s when the event is not in that tournament', async () => {
    const res = await get(h, `/v1/tournaments/${TOURNAMENT}/events/${SEASON}`, key);
    expect(res.status).toBe(404);
    expect(all('data_api_tournament_draw')).toHaveLength(0);
  });
});

describe('/v1/sessions and /v1/events', () => {
  it('defaults to the next 30 days', async () => {
    const b = await body('/v1/sessions');
    expect(b).toMatchObject({ from: '2027-01-15T08:00:00Z', to: '2027-02-14T08:00:00Z', count: 1 });
    expect(all('data_api_sessions')).toEqual([
      { p_consumer_id: CONSUMER, p_from: '2027-01-15T08:00:00.000Z', p_to: '2027-02-14T08:00:00.000Z' },
    ]);
    expect((b.sessions as Record<string, unknown>[])[0]).toMatchObject({ counts: { rsvp_going: 12, attended: 0 } });
    expect(JSON.stringify(b)).not.toContain('leak');
  });

  it('a lone `to` gets 30 days before it', async () => {
    const b = await body('/v1/events?to=2026-10-31T00:00:00Z');
    expect(b).toMatchObject({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    expect((b.events as Record<string, unknown>[])[0]).toMatchObject({ title: 'Social', counts: { signups: 7 } });
    expect(JSON.stringify(b)).not.toContain('leak');
  });

  it.each([
    ['from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z', 'to'],
    ['from=2026-01-01T00:00:00Z&to=2027-01-03T00:00:00Z', 'to'],
    ['from=today', 'from'],
    ['since=2026-10-01T00:00:00Z', 'since'],
  ])('400s %s naming %s', async (query, parameter) => {
    const res = await get(h, `/v1/sessions?${query}`, key);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', parameter });
    expect(all('data_api_sessions')).toHaveLength(0);
  });
});

describe('logs on the new routes', () => {
  it('log the template, never a ref, id or query', async () => {
    await get(h, `/v1/players/${REF_A}/vs/${REF_B}?type=singles`, key);
    await get(h, `/v1/matches/${MATCH_REF}`, key);
    await get(h, `/v1/matches?player=${REF_A}`, key);
    await get(h, `/v1/tournaments/${TOURNAMENT}/events/${EVENT}`, key);
    const text = h.logs.join('\n');
    for (const secret of [REF_A, REF_B, MATCH_REF, TOURNAMENT, EVENT, 'singles', key]) expect(text).not.toContain(secret);
    const paths = h.logs.map((l) => (JSON.parse(l) as Record<string, unknown>).path);
    expect(paths).toEqual([
      '/v1/players/:ref/vs/:other_ref',
      '/v1/matches/:match_ref',
      '/v1/matches',
      '/v1/tournaments/:id/events/:event_id',
    ]);
  });
});

describe('route table drift', () => {
  const apiMd = readFileSync(new URL('../../API.md', import.meta.url), 'utf8');

  it('every route scope is a real scope, and every scope is used', () => {
    const used = new Set(KEYED.map((r) => r.scope!));
    for (const s of used) expect(DATA_API_SCOPES).toContain(s);
    for (const s of DATA_API_SCOPES) expect(used, s).toContain(s);
  });

  it('every route param is a known parameter', () => {
    for (const r of ROUTES) for (const p of r.params) expect(Object.keys(QUERY_PARAMS)).toContain(p);
  });

  it('the docs page and API.md name every route, scope and parameter', () => {
    const names = [
      ...ROUTES.map((r) => r.template),
      ...DATA_API_SCOPES,
      ...Object.keys(QUERY_PARAMS),
    ];
    for (const n of names) {
      expect(DOCS_HTML, `docs page: ${n}`).toContain(n);
      expect(apiMd, `API.md: ${n}`).toContain(n);
    }
  });

  it('has no em dash in the docs page or API.md', () => {
    expect(DOCS_HTML).not.toContain('—');
    expect(apiMd).not.toContain('—');
  });
});
