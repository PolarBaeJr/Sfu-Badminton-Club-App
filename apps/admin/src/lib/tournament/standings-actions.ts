'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { isDoublesEvent, PLACEMENT_BONUSES } from '@badminton/shared';
import {
  logAudit,
  notifyPlayers,
  revalidateEventPaths,
} from './_helpers';

// ============================================================
// Round Robin Standings (utility)
// ============================================================

export async function computeRoundRobinStandings(eventId: string) {
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) return [];

  const doubles = isDoublesEvent(event.event_type);

  const { data: matches } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .in('status', ['completed', 'walkover']);

  let entries: Array<{ id: string; name: string }> = [];
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, pair_name')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    entries = (pairs ?? []).map(p => ({ id: p.id, name: p.pair_name ?? 'Unnamed' }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, player:players(full_name)')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    entries = (participants ?? []).map(p => ({
      id: p.id,
      name: ((p.player as unknown as Record<string, unknown>)?.full_name as string) ?? 'Unknown',
    }));
  }

  const stats: Record<string, {
    id: string;
    name: string;
    wins: number;
    losses: number;
    pointsFor: number;
    pointsAgainst: number;
    gamesFor: number;
    gamesAgainst: number;
    // Head-to-head wins against every other entry — used as a tiebreaker
    // before resorting to point differentials.
    h2h: Record<string, number>;
  }> = {};

  for (const e of entries) {
    stats[e.id] = { id: e.id, name: e.name, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, gamesFor: 0, gamesAgainst: 0, h2h: {} };
  }

  for (const m of matches ?? []) {
    const aId = doubles ? m.pair_a_id : m.participant_a_id;
    const bId = doubles ? m.pair_b_id : m.participant_b_id;
    if (!aId || !bId || !stats[aId] || !stats[bId]) continue;

    const winnerId = doubles ? m.winner_pair_id : m.winner_participant_id;
    if (winnerId === aId) {
      stats[aId].wins++;
      stats[bId].losses++;
      stats[aId].h2h[bId] = (stats[aId].h2h[bId] ?? 0) + 1;
    } else if (winnerId === bId) {
      stats[bId].wins++;
      stats[aId].losses++;
      stats[bId].h2h[aId] = (stats[bId].h2h[aId] ?? 0) + 1;
    }

    const scores = (m.scores as Array<{ a: number; b: number }>) ?? [];
    for (const g of scores) {
      stats[aId].pointsFor += g.a;
      stats[aId].pointsAgainst += g.b;
      stats[bId].pointsFor += g.b;
      stats[bId].pointsAgainst += g.a;

      if (g.a > g.b) {
        stats[aId].gamesFor++;
        stats[bId].gamesAgainst++;
      } else if (g.b > g.a) {
        stats[bId].gamesFor++;
        stats[aId].gamesAgainst++;
      }
    }
  }

  // Sort: wins desc, head-to-head wins desc (pairwise), games differential desc,
  // point differential desc, points for desc. Head-to-head only breaks ties
  // between the two entries being compared — it's not transitive, so multi-way
  // ties fall through to the differential tiebreakers.
  return Object.values(stats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const h2h = (b.h2h[a.id] ?? 0) - (a.h2h[b.id] ?? 0);
    if (h2h !== 0) return h2h;
    const aGameDiff = a.gamesFor - a.gamesAgainst;
    const bGameDiff = b.gamesFor - b.gamesAgainst;
    if (bGameDiff !== aGameDiff) return bGameDiff - aGameDiff;
    const aDiff = a.pointsFor - a.pointsAgainst;
    const bDiff = b.pointsFor - b.pointsAgainst;
    if (bDiff !== aDiff) return bDiff - aDiff;
    return b.pointsFor - a.pointsFor;
  });
}

// ============================================================
// Placement Bonuses
// ============================================================

