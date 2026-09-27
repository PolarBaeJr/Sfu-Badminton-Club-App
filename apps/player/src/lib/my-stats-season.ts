// The season scoping behind /my-stats, as builders and pure functions so
// my-stats-season.test.ts runs this exact code rather than a copy of it.
//
// Both screens of that page (the live term and a finished one) read a member's
// matches through `seasonMatchesQuery`, so neither can drift back to a window
// that spans terms. That drift is what put a retired test season's matches under
// the live term's heading: the live read took the last 200 matches of a career
// and every card below it drew from that.
//
// Head-to-head and best partners are derived here from the season's own match
// rows rather than read off `head_to_head_stats` and `partnership_stats`. Those
// two tables are career totals with no season column, so no filter on them can
// answer "this term". The predicate is the one the tables themselves are built
// with (match_counts_toward_stats, 00123), so a term's figures and the career
// figures agree about which matches count.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HistorySeason } from './season-history';

type Client = Pick<SupabaseClient, 'from'>;

/** The columns every /my-stats view draws a match from. */
export const SEASON_MATCH_SELECT =
  'id, season_id, played_at, match_type, format, rated_flag, completed_flag, result_status, walkover_type, score_summary, participants:match_participants!inner(id, player_id, win_flag, rating_delta, post_rating, team_side, points_scored, points_allowed)';

/**
 * One member's matches in one season, newest first.
 *
 * `!inner` plus the filter on the embed drops matches the member was not in.
 * Callers still pick their own participant row by player_id rather than trusting
 * the embed to have been narrowed.
 */
export function seasonMatchesQuery(supabase: Client, playerId: string, seasonId: string, cap: number) {
  return supabase
    .from('matches')
    .select(SEASON_MATCH_SELECT)
    .eq('season_id', seasonId)
    .eq('participants.player_id', playerId)
    .not('played_at', 'is', null)
    .order('played_at', { ascending: false })
    .limit(cap);
}

/**
 * Whether the member played at all in a season: a count and no rows, so asking
 * it of every finished term costs a handful of HEAD requests rather than a career.
 */
export function seasonMatchCountQuery(supabase: Client, playerId: string, seasonId: string) {
  return supabase
    .from('matches')
    .select('id, participants:match_participants!inner(player_id)', { count: 'exact', head: true })
    .eq('season_id', seasonId)
    .eq('participants.player_id', playerId);
}

/**
 * The finished, published seasons worth asking `seasonMatchCountQuery` about.
 *
 * A season the member already has an archived closing rating for is in the
 * picker anyway, so it is not asked again. A hidden one is never asked: it is
 * never offered, whatever it holds.
 */
export function seasonsToProbe(
  seasons: readonly HistorySeason[],
  archivedSeasonIds: ReadonlySet<string>
): string[] {
  return seasons
    .filter((s) => !s.active_flag && s.hidden_flag !== true && !archivedSeasonIds.has(s.id))
    .map((s) => s.id);
}

/**
 * The seasons this member has something in: an archived closing rating, or at
 * least one match. `probes` pairs each probed id with its count read; a read
 * that failed is not evidence of a match, so that season is left out rather
 * than offered on a guess. Leaving it out only hides the door: its URL still
 * works for anyone who has it.
 */
export function memberSeasonIds(
  archivedSeasonIds: ReadonlySet<string>,
  probes: readonly { seasonId: string; count: number | null; failed: boolean }[]
): Set<string> {
  const ids = new Set(archivedSeasonIds);
  for (const p of probes) {
    if (!p.failed && (p.count ?? 0) > 0) ids.add(p.seasonId);
  }
  return ids;
}

/**
 * The season before `activeId` whose closing rating may be drawn on the live
 * chart, or null.
 *
 * Skips hidden seasons. The chart's prior-season rule is labelled with the
 * season's name and its archived rating, and for a hidden season that is
 * exactly the figure the flag was set to keep off every member-facing screen.
 */
export function previousPublishedSeason(
  seasons: readonly HistorySeason[],
  activeId: string | null
): HistorySeason | null {
  if (!activeId) return null;
  const active = seasons.find((s) => s.id === activeId);
  if (!active) return null;
  return (
    seasons
      .filter((s) => s.id !== activeId && s.hidden_flag !== true && s.start_date < active.start_date)
      .sort((a, b) => b.start_date.localeCompare(a.start_date))[0] ?? null
  );
}

