// PINNING THE SELECT STRINGS THE FEED'S TOURNAMENT CARD SENDS.
//
// *** WHY THIS FILE EXISTS AND WHY IT IS NOT PARANOIA. ***
//
// supabase-server.ts and supabase-browser.ts both say "typed clients are
// deliberately off". So a select string is an UNCHECKED STRING LITERAL: rename a
// column, fat-finger an embed, or name a table that does not exist, and
// type-check passes, `tsc` is happy, lint is happy, and PostgREST answers 400 or
// 403 to the WHOLE request at runtime. supabase-js RESOLVES that rather than
// rejecting it. 00115 is this repository's write-up of that emptying five
// player screens, and the feed is the app's landing surface.
//
// The card's own error handling reports such a failure to Sentry instead of
// swallowing it, which is the runtime half of the defence. This is the
// build-time half: it captures the URL supabase-js actually builds and asserts
// the column list, the filters and the embed are the ones whose readability was
// verified against the production database (has_column_privilege() for the
// `authenticated` role, then again under SET LOCAL ROLE, on 2026-08-17).
//
// NO NETWORK AND NO CREDENTIALS. `global.fetch` is replaced with a stub that
// records the URL and answers `[]`, and the client is constructed against a
// fake host with a fake key. Nothing leaves the process.
//
// If you change a select in app/feed/page.tsx, this file must change with it —
// and the point of that friction is that changing it makes you re-check the
// column against the grant.

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { scopeToActiveSeason } from '@badminton/shared';

const SEASON = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';
const EVENT_A = '33333333-3333-4333-8333-333333333333';
const EVENT_B = '44444444-4444-4444-8444-444444444444';

/** Builds a client whose fetch records the request URL instead of making it. */
function recordingClient() {
  const urls: string[] = [];
  const client = createClient('http://pinned.invalid', 'not-a-real-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: ((input: RequestInfo | URL) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return Promise.resolve(
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }) as typeof fetch,
    },
  });
  return { client, urls };
}

/** The decoded query string of the one request that was made. */
function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('wave 1 — the running-tournaments request', () => {
  it('sends exactly the columns, embed and filters that were grant-verified', async () => {
    const { client, urls } = recordingClient();

    // BYTE-FOR-BYTE THE QUERY IN app/feed/page.tsx. If you edit one, edit both.
    await scopeToActiveSeason(
      client
        .from('tournaments')
        .select('id, name, start_date, end_date, tournament_events(id, event_type, status)')
        .eq('status', 'active')
        .is('suspended_at', null),
      SEASON,
    ).order('start_date', { ascending: true });

    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url).toContain('/rest/v1/tournaments');

    const q = queryOf(url);
    // The projection, whitespace-normalised the way PostgREST receives it.
    expect(q.get('select')).toBe('id,name,start_date,end_date,tournament_events(id,event_type,status)');
    expect(q.get('status')).toBe('eq.active');
    expect(q.get('suspended_at')).toBe('is.null');
    expect(q.get('or')).toBe(`(season_id.eq.${SEASON},season_id.is.null)`);
    expect(q.get('order')).toBe('start_date.asc');
  });

  it('names no column outside the set proved readable by `authenticated`', () => {
    // The 18 columns checked with has_column_privilege() on production. Kept as
    // a literal list so that adding a column to the select above without
    // re-checking the grant fails here rather than in production.
    const VERIFIED_TOURNAMENTS = ['id', 'name', 'start_date', 'end_date', 'status', 'suspended_at', 'season_id'];
    const VERIFIED_EVENTS = ['id', 'tournament_id', 'event_type', 'status'];

    const select = 'id, name, start_date, end_date, tournament_events(id, event_type, status)';
    const embed = /tournament_events\(([^)]*)\)/.exec(select)![1]!;
    const outer = select.replace(/tournament_events\([^)]*\)/, '').split(',').map((s) => s.trim()).filter(Boolean);

    for (const col of outer) expect(VERIFIED_TOURNAMENTS, `tournaments.${col}`).toContain(col);
    for (const col of embed.split(',').map((s) => s.trim())) expect(VERIFIED_EVENTS, `tournament_events.${col}`).toContain(col);

    // And the two columns that are FILTERED but not selected still need the
    // privilege, so they are on the verified list too.
    expect(VERIFIED_TOURNAMENTS).toContain('suspended_at');
    expect(VERIFIED_TOURNAMENTS).toContain('season_id');
  });

  it('degrades rather than throwing when the season is unknown', async () => {
    // scopeToActiveSeason drops the filter when there is no active season, which
    // is a wider read rather than an empty one — the documented choice in
    // active-season.ts. Asserted because the feed passes `activeSeason?.id`,
    // which is undefined on a club with no active season.
    const { client, urls } = recordingClient();
    await scopeToActiveSeason(
      client.from('tournaments').select('id, name, start_date, end_date, tournament_events(id, event_type, status)')
        .eq('status', 'active').is('suspended_at', null),
      undefined,
    ).order('start_date', { ascending: true });
    expect(queryOf(urls[0]!).has('or')).toBe(false);
  });
});