export async function applyPlacementBonuses(eventId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'completed') throw new Error('Event must be completed first');
  if (!event.placement_bonus_enabled) throw new Error('Placement bonuses not enabled for this event');

  const doubles = isDoublesEvent(event.event_type);
  const bonuses = doubles ? PLACEMENT_BONUSES.doubles : PLACEMENT_BONUSES.singles;

  const bonusFor = (pos: number | null | undefined): number => {
    if (!pos) return 0;
    if (pos === 1) return bonuses.champion;
    if (pos === 2) return bonuses.finalist;
    if (pos <= 4) return bonuses.semifinalist;
    if (pos <= 8) return bonuses.quarterfinalist;
    return 0;
  };

  const nowIso = new Date().toISOString();

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, final_position')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);

    // A player may appear in multiple pairs — sum bonuses.
    const playerBonus = new Map<string, number>();
    for (const pair of pairs ?? []) {
      const bonus = bonusFor(pair.final_position);
      if (bonus <= 0) continue;
      for (const pid of [pair.player1_id, pair.player2_id]) {
        playerBonus.set(pid, (playerBonus.get(pid) ?? 0) + bonus);
      }
    }

    if (playerBonus.size > 0) {
      const playerIds = [...playerBonus.keys()];
      const { data: ratings } = await adminClient.from('ratings')
        .select('player_id, doubles_elo')
        .in('player_id', playerIds);
      const ratingMap = new Map<string, number>();
      for (const r of ratings ?? []) ratingMap.set(r.player_id, r.doubles_elo ?? 1200);

      const results = await Promise.allSettled(
        [...playerBonus.entries()].map(([pid, bonus]) =>
          adminClient.from('ratings')
            .update({ doubles_elo: (ratingMap.get(pid) ?? 1200) + bonus, updated_at: nowIso })
            .eq('player_id', pid)
        )
      );
      for (const r of results) {
        if (r.status === 'rejected') Sentry.captureException(r.reason);
      }
    }
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, player_id, final_position, elo_change')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);

    const eligible = (participants ?? [])
      .map(p => ({ ...p, bonus: bonusFor(p.final_position) }))
      .filter(p => p.bonus > 0);

    if (eligible.length > 0) {
      const playerIds = eligible.map(p => p.player_id);
      const { data: ratings } = await adminClient.from('ratings')
        .select('player_id, singles_elo')
        .in('player_id', playerIds);
      const ratingMap = new Map<string, number>();
      for (const r of ratings ?? []) ratingMap.set(r.player_id, r.singles_elo ?? 1200);

      // Wrap in Promise.resolve so the Supabase thenable plays nicely with allSettled typing.
      const promises: PromiseLike<unknown>[] = [];
      for (const p of eligible) {
        promises.push(Promise.resolve(adminClient.from('ratings')
          .update({ singles_elo: (ratingMap.get(p.player_id) ?? 1200) + p.bonus, updated_at: nowIso })
          .eq('player_id', p.player_id)));
        const prevChange = (p.elo_change as number | null) ?? 0;
        promises.push(Promise.resolve(adminClient.from('tournament_participants')
          .update({ elo_change: prevChange + p.bonus })
          .eq('id', p.id)));
      }
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === 'rejected') Sentry.captureException(r.reason);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'placement_bonuses_applied',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Finalize Event
// ============================================================