/** A match of the member's, reduced to what head-to-head and partners read. */
export interface OwnSeasonMatch {
  id: string;
  match_type: string | null;
  result_status: string | null;
  walkover_type: string | null;
  own: { team_side: string | null; win_flag: boolean | null } | null;
}

/** Every participant row of those matches, the member's own included. */
export interface SeasonParticipantRow {
  match_id: string;
  player_id: string;
  team_side: string | null;
  player: { id: string; full_name: string; avatar_url?: string | null } | null;
}

export interface SeasonPerson {
  id: string;
  full_name: string;
  avatar_url?: string | null;
}

export interface SeasonHeadToHead {
  opponent: SeasonPerson;
  match_type: string;
  wins: number;
  losses: number;
  played: number;
}

export interface SeasonPartner {
  partner: SeasonPerson;
  wins: number;
  losses: number;
  played: number;
  /** 0-100, the same scale partnership_stats stores. */
  winRate: number;
}

/** 00123's match_counts_toward_stats: a confirmed result that was not a forfeit. */
export function countsTowardPairStats(m: Pick<OwnSeasonMatch, 'result_status' | 'walkover_type'>): boolean {
  return m.result_status === 'confirmed' && m.walkover_type === null;
}

function othersByMatch(rows: readonly SeasonParticipantRow[], playerId: string) {
  const map = new Map<string, SeasonParticipantRow[]>();
  for (const row of rows) {
    if (row.player_id === playerId || !row.player) continue;
    const list = map.get(row.match_id);
    if (list) list.push(row);
    else map.set(row.match_id, [row]);
  }
  return map;
}

/**
 * The member's record against each opponent in these matches, most-played
 * first. One entry per opponent per discipline, the way head_to_head_stats is
 * keyed. Opposite team sides only, and both sides must be known: a NULL side
 * cannot be told from a partner, and the table's own recompute drops it too.
 * A counted match with no winner stamped is played by both and won by neither.
 */
export function deriveSeasonHeadToHead(
  matches: readonly OwnSeasonMatch[],
  participants: readonly SeasonParticipantRow[],
  playerId: string,
  limit = 10
): SeasonHeadToHead[] {
  const others = othersByMatch(participants, playerId);
  const byKey = new Map<string, SeasonHeadToHead>();
  for (const m of matches) {
    if (!m.own || !m.match_type || !countsTowardPairStats(m)) continue;
    const mySide = m.own.team_side;
    if (mySide === null) continue;
    for (const o of others.get(m.id) ?? []) {
      if (o.team_side === null || o.team_side === mySide || !o.player) continue;
      const key = `${o.player_id}:${m.match_type}`;
      const entry =
        byKey.get(key) ?? { opponent: o.player, match_type: m.match_type, wins: 0, losses: 0, played: 0 };
      entry.played += 1;
      if (m.own.win_flag === true) entry.wins += 1;
      else if (m.own.win_flag === false) entry.losses += 1;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.played - a.played || a.opponent.full_name.localeCompare(b.opponent.full_name))
    .slice(0, limit);
}

/**
 * The member's doubles partners in these matches with at least `minPlayed`
 * counted matches together, best win rate first. Same side, both sides known,
 * doubles only: the same pairing rule as partnership_stats.
 */
export function deriveSeasonPartners(
  matches: readonly OwnSeasonMatch[],
  participants: readonly SeasonParticipantRow[],
  playerId: string,
  { minPlayed = 3, limit = 5 }: { minPlayed?: number; limit?: number } = {}
): SeasonPartner[] {
  const others = othersByMatch(participants, playerId);
  const byId = new Map<string, SeasonPartner>();
  for (const m of matches) {
    if (!m.own || m.match_type !== 'doubles' || !countsTowardPairStats(m)) continue;
    const mySide = m.own.team_side;
    if (mySide === null) continue;
    for (const o of others.get(m.id) ?? []) {
      if (o.team_side !== mySide || !o.player) continue;
      const entry = byId.get(o.player_id) ?? { partner: o.player, wins: 0, losses: 0, played: 0, winRate: 0 };
      entry.played += 1;
      if (m.own.win_flag === true) entry.wins += 1;
      else if (m.own.win_flag === false) entry.losses += 1;
      byId.set(o.player_id, entry);
    }
  }
  return [...byId.values()]
    .filter((p) => p.played >= minPlayed)
    .map((p) => ({ ...p, winRate: Math.round((p.wins / p.played) * 10000) / 100 }))
    .sort(
      (a, b) =>
        b.winRate - a.winRate || b.played - a.played || a.partner.full_name.localeCompare(b.partner.full_name)
    )
    .slice(0, limit);
}
