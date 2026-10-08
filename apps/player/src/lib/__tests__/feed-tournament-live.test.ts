// THE FEED'S TOURNAMENT CARD IS SUBSCRIBED, AND SUBSCRIBED TO THE RIGHT THINGS.
//
// A text scan, for the same reason realtime-publication.test.ts is one: the
// alternative is trusting a comment, and a comment is what goes stale. This file
// asserts the three things about the live path that cannot be checked by
// type-check and could not be observed at build time.
//
// *** WHAT THIS CANNOT DO. *** It cannot prove a socket opened or a callback
// fired. Production holds no tournament this card would draw — the one
// tournament there ended 2026-07-24 and the date bound correctly excludes it —
// so the mount is unobserved on real data. What is verified elsewhere:
// `tournament_events`, `tournament_participants` and `tournament_pairs` are all
// members of `supabase_realtime` on production (pg_publication_tables, checked
// 2026-08-17), so the subscription is not inert; realtime-publication.test.ts
// asserts a migration publishes every table the app subscribes to; and the
// component mounted here is the same one two shipped surfaces already use.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(__dirname, '../../app/feed/page.tsx'), 'utf8');

/**
 * The file with its COMMENTS REMOVED.
 *
 * Written because this test caught itself: the negative assertions below matched
 * the prose in page.tsx explaining why the feed does NOT subscribe to
 * `tournament_matches` and why its channel name differs from
 * `player-tournament-${id}`. A guard that fails on the comment justifying the
 * very thing it is guarding is worse than no guard, because the obvious fix is
 * to delete the explanation.
 *
 * realtime-publication.test.ts documents the mirror-image version of this
 * hazard: there, prose between a `postgres_changes` literal and its config
 * object HIDES a subscription from the scan. Both are the same lesson — a text
 * scan must be explicit about whether it is reading code or reading English.
 * This one reads code.
 */
const FEED = RAW
  // Block comments first, JSX-wrapped or bare, so a `//` inside one cannot
  // survive as a line-comment fragment.
  .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
  // Then line comments. Anchored to start-of-line-plus-whitespace so a `//`
  // inside a string literal (a URL path, say) is left alone.
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the feed mounts LiveTournament for a running tournament', () => {
  it('imports and renders it', () => {
    expect(FEED).toContain("import { LiveTournament } from '../tournaments/live-tournament'");
    expect(FEED).toMatch(/<LiveTournament\b/);
  });

  it('strips comments without stripping the code it is about', () => {
    // The stripper is now load-bearing for five assertions, so it gets one of
    // its own. If it ever eats real code the negative tests below would start
    // passing vacuously.
    expect(FEED).toContain('<LiveTournament');
    expect(FEED).toContain('ActiveTournamentCard');
    expect(FEED).toContain('isUnderWay');
    // And it really did remove the prose that broke this file first time round.
    expect(RAW).toContain('tournament_matches');
    expect(FEED).not.toContain('tournament_matches');
  });

  it('passes a channel name that cannot collide with another surface', () => {
    // live-tournament.tsx requires the topic to be UNIQUE PER SURFACE.
    // /tournaments/[id] holds `player-tournament-${id}` and the event page holds
    // `player-tournament-event-${eventId}`; a third surface reusing either would
    // silently share a topic with it.
    expect(FEED).toContain('channel={`feed-tournament-${t.id}`}');
    expect(FEED).not.toContain('`player-tournament-${');
    expect(FEED).not.toContain('`player-tournament-event-${');
  });

  it('watches the tournament whole and its RUNNING events', () => {
    // tournamentId is the one filter that covers an event ADDED mid-tournament,
    // which a per-event id filter would miss.
    expect(FEED).toContain('tournamentId={t.id}');
    expect(FEED).toContain('eventIds={eventIds}');
  });

  it('does NOT pass `draw`, so /feed holds no tournament_matches filter', () => {
    // THE LOAD-BEARING ASSERTION IN THIS FILE.
    //
    // `draw` is what adds a per-event `tournament_matches` listener. The card
    // prints nothing derived from that table, so subscribing would wake a
    // re-render of the app's landing surface on every score the club enters, to
    // redraw a card whose content had not changed. It would also be the one
    // place a member's front door depended on `ready_player_ids`, which does not
    // exist on production yet.
    //
    // Matched on the whole element rather than on the file, because the event
    // page's `draw` is a legitimate use one directory away.
    const mount = /<LiveTournament[\s\S]*?\/>/.exec(FEED);
    expect(mount, 'LiveTournament mount not found').not.toBeNull();
    expect(mount![0]).not.toMatch(/\bdraw\b/);
  });

  it('adds no postgres_changes subscription of its own', () => {
    // The whole point of reusing LiveTournament. A hand-rolled listener here
    // would be a fourth copy of the same 200 lines of reasoning, and it would be
    // invisible to realtime-publication.test.ts if the literal and its config
    // object were separated by prose — the mistake that guard documents.
    expect(FEED).not.toContain('postgres_changes');
  });

  it('mounts one listener per running tournament, not one per event', () => {
    // Several cards multiplex onto one socket: @supabase/ssr caches the browser
    // client in a module singleton, so createClient() hands every mount the same
    // instance. The mount therefore sits inside the tournaments .map(), not
    // inside a per-event loop.
    const perTournament = FEED.indexOf('liveTournaments.map(');
    const mount = FEED.indexOf('<LiveTournament');
    expect(perTournament).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(perTournament);
  });
});

describe('the feed never reads tournament_matches', () => {
  it('names neither the table nor its 00135 column', () => {
    // 00135 is written but NOT APPLIED on production (verified 2026-08-17:
    // tournament_matches has 37 columns, `court` among them and
    // `ready_player_ids` not). PostgREST fails the whole request on one unknown
    // column, so a feed that named it would take the landing page down for every
    // member the moment it deployed.
    expect(FEED).not.toContain('tournament_matches');
    expect(FEED).not.toContain('ready_player_ids');
    expect(FEED).not.toContain('courtLabel');
  });
});
