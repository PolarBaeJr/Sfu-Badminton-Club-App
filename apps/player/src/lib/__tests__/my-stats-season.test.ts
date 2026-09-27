// /my-stats is scoped to one season. These pin the reads that scope it (against
// a client that records the request instead of sending it, as in
// home-schedule-query.test.ts), the seasons its picker offers, and the
// head-to-head and partner figures it now derives from a season's own matches.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  deriveSeasonHeadToHead,
  deriveSeasonPartners,
  memberSeasonIds,
  previousPublishedSeason,
  seasonMatchCountQuery,
  seasonMatchesQuery,
  seasonsToProbe,
  type OwnSeasonMatch,
  type SeasonParticipantRow,
} from '@/lib/my-stats-season';
import { seasonPickerOptions, type HistorySeason } from '@/lib/season-history';

const PLAYER = '22222222-2222-4222-8222-222222222222';
const SEASON = '11111111-1111-4111-8111-111111111111';

function recordingClient() {
  const calls: { url: string; method: string; prefer: string | null }[] = [];
  const client = createClient('http://pinned.invalid', 'not-a-real-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? 'GET', prefer: headers.get('prefer') });
        return Promise.resolve(
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/0' } })
        );
      }) as typeof fetch,
    },
  });
  return { client, calls };
}

function season(id: string, start: string, extra: Partial<HistorySeason> = {}): HistorySeason {
  return { id, name: id, start_date: start, end_date: null, active_flag: false, ...extra };
}

describe('the season matches read', () => {
  it('asks for one season and one member, never a career window', async () => {
    const { client, calls } = recordingClient();
    await seasonMatchesQuery(client, PLAYER, SEASON, 200);
    expect(calls).toHaveLength(1);
    const q = new URL(calls[0]!.url).searchParams;
    expect(calls[0]!.url).toContain('/rest/v1/matches');
    expect(q.get('season_id')).toBe(`eq.${SEASON}`);
    expect(q.get('participants.player_id')).toBe(`eq.${PLAYER}`);
    expect(q.get('played_at')).toBe('not.is.null');
    expect(q.get('order')).toBe('played_at.desc');
    expect(q.get('limit')).toBe('200');
    // walkover_type is what head-to-head and partners exclude forfeits by.
    expect(q.get('select')).toContain('walkover_type');
    expect(q.get('select')).toContain('match_participants!inner');
  });

  it('counts a season without fetching its rows', async () => {
    const { client, calls } = recordingClient();
    await seasonMatchCountQuery(client, PLAYER, SEASON);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('HEAD');
    expect(calls[0]!.prefer).toContain('count=exact');
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get('season_id')).toBe(`eq.${SEASON}`);
    expect(q.get('participants.player_id')).toBe(`eq.${PLAYER}`);
  });
});

describe('the page reads', () => {
  const src = readFileSync(join(__dirname, '../../app/my-stats/page.tsx'), 'utf8');
  const past = readFileSync(join(__dirname, '../../app/my-stats/past-season.tsx'), 'utf8');

  it('reads both screens through the season-scoped builder', () => {
    expect(src).toContain('seasonMatchesQuery(');
    expect(past).toContain('seasonMatchesQuery(');
  });

  it('no longer reads the career head-to-head or partnership tables', () => {
    expect(src).not.toContain("from('head_to_head_stats')");
    expect(src).not.toContain("from('partnership_stats')");
  });
});