export async function finalizeEvent(eventId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'live') throw new Error('Event must be live to finalize');

  const doubles = isDoublesEvent(event.event_type);

  const { data: incompleteMatches } = await adminClient.from('tournament_matches')
    .select('id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .not('status', 'in', '("completed","walkover","voided","bye")')
    .not('is_bye', 'eq', true);

  const realIncomplete = (incompleteMatches ?? []).filter(m => {
    return doubles
      ? (m.pair_a_id || m.pair_b_id)
      : (m.participant_a_id || m.participant_b_id);
  });

  if (realIncomplete.length > 0) {
    throw new Error(`${realIncomplete.length} match(es) still incomplete`);
  }

  // Assign final positions based on tournament format. We compute the full
  // (id → position) map in memory then issue one parallel batch of UPDATEs.
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const positionMap = new Map<string, number>();

  if (event.format === 'single_elimination') {
    const { data: matches } = await adminClient.from('tournament_matches')
      .select('round_number, winner_pair_id, loser_pair_id, winner_participant_id, loser_participant_id')
      .eq('event_id', eventId)
      .in('status', ['completed', 'walkover'])
      .order('round_number', { ascending: false });

    if (matches && matches.length > 0) {
      const totalRounds = Math.max(...matches.map(m => m.round_number));

      for (const m of matches) {
        const roundsFromFinal = totalRounds - m.round_number;
        const loserPosition = roundsFromFinal === 0 ? 2 : Math.pow(2, roundsFromFinal) + 1;

        const loserId = (doubles ? m.loser_pair_id : m.loser_participant_id) as string | null;
        const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;

        // First-write-wins for losers (later rounds set position before earlier ones).
        if (loserId && !positionMap.has(loserId)) positionMap.set(loserId, loserPosition);
        if (m.round_number === totalRounds && winnerId) positionMap.set(winnerId, 1);
      }
    }
  } else {
    const standings = await computeRoundRobinStandings(eventId);
    standings.forEach((s, i) => positionMap.set(s!.id, i + 1));
  }

  if (positionMap.size > 0) {
    const positionResults = await Promise.allSettled(
      [...positionMap.entries()].map(([id, pos]) =>
        Promise.resolve(adminClient.from(table).update({ final_position: pos }).eq('id', id))
      )
    );
    for (const r of positionResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  }

  // Position-based points for SE; 3 per win + 1 participation for RR.
  const pointsMap = new Map<string, number>();
  if (event.format === 'single_elimination') {
    const { data: allEntries } = await adminClient.from(table)
      .select('id, final_position')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);
    for (const entry of allEntries ?? []) {
      const pos = entry.final_position!;
      let pts: number;
      if (pos === 1) pts = 100;
      else if (pos === 2) pts = 75;
      else if (pos <= 4) pts = 50;
      else if (pos <= 8) pts = 25;
      else pts = 10;
      pointsMap.set(entry.id, pts);
    }
  } else {
    const [rrMatchesRes, allEntriesRes] = await Promise.all([
      adminClient.from('tournament_matches')
        .select('winner_pair_id, winner_participant_id')
        .eq('event_id', eventId)
        .in('status', ['completed', 'walkover']),
      adminClient.from(table)
        .select('id')
        .eq('event_id', eventId)
        .not('status', 'in', '("withdrawn","disqualified")'),
    ]);
    for (const e of allEntriesRes.data ?? []) pointsMap.set(e.id, 1);
    for (const m of rrMatchesRes.data ?? []) {
      const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;
      if (winnerId && pointsMap.has(winnerId)) {
        pointsMap.set(winnerId, (pointsMap.get(winnerId) ?? 0) + 3);
      }
    }
  }

  if (pointsMap.size > 0) {
    const pointsResults = await Promise.allSettled(
      [...pointsMap.entries()].map(([id, pts]) =>
        Promise.resolve(adminClient.from(table).update({ points: pts }).eq('id', id))
      )
    );
    for (const r of pointsResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  }

  await adminClient.from('tournament_events')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (event.placement_bonus_enabled) {
    await applyPlacementBonuses(eventId);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_finalized',
    performed_by: admin.id,
  });

  // Notify all participants that event is completed
  const finalPlayerIds: string[] = [];
  if (doubles) {
    const { data: allPairs } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    for (const pair of allPairs ?? []) {
      finalPlayerIds.push(pair.player1_id, pair.player2_id);
    }
  } else {
    const { data: allParts } = await adminClient.from('tournament_participants')
      .select('player_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    for (const p of allParts ?? []) {
      finalPlayerIds.push(p.player_id);
    }
  }
  const { data: tInfo } = await adminClient.from('tournaments').select('name').eq('id', event.tournament_id).single();
  await notifyPlayers(adminClient, finalPlayerIds,
    'Tournament Completed',
    `${tInfo?.name ?? 'Tournament'} has been finalized. Check the results and your updated Elo rating!`,
    { event_id: eventId, tournament_id: event.tournament_id },
    'tournament_event_completed'
  );

  revalidateEventPaths(event.tournament_id, eventId);
}