describe('wave 2 — the entry-row requests', () => {
  it('sends the participants request /tournaments already ships', async () => {
    const { client, urls } = recordingClient();
    await client
      .from('tournament_participants')
      .select('event_id, player_id, status')
      .in('event_id', [EVENT_A, EVENT_B]);

    const q = queryOf(urls[0]!);
    expect(urls[0]).toContain('/rest/v1/tournament_participants');
    expect(q.get('select')).toBe('event_id,player_id,status');
    expect(q.get('event_id')).toBe(`in.(${EVENT_A},${EVENT_B})`);
  });

  it('sends the pairs request /tournaments already ships', async () => {
    const { client, urls } = recordingClient();
    await client
      .from('tournament_pairs')
      .select('event_id, player1_id, player2_id, status')
      .in('event_id', [EVENT_A, EVENT_B]);

    const q = queryOf(urls[0]!);
    expect(urls[0]).toContain('/rest/v1/tournament_pairs');
    expect(q.get('select')).toBe('event_id,player1_id,player2_id,status');
    expect(q.get('event_id')).toBe(`in.(${EVENT_A},${EVENT_B})`);
  });

  it('reads BOTH entry tables — the 00102 unpaired-doubles entrant', async () => {
    // Since 00102 a member enters a doubles event alone and an exec pairs them
    // later, so a doubles entrant may own a participants row and no pair row.
    // Reading only pairs for a doubles event would tell a genuinely entered
    // member they are not in it. Named as a test so the second read cannot be
    // "optimised away" for doubles events by someone who has not read 00102.
    const { client, urls } = recordingClient();
    await Promise.all([
      client.from('tournament_participants').select('event_id, player_id, status').in('event_id', [EVENT_A]),
      client.from('tournament_pairs').select('event_id, player1_id, player2_id, status').in('event_id', [EVENT_A]),
    ]);
    expect(urls.filter((u) => u.includes('tournament_participants'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('tournament_pairs'))).toHaveLength(1);
  });

  it('never selects a private free-text column', async () => {
    // 00117/00118 moved the exec's own free text out of these tables and
    // deliberately did NOT drop the old columns, so `notes` and `pair_name` are
    // still selectable and still hold their history. The event page narrowed its
    // selects for exactly this reason; the feed must not widen them back.
    const { client, urls } = recordingClient();
    await client.from('tournament_participants').select('event_id, player_id, status').in('event_id', [EVENT_A]);
    await client.from('tournament_pairs').select('event_id, player1_id, player2_id, status').in('event_id', [EVENT_A]);
    await client.from('tournaments').select('id, name, start_date, end_date, tournament_events(id, event_type, status)');
    for (const u of urls) {
      const select = queryOf(u).get('select') ?? '';
      for (const forbidden of ['notes', 'pair_name', 'suspension_reason', 'elo_snapshot', 'waiver_text', '*']) {
        expect(select, `${forbidden} must not be selected`).not.toContain(forbidden);
      }
    }
  });
});

describe('the query and the derivation split the definition exactly once', () => {
  it('leaves the DATE bound to isUnderWay and does not filter dates in SQL', async () => {
    // The definition of "on right now" is deliberately split: three cheap
    // conditions in the query, the date window in JS. The reason is that the
    // window is `(end_date ?? start_date) >= todayKey`, PostgREST has no
    // COALESCE in a filter, and expressing it would mean a SECOND `or=` on a
    // query that already has one from scopeToActiveSeason — two or-groups that
    // get ANDed in a way nobody reading the call site would predict.
    //
    // Pinned in both directions. If somebody later pushes a date filter down
    // into the query, this fails and they have to decide what happens to the
    // season `or=` rather than discovering it as a card that never appears.
    const { client, urls } = recordingClient();
    await scopeToActiveSeason(
      client
        .from('tournaments')
        .select('id, name, start_date, end_date, tournament_events(id, event_type, status)')
        .eq('status', 'active')
        .is('suspended_at', null),
      SEASON,
    ).order('start_date', { ascending: true });

    const q = queryOf(urls[0]!);
    // start_date and end_date are SELECTED and ORDERED BY, never FILTERED.
    expect(q.has('start_date')).toBe(false);
    expect(q.has('end_date')).toBe(false);
    // Exactly one or-group, so the season scope is unambiguous.
    expect(q.getAll('or')).toHaveLength(1);
    // And the columns the JS bound needs are in the projection, or isUnderWay
    // would be deciding the window from undefined.
    expect(q.get('select')).toContain('start_date');
    expect(q.get('select')).toContain('end_date');
  });

  it('scopes the entry reads to the RUNNING events only', async () => {
    // Not to every event of the tournament. Somebody entered in a sibling event
    // that has already finished is not playing right now, and counting them
    // would overstate the field on the card.
    const { client, urls } = recordingClient();
    await client
      .from('tournament_participants')
      .select('event_id, player_id, status')
      .in('event_id', [EVENT_A]); // one running event, though the tournament has two
    expect(queryOf(urls[0]!).get('event_id')).toBe(`in.(${EVENT_A})`);
    expect(urls[0]).not.toContain(EVENT_B);
    expect(PLAYER).toMatch(/^[0-9a-f-]{36}$/); // player.id is a uuid off the verified session
  });
});