describe('the season picker', () => {
  const active = season('fall', '2026-09-01', { active_flag: true });
  const hiddenTest = season('summer-test', '2026-05-01', { hidden_flag: true });
  const archived = season('spring', '2026-01-05');
  const playedOnly = season('winter', '2025-09-01');
  const untouched = season('fall-2024', '2024-09-01');
  const seasons = [active, hiddenTest, archived, playedOnly, untouched];

  it('probes only finished, published seasons it has no archived rating for', () => {
    expect(seasonsToProbe(seasons, new Set(['spring']))).toEqual(['winter', 'fall-2024']);
  });

  it('offers a season the member only played in, not only archived ones', () => {
    const ids = memberSeasonIds(new Set(['spring']), [
      { seasonId: 'winter', count: 4, failed: false },
      { seasonId: 'fall-2024', count: 0, failed: false },
    ]);
    const options = seasonPickerOptions(seasons, ids, null).map((s) => s.id);
    expect(options).toEqual(['fall', 'spring', 'winter']);
  });

  it('puts the active season first', () => {
    const options = seasonPickerOptions(seasons, new Set(['spring', 'winter']), null);
    expect(options[0]?.id).toBe('fall');
  });

  it('does not offer a season whose count read failed', () => {
    const ids = memberSeasonIds(new Set(), [{ seasonId: 'winter', count: null, failed: true }]);
    expect(ids.has('winter')).toBe(false);
  });

  it('never offers a hidden season, even with matches in it or named in the URL', () => {
    const ids = memberSeasonIds(new Set(['summer-test']), [{ seasonId: 'summer-test', count: 3, failed: false }]);
    expect(seasonPickerOptions(seasons, ids, 'summer-test').map((s) => s.id)).not.toContain('summer-test');
    expect(seasonsToProbe(seasons, new Set())).not.toContain('summer-test');
  });

  it('offers the active season alone when the member has nothing else', () => {
    expect(seasonPickerOptions(seasons, new Set(), null).map((s) => s.id)).toEqual(['fall']);
  });
});

describe('the prior season on the live chart', () => {
  it('steps over a hidden season to the last published one', () => {
    const seasons = [
      season('fall', '2026-09-01', { active_flag: true }),
      season('summer-test', '2026-05-01', { hidden_flag: true }),
      season('spring', '2026-01-05'),
    ];
    expect(previousPublishedSeason(seasons, 'fall')?.id).toBe('spring');
  });

  it('is null when every earlier season is hidden, or there is none', () => {
    const seasons = [
      season('fall', '2026-09-01', { active_flag: true }),
      season('summer-test', '2026-05-01', { hidden_flag: true }),
    ];
    expect(previousPublishedSeason(seasons, 'fall')).toBeNull();
    expect(previousPublishedSeason([seasons[0]!], 'fall')).toBeNull();
    expect(previousPublishedSeason(seasons, null)).toBeNull();
  });

  it('ignores a season that starts after the active one', () => {
    const seasons = [
      season('next', '2027-01-05'),
      season('fall', '2026-09-01', { active_flag: true }),
    ];
    expect(previousPublishedSeason(seasons, 'fall')).toBeNull();
  });
});

const ME = 'me';
const person = (id: string) => ({ id, full_name: id.toUpperCase(), avatar_url: null });

function match(
  id: string,
  match_type: 'singles' | 'doubles',
  side: string | null,
  win: boolean | null,
  extra: Partial<OwnSeasonMatch> = {}
): OwnSeasonMatch {
  return {
    id,
    match_type,
    result_status: 'confirmed',
    walkover_type: null,
    own: { team_side: side, win_flag: win },
    ...extra,
  };
}

function row(match_id: string, player_id: string, team_side: string | null): SeasonParticipantRow {
  return { match_id, player_id, team_side, player: person(player_id) };
}

describe('season head-to-head', () => {
  it('counts opponents on the other side and never a partner', () => {
    const matches = [match('d1', 'doubles', 'a', true)];
    const parts = [row('d1', ME, 'a'), row('d1', 'pal', 'a'), row('d1', 'x', 'b'), row('d1', 'y', 'b')];
    const h2h = deriveSeasonHeadToHead(matches, parts, ME);
    expect(h2h.map((h) => h.opponent.id).sort()).toEqual(['x', 'y']);
    expect(h2h.every((h) => h.wins === 1 && h.losses === 0 && h.match_type === 'doubles')).toBe(true);
  });

  it('keeps singles and doubles apart for the same opponent', () => {
    const matches = [match('s1', 'singles', 'a', true), match('d1', 'doubles', 'a', false)];
    const parts = [row('s1', ME, 'a'), row('s1', 'x', 'b'), row('d1', ME, 'a'), row('d1', 'x', 'b')];
    const h2h = deriveSeasonHeadToHead(matches, parts, ME);
    expect(h2h).toHaveLength(2);
    expect(h2h.find((h) => h.match_type === 'singles')).toMatchObject({ wins: 1, losses: 0 });
    expect(h2h.find((h) => h.match_type === 'doubles')).toMatchObject({ wins: 0, losses: 1 });
  });

  it('leaves out forfeits, unconfirmed results and unknown sides, like the career table', () => {
    const matches = [
      match('w', 'singles', 'a', true, { walkover_type: 'no_show' }),
      match('p', 'singles', 'a', true, { result_status: 'pending' }),
      match('v', 'singles', 'a', false, { result_status: 'voided' }),
      match('n', 'singles', null, true),
      match('o', 'singles', 'a', true),
    ];
    const parts = [
      row('w', 'x', 'b'),
      row('p', 'x', 'b'),
      row('v', 'x', 'b'),
      row('n', 'x', 'b'),
      row('o', 'x', null),
    ];
    expect(deriveSeasonHeadToHead(matches, parts, ME)).toEqual([]);
  });

  it('counts a match with no winner stamped as played by both and won by neither', () => {
    const h2h = deriveSeasonHeadToHead([match('s', 'singles', 'a', null)], [row('s', 'x', 'b')], ME);
    expect(h2h).toEqual([{ opponent: person('x'), match_type: 'singles', wins: 0, losses: 0, played: 1 }]);
  });

  it('orders by matches played and caps the list', () => {
    const matches = [match('1', 'singles', 'a', true), match('2', 'singles', 'a', true), match('3', 'singles', 'a', true)];
    const parts = [row('1', 'x', 'b'), row('2', 'y', 'b'), row('3', 'y', 'b')];
    expect(deriveSeasonHeadToHead(matches, parts, ME).map((h) => h.opponent.id)).toEqual(['y', 'x']);
    expect(deriveSeasonHeadToHead(matches, parts, ME, 1)).toHaveLength(1);
  });

  it('is empty for a season with no matches', () => {
    expect(deriveSeasonHeadToHead([], [], ME)).toEqual([]);
  });
});

describe('season partners', () => {
  const d = (id: string, win: boolean) => match(id, 'doubles', 'a', win);

  it('needs three counted doubles matches together', () => {
    const matches = [d('1', true), d('2', true)];
    const parts = [row('1', 'pal', 'a'), row('2', 'pal', 'a')];
    expect(deriveSeasonPartners(matches, parts, ME)).toEqual([]);
  });

  it('counts only the same side, doubles only, and ranks by win rate', () => {
    const matches = [
      d('1', true), d('2', true), d('3', false),
      d('4', true), d('5', true), d('6', true),
      match('s', 'singles', 'a', true),
    ];
    const parts = [
      row('1', 'pal', 'a'), row('2', 'pal', 'a'), row('3', 'pal', 'a'),
      row('4', 'best', 'a'), row('5', 'best', 'a'), row('6', 'best', 'a'),
      row('1', 'opp', 'b'), row('2', 'opp', 'b'), row('3', 'opp', 'b'),
      row('s', 'pal', 'a'),
    ];
    const partners = deriveSeasonPartners(matches, parts, ME);
    expect(partners.map((p) => p.partner.id)).toEqual(['best', 'pal']);
    expect(partners[0]).toMatchObject({ wins: 3, losses: 0, played: 3, winRate: 100 });
    expect(partners[1]).toMatchObject({ wins: 2, losses: 1, played: 3, winRate: 66.67 });
  });
});
