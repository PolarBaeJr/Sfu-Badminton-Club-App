// Internal helpers for the tournament server actions. NOT a 'use server'
// module — these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import {
  calculateEloUpdate,
  getKFactor,
  getMarginMultiplier,
  getFormatWeight,
  getEventRules,
  hasTypedFormat,
  derivedFormatWeight,
  isDoublesEvent,
  isOutOfEvent,
  isOpenMatch,
  forfeitOutcome,
  OPEN_MATCH_STATUSES,
  sortStandings,
  resolveEventWaiverText,
  screenForEventWaiver,
  eventWaiverRefusal,
  ExpectedError,
} from '@badminton/shared';
// By SUBPATH, never through the barrel — eventWaiverHash uses node:crypto and
// the barrel is imported by client components in both apps.
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import type {
  TournamentEventType,
  TournamentMatchFormat,
  MatchFormat,
  RatingSettings,
  SeedBy,
  EventMatchShape,
  AcceptedEventWaiver,
  EventWaiverEntry,
} from '@badminton/shared';

// The tournament engine rates matches in TypeScript while challenges are rated
// by apply_match_result in SQL. Both must read the SAME knobs or the identical
// scoreline moves ratings differently depending on where it was played — the
// cross-engine hazard the rounding comment in the Elo engine already warns
// about. This is the TS half of migration 00041.
//
// Fetched per call rather than cached: finalising an event is not a hot path,
// and a cache is how a mid-tournament settings change ends up applying to some
// matches and not others.
export async function getRatingSettings(
  adminClient: ReturnType<typeof createAdminClient>,
): Promise<RatingSettings | null> {
  const { data, error } = await adminClient
    .from('platform_settings')
    .select('value')
    .eq('key', 'rating_defaults')
    .maybeSingle();
  // A MISSING row legitimately means "no overrides configured" and falls back to
  // the shared constants. A FAILED READ does not: it is indistinguishable from
  // that at the call site, so the K-factors, bounds and sweep multiplier the
  // whole rating is computed from would quietly become the code defaults — and
  // the wrong delta would then be written as a real, reversible result. Live
  // settings already differ from the constants (singles_k_established is 36, not
  // 48), so this is a visible corruption, not a theoretical one.
  if (error) {
    throw new Error(`Could not read rating settings: ${error.message}`);
  }
  return (data?.value as RatingSettings | null) ?? null;
}

export { requireCapability } from '../actions/_shared';

// ============================================================
// Batched writes
// ============================================================

/**
 * A labelled PostgREST write, ready to be run as part of a batch.
 * The label is what an exec reads when the batch fails, so name the row.
 */
export type LabelledWrite = readonly [label: string, write: PromiseLike<unknown>];

export interface WriteFailure {
  label: string;
  message: string;
}

export interface SettledWrites {
  /** Every write that did not land, in input order. */
  failures: WriteFailure[];
  /** Per-input-index: did this write actually land? Parallel to the input array. */
  landed: boolean[];
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.length > 0 ? message : 'unknown database error';
}

/**
 * Run independent writes in parallel and report, per write, whether it landed.
 *
 * This exists because `Promise.allSettled` on its own is a trap here. A
 * supabase-js PostgrestBuilder RESOLVES with `{ data, error }` and only rejects
 * on a transport failure — `.throwOnError()` is opt-in and is used nowhere in
 * this repo. So an RLS denial, a check-constraint violation or any other
 * Postgres error arrives as a FULFILLED promise carrying `error`, and the
 * `if (r.status === 'rejected')` idiom this replaces threw every one of them
 * away. That is how a tournament result could report "saved" while one player's
 * rating never moved: no Sentry event, no audit row, no toast.
 *
 * Inspecting `{ error }` rather than switching every builder to
 * `.throwOnError()` is deliberate: it catches BOTH shapes (a rejected transport
 * failure and a resolved Postgres error) in one place, and it needs no change
 * at the ~40 call sites that build the writes.
 */
export async function settleWrites(writes: readonly LabelledWrite[]): Promise<SettledWrites> {
  const settled = await Promise.allSettled(writes.map(([, write]) => Promise.resolve(write)));
  const failures: WriteFailure[] = [];
  const landed = settled.map((result, i) => {
    const label = writes[i]![0];
    if (result.status === 'rejected') {
      failures.push({ label, message: writeErrorMessage(result.reason) });
      return false;
    }
    const error = (result.value as { error?: unknown } | null)?.error;
    if (error) {
      failures.push({ label, message: writeErrorMessage(error) });
      return false;
    }
    return true;
  });
  return { failures, landed };
}

/**
 * Turn a partial batch failure into a thrown error the caller has to deal with.
 *
 * Nothing is reported to Sentry here on purpose. Every caller either throws out
 * of a server action (Next's instrumentation captures it) or is wrapped in
 * runAction (which captures it), so capturing here as well would file every
 * one of these twice.
 */
export function assertWritesSucceeded(action: string, failures: readonly WriteFailure[]): void {
  if (failures.length === 0) return;
  const detail = failures.map(f => `${f.label} (${f.message})`).join('; ');
  throw new Error(
    `${action}: ${failures.length} database write(s) failed and the change is incomplete — ${detail}`,
  );
}

// Revalidate both the tournament page and the event detail page so admin UIs
// reflect mutations immediately. Pass eventId whenever it is in scope.
export function revalidateEventPaths(tournamentId: string, eventId?: string) {
  revalidatePath(`/tournaments/${tournamentId}`);
  if (eventId) revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Throws when the tournament is suspended. Called by mutating tournament
// actions before they touch data; corrective actions (void/edit/undo,
// lock/unlock draw) intentionally skip this gate.
export async function assertTournamentNotSuspended(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string
) {
  const { data } = await adminClient.from('tournaments')
    .select('suspended_at, suspension_reason')
    .eq('id', tournamentId)
    .single();
  if (data?.suspended_at) {
    const reason = data.suspension_reason;
    throw new Error(`Tournament is suspended${reason ? `: ${reason}` : ''}. Resume it to continue.`);
  }
}

// ============================================================
// Event waivers — the hard block on taking part
// ============================================================
// An exec may add anybody to a tournament; that is deliberate and unchanged,
// because somebody joining on the morning of an event has to be able to get
// onto the sheet. What they may not do is PLAY without having accepted the
// tournament's event waiver, and check-in is where that is enforced.
//
// WHY THIS READ IS NOT GATED ON `tournaments.draw.waivers.read`. That capability
// gates the roster's DISPLAY of waiver state — an exec looking up who has
// signed. This is the enforcement read, run by check-in itself on the way to
// deciding whether a write is allowed at all. Gating enforcement on a
// display permission would mean an officer who lacks that permission could
// check in unsigned entrants, which is precisely backwards: the narrower
// somebody's access, the MORE the rule would relax.

/** Everything the screening needs, loaded once for a whole tournament. */
export interface TournamentWaiverContext {
  /** null when this tournament has no waiver — every entry then passes. */
  requiredHash: string | null;
  acceptances: AcceptedEventWaiver[];
}

/**
 * Load a tournament's waiver requirement and every acceptance recorded against
 * it, in two reads, regardless of how many entrants are being screened.
 *
 * A FAILED READ IS NOT "NOBODY SIGNED". Treating an error as an empty
 * acceptance list would refuse an entire field at the door because Postgres
 * hiccuped, so it throws and the caller reports that nothing was changed. The
 * opposite default — treating an error as "no waiver required" — would be worse
 * still: it would silently disable the gate.
 */
export async function loadTournamentWaiverContext(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
): Promise<TournamentWaiverContext> {
  const { data: tournament, error: tournamentError } = await adminClient
    .from('tournaments')
    .select('waiver_text')
    .eq('id', tournamentId)
    .maybeSingle();
  if (tournamentError) {
    Sentry.captureException(tournamentError);
    throw new Error('Could not check this tournament’s event waiver. Nothing was changed — try again.');
  }

  const text = resolveEventWaiverText(tournament);
  if (!text) return { requiredHash: null, acceptances: [] };

  // The hash is always taken from the SERVER's copy of the text, never from
  // anything a client sent — the same rule registerForEvent follows.
  const requiredHash = eventWaiverHash(text);

  const { data: acceptances, error: acceptancesError } = await adminClient
    .from('event_waiver_acceptances')
    .select('player_id, waiver_hash, accepted_at')
    .eq('tournament_id', tournamentId);
  if (acceptancesError) {
    Sentry.captureException(acceptancesError);
    throw new Error('Could not check who has signed the event waiver. Nothing was changed — try again.');
  }

  return { requiredHash, acceptances: (acceptances ?? []) as AcceptedEventWaiver[] };
}

/**
 * Refuse outright — for the paths that check in exactly ONE entry, where there
 * is nothing to partition and the exec pressed a button next to a name.
 */
export async function assertEventWaiverSigned(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  entry: EventWaiverEntry,
): Promise<void> {
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, tournamentId);
  const { blocked } = screenForEventWaiver([entry], requiredHash, acceptances);
  // ExpectedError, not Error: Next.js redacts errors thrown out of a server
  // action in production, and a redacted message at the check-in desk is the
  // unexplained refusal this whole design is trying not to create.
  if (blocked.length > 0) throw new ExpectedError(eventWaiverRefusal(blocked));
}

/**
 * THE SECOND ENFORCEMENT POINT: the draw.
 *
 * Check-in is the obvious place to stop an unsigned entrant, and it is not
 * sufficient on its own. Bracket generation seeds from
 * `status IN ('registered','checked_in')` — it does NOT require a check-in — so
 * an unsigned member an exec added lands in the draw, is handed an opponent and
 * a court, and plays, having passed no gate at all. "Must not be able to take
 * part" has to hold here too or it does not hold.
 *
 * REFUSES WHOLE rather than partitioning, which is the opposite of what
 * bulkCheckIn does, and deliberately. Check-in is a queue of people arriving one
 * at a time, where excluding somebody costs them a wait. A draw is a single
 * structure: quietly generating it without three of the field produces a
 * bracket that LOOKS complete, with byes where people should be, and the exec
 * finds out when somebody turns up for a match that was never created. Better to
 * refuse, name them, and let the exec chase the signatures or withdraw them.
 *
 * Screened from the FIELD as built rather than from the event's rows, so a
 * pool-seeded bracket is covered by the same call — its field is promoted from
 * another event and would otherwise never be looked at.
 */
export async function assertDrawFieldEventWaiverSigned(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  entryIds: readonly string[],
  doubles: boolean,
): Promise<void> {
  if (entryIds.length === 0) return;
  const { requiredHash, acceptances } = await loadTournamentWaiverContext(adminClient, tournamentId);
  if (!requiredHash) return;

  const { data: rows, error } = doubles
    ? await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
      .in('id', entryIds as string[])
    : await adminClient.from('tournament_participants')
      .select('id, player_id, player:players!player_id(full_name)')
      .in('id', entryIds as string[]);
  // A failed read must not read as "everybody has signed".
  if (error) {
    Sentry.captureException(error);
    throw new Error('Could not check who has signed the event waiver. The draw was not generated — try again.');
  }

  const entries: EventWaiverEntry[] = (rows ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const name = (embed: unknown, fallback: string) => {
      const one = Array.isArray(embed) ? embed[0] : embed;
      return (one as { full_name?: string | null } | null)?.full_name || fallback;
    };
    return {
      id: r.id as string,
      members: doubles
        ? [
          { id: r.player1_id as string, name: name(r.player1, r.player1_id as string) },
          { id: r.player2_id as string, name: name(r.player2, r.player2_id as string) },
        ]
        : [{ id: r.player_id as string, name: name(r.player, 'This player') }],
    };
  });

  const { blocked } = screenForEventWaiver(entries, requiredHash, acceptances);
  if (blocked.length === 0) return;
  throw new ExpectedError(
    `${eventWaiverRefusal(blocked)} The draw was not generated — get their signatures, or take them out of the event first.`,
  );
}

/**
 * The members of a pair, in a shape screenForEventWaiver understands, from the
 * embedded player rows the pair selects already carry. Falls back to the id so
 * a missing name degrades to something unhelpful rather than to a crash — the
 * refusal still names two distinct people.
 */
export function pairWaiverMembers(pair: {
  player1_id: string;
  player2_id: string;
  player1?: { full_name?: string | null } | { full_name?: string | null }[] | null;
  player2?: { full_name?: string | null } | { full_name?: string | null }[] | null;
}): { id: string; name: string }[] {
  const name = (embed: unknown, fallback: string) => {
    const row = Array.isArray(embed) ? embed[0] : embed;
    return (row as { full_name?: string | null } | null)?.full_name || fallback;
  };
  return [
    { id: pair.player1_id, name: name(pair.player1, pair.player1_id) },
    { id: pair.player2_id, name: name(pair.player2, pair.player2_id) },
  ];
}

/**
 * PUSH THE SIGNATURE AT THE MEMBER, the moment an exec adds them.
 *
 * Being added must ACTIVELY ask for the signature, not wait to be noticed at
 * the door. Three things carry that, and the notification is only one of them:
 *
 *   1. this notification (and a push, for anyone who opted into tournaments),
 *   2. a blocking panel on the tournament page, which a member who never opens
 *      a notification still cannot miss, and
 *   3. check-in, which refuses regardless of whether either was read.
 *
 * Layer 3 is the one that is load-bearing. 1 and 2 exist so that nobody has to
 * find out at the door.
 *
 * TYPE `general`, DELIBERATELY. Eight of the twenty-one notification_type
 * values have no producer anywhere and are dead letters; `general` has three
 * live producers and metadata-driven routing, and `tournament_id` in its
 * metadata is exactly the key notificationAction() reads to send the tap to
 * /tournaments/<id> — which is where the panel that takes the signature lives.
 * A new enum value would need an ALTER TYPE, a TYPES entry and a routing branch
 * to arrive at the same page.
 *
 * Best-effort by construction: notifyPlayers reports to Sentry and never
 * throws, because the member IS added and an action that reported failure would
 * send the exec looking for a person already on the sheet.
 */
export async function notifyEventWaiverRequired(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  tournamentName: string,
  playerIds: string[],
): Promise<void> {
  if (playerIds.length === 0) return;
  const body =
    `You have been entered in ${tournamentName}, which has an event waiver. ` +
    'Read and accept it before you turn up — you cannot be checked in until you do.';

  // IMPORTED LAZILY, and that is not an optimisation. ../notify begins with
  // `import 'server-only'`, and this module is imported DIRECTLY by two vitest
  // suites (tournament-recovery, tournament-write-integrity) which run outside
  // Next's resolver and cannot resolve that package. A static import here fails
  // both of them at load time, before a single assertion runs — so the
  // dependency is taken at call time, where only Next ever stands.
  //
  // ../notify rather than this module's own leaner notifyPlayers because this
  // is the one tournament notification where PUSH earns its place: acting on it
  // before you set off is the difference between signing at home and being
  // turned away at the door. It also honours the per-category opt-in, which the
  // local helper knows nothing about.
  const { notifyPlayers: notifyPlayersWithPush } = await import('../notify');
  await notifyPlayersWithPush(
    adminClient,
    playerIds,
    {
      type: 'general',
      title: 'Event waiver needed',
      body,
      metadata: { tournament_id: tournamentId, kind: 'event_waiver_required' },
    },
    { title: 'Event waiver needed', body, url: `/tournaments/${tournamentId}` },
    'tournaments',
  );
}

/**
 * Who among a freshly added group still owes a signature, and the tournament's
 * name for the message. Returns an empty list when the tournament has no waiver
 * — the common case, and one read rather than a notification nobody needs.
 *
 * Swallows its own failures. Every caller runs this AFTER the entrant is
 * committed, so a failure here must cost a notification, never the add.
 */
export async function unsignedAmong(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  playerIds: string[],
): Promise<{ unsigned: string[]; tournamentName: string }> {
  if (playerIds.length === 0) return { unsigned: [], tournamentName: '' };
  try {
    const { data: tournament } = await adminClient
      .from('tournaments')
      .select('name, waiver_text')
      .eq('id', tournamentId)
      .maybeSingle();
    const text = resolveEventWaiverText(tournament);
    if (!text) return { unsigned: [], tournamentName: '' };

    const requiredHash = eventWaiverHash(text);
    const { data: acceptances } = await adminClient
      .from('event_waiver_acceptances')
      .select('player_id, waiver_hash, accepted_at')
      .eq('tournament_id', tournamentId)
      .in('player_id', playerIds);

    const { blocked } = screenForEventWaiver(
      playerIds.map((id) => ({ id, members: [{ id, name: id }] })),
      requiredHash,
      (acceptances ?? []) as AcceptedEventWaiver[],
    );
    return {
      unsigned: blocked.map((entry) => entry.id),
      tournamentName: (tournament?.name as string) ?? 'a tournament',
    };
  } catch (err) {
    Sentry.captureException(err);
    return { unsigned: [], tournamentName: '' };
  }
}

// Map tournament match format to the shared elo engine's MatchFormat
function toEloFormat(mf: TournamentMatchFormat): MatchFormat {
  switch (mf) {
    case 'best_of_3_to_21': return 'bo3_21';
    case 'one_game_21': return 'single_21';
    case 'one_game_15': return 'single_15';
    case 'one_game_11': return 'single_11';
  }
}

// ============================================================
// Notification helper
// ============================================================

export async function notifyPlayers(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: string[],
  title: string,
  body: string,
  metadata?: Record<string, unknown>,
  notificationType: 'general' | 'tournament_bracket_published' | 'tournament_match_ready' | 'tournament_match_result' | 'tournament_event_completed' | 'tournament_checkin_open' = 'general'
) {
  if (playerIds.length === 0) return;
  try {
    const rows = playerIds.map(pid => ({
      player_id: pid,
      type: notificationType,
      title,
      body,
      metadata: metadata ?? {},
    }));
    const { error } = await adminClient.from('notifications').insert(rows);
    if (error) throw error;
  } catch (err) {
    // Notifications are best-effort — never let a failure break the parent action.
    Sentry.captureException(err);
  }
}

// Pull the event/tournament context from a joined select on the UPDATE itself
// so participant/pair status mutations don't need a second round-trip just to
// figure out which paths to revalidate.
export const participantContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;
export const pairContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;

export function extractEventContext(row: { event_id?: unknown; event?: unknown } | null): { tid: string; eventId: string } | null {
  if (!row) return null;
  const eventId = row.event_id as string | undefined;
  const tid = (row.event as { tournament_id?: string } | null)?.tournament_id;
  if (!eventId || !tid) return null;
  return { tid, eventId };
}

// Field on a match row holding one side's entry, for the discipline in play.
//
// Lives here rather than in results.ts because both the winner route and the
// loser route (00080) have to resolve a side to the same column name. Two
// copies of this two-line function is how a loser ends up written into
// participant_a_id on a doubles event.
export function entrySideField(side: 'a' | 'b', doubles: boolean): string {
  if (doubles) return side === 'a' ? 'pair_a_id' : 'pair_b_id';
  return side === 'a' ? 'participant_a_id' : 'participant_b_id';
}

/**
 * The two ways a match can feed another one.
 *
 * `winner` has always existed. `loser` arrives with the third-place playoff
 * (00080) and is deliberately the same shape, because every rule that protects
 * the winner route has to protect this one too — a semi-final that has already
 * put its loser into a played third-place match is exactly as un-voidable as one
 * that has put its winner into a played final.
 */
export const MATCH_ROUTES = ['winner', 'loser'] as const;
export type MatchRoute = (typeof MATCH_ROUTES)[number];

/** Read one route off a match row: where it sends that side, and to which slot. */
export function routeOf(
  match: Record<string, unknown>,
  route: MatchRoute,
): { nextId: string; side: 'a' | 'b' } | null {
  const nextId = match[`${route}_to_match_id`] as string | null;
  if (!nextId) return null;
  return { nextId, side: match[`${route}_to_position`] === 'a' ? 'a' : 'b' };
}

/** The entry a decided match sent along `route`, or null if it has none. */
export function routedEntryId(
  match: Record<string, unknown>,
  route: MatchRoute,
  doubles: boolean,
): string | null {
  const field = route === 'winner'
    ? (doubles ? 'winner_pair_id' : 'winner_participant_id')
    : (doubles ? 'loser_pair_id' : 'loser_participant_id');
  return (match[field] as string | null) ?? null;
}

/**
 * Standard tournament seeding positions.
 * For a bracket of size B, returns an array of length B where
 * index = bracket position, value = seed number (1-based).
 * Ensures seed 1 and 2 are on opposite halves, 3/4 in opposite quarters, etc.
 */
export function getStandardSeedPositions(bracketSize: number): number[] {
  if (bracketSize < 2) return [1];

  // Start with seeds 1 and 2
  let positions = [1, 2];

  while (positions.length < bracketSize) {
    const nextRound: number[] = [];
    const sum = positions.length * 2 + 1;
    for (const seed of positions) {
      nextRound.push(seed);
      nextRound.push(sum - seed);
    }
    positions = nextRound;
  }

  return positions;
}

// ============================================================
// Elo Integration
// ============================================================

export async function applyTournamentMatchElo(matchId: string) {
  const adminClient = createAdminClient();

  // Every read below is error-checked, and that is load-bearing rather than
  // tidiness. This function runs AFTER the result row has been written, so
  // returning quietly on a failed read reports the match as rated when nothing
  // was — and the caller's compensation never fires, because nothing threw. A
  // transient read failure would leave exactly the decided-but-unrated match
  // undoDecidedResult exists to prevent.
  const { data: match, error: matchErr } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (matchErr) {
    throw new Error(`Could not read match ${matchId} to rate it — ${matchErr.message}`);
  }
  if (!match || match.status === 'voided' || match.is_bye) return;

  // Idempotency backstop: a populated elo_snapshot means this match's delta was
  // already applied. Re-applying would overwrite the snapshot and strand the
  // first delta with no way to reverse it, so refuse instead. Callers that
  // legitimately re-rate a match (editMatchResult) reverse the snapshot first,
  // which clears it.
  if (match.elo_snapshot) return;

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const shape = event as unknown as EventMatchShape;
  const rules = getEventRules(shape);
  const eloMultiplier = Number(event.elo_multiplier) || 1.25;
  // A typed format has no entry in the weight table, so its weight is derived
  // from the shape the same way 00031 derives it for custom challenges. Without
  // this, a pool played at 1 game to 15 would move ratings as if it were the
  // event's fallback enum — usually best of 3 to 21, worth 2.5x as much.
  const formatWeight = hasTypedFormat(shape)
    ? derivedFormatWeight(rules.bestOf, rules.target)
    : getFormatWeight(toEloFormat(event.match_format as TournamentMatchFormat));

  // What this match does to one player's ratings row. Everything except
  // participant_id is required by apply_tournament_match_rating; only the four
  // rating fields end up in the persisted snapshot.
  //
  // The statistics travel with the delta because the tournament path used to
  // move singles_elo/doubles_elo and NOTHING else — no matches_played, no
  // wins/losses, no points, no games, no streak, and the provisional flag never
  // cleared. Since the placement K-factor is chosen FROM matches_played, a
  // tournament regular stayed on the provisional K forever and their stats
  // disagreed with their own rating. Live aggregates already show the gap.
  const ratingEntries: Array<{
    player_id: string;
    before: number;
    after: number;
    delta: number;
    won: boolean;
    points_scored: number;
    points_allowed: number;
    games_won: number;
    games_lost: number;
    /** Singles only — doubles has no per-player participant row to stamp. */
    participant_id?: string;
  }> = [];
  const snapshotDiscipline: 'singles' | 'doubles' = doubles ? 'doubles' : 'singles';

  const ratingSettings = await getRatingSettings(adminClient);

  // Margin-of-victory scaling, the other half of the knob-sharing this file
  // already claims to do. apply_match_result passes
  // get_margin_multiplier(games_won, games_lost) for every challenge; this path
  // passed nothing, so marginMultiplier defaulted to 1.0 and the identical 2-0
  // moved ratings 15% LESS in a tournament than as a challenge.
  //
  // Computed once for the match rather than per side: getMarginMultiplier is
  // symmetric in (won, lost) — a sweep is a sweep for whoever was on the
  // receiving end — so 2-0 and 0-2 both return the sweep value and 2-1 / 1-2
  // both return 1.0. The SQL side evaluates it per participant and gets the
  // same number; doing it once here removes any way to get the orientation
  // wrong. A walkover carries no scores at all, so total games is 0 and the
  // multiplier is 1.0 — which is what the SQL walkover branch does too.
  const matchScores = (match.scores as Array<{ a: number; b: number }> | null) ?? [];
  const gamesA = matchScores.filter(g => g.a > g.b).length;
  const gamesB = matchScores.filter(g => g.b > g.a).length;
  const marginMultiplier = getMarginMultiplier(
    gamesA,
    gamesB,
    ratingSettings?.sweep_margin_multiplier ?? undefined,
  );

  // The same per-side figures apply_match_result reads off match_participants
  // for a challenge. Doubles gives both players of a pair the pair's totals,
  // which is what match_participants holds for a doubles team.
  //
  // A walkover carries no scores at all, so every figure here is 0 — again
  // matching the challenge path, where a walkover has no match_games rows.
  const pointsA = matchScores.reduce((n, g) => n + g.a, 0);
  const pointsB = matchScores.reduce((n, g) => n + g.b, 0);
  const statsForSide = (isSideA: boolean) => ({
    points_scored: isSideA ? pointsA : pointsB,
    points_allowed: isSideA ? pointsB : pointsA,
    games_won: isSideA ? gamesA : gamesB,
    games_lost: isSideA ? gamesB : gamesA,
  });

  if (doubles) {
    // For doubles, update both players in winning and losing pairs
    const winnerId = match.winner_pair_id;
    const loserId = match.loser_pair_id;
    if (!winnerId || !loserId) return;

    // Fetch both pairs in parallel.
    const [
      { data: winnerPair, error: winnerPairErr },
      { data: loserPair, error: loserPairErr },
    ] = await Promise.all([
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', loserId).single(),
    ]);

    // Both ids came off the match row above, so a pair that cannot be read is a
    // failure, not the unopposed case — that one is caught by the null check on
    // the ids themselves. Returning here would report the match as rated.
    if (winnerPairErr || loserPairErr || !winnerPair || !loserPair) {
      throw new Error(
        `Could not read the pairs in match ${matchId} to rate it — ` +
        `${winnerPairErr?.message ?? loserPairErr?.message ?? 'a pair row is missing'}`,
      );
    }

    const winnerElo = winnerPair.combined_elo ?? 400;
    const loserElo = loserPair.combined_elo ?? 400;

    // Single batched ratings fetch for all 4 players
    const allPlayerIds = [winnerPair.player1_id, winnerPair.player2_id, loserPair.player1_id, loserPair.player2_id];
    const { data: ratings, error: ratingsErr } = await adminClient.from('ratings')
      .select('player_id, doubles_elo, doubles_provisional, doubles_matches_played')
      .in('player_id', allPlayerIds);

    // A failed ratings read used to fall through to the `?? 400` defaults below,
    // which would rate four established players as if they were all on the floor
    // rating — and write that as a real, reversible delta.
    if (ratingsErr) {
      throw new Error(`Could not read current ratings to rate match ${matchId} — ${ratingsErr.message}`);
    }

    const computeFor = (playerId: string, opponentElo: number, won: boolean) => {
      const rating = ratings?.find(r => r.player_id === playerId);
      const before = rating?.doubles_elo ?? 400;
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played, ratingSettings);
      const result = calculateEloUpdate({
        playerRating: before,
        opponentRating: opponentElo,
        kFactor: k,
        formatWeight,
        eventMultiplier: eloMultiplier,
        marginMultiplier,
        bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
        won,
      });
      return { playerId, before, newRating: result.newRating, delta: result.delta };
    };

    // Which physical side of the match the winning pair occupies, so the points
    // and games attach to the right players.
    const winnerIsA = winnerId === match.pair_a_id;
    const winnerStats = statsForSide(winnerIsA);
    const loserStats = statsForSide(!winnerIsA);

    ratingEntries.push(
      ...[
        computeFor(winnerPair.player1_id, loserElo, true),
        computeFor(winnerPair.player2_id, loserElo, true),
      ].map(c => ({
        player_id: c.playerId, before: c.before, after: c.newRating, delta: c.delta,
        won: true, ...winnerStats,
      })),
      ...[
        computeFor(loserPair.player1_id, winnerElo, false),
        computeFor(loserPair.player2_id, winnerElo, false),
      ].map(c => ({
        player_id: c.playerId, before: c.before, after: c.newRating, delta: c.delta,
        won: false, ...loserStats,
      })),
    );
  } else {
    // Singles
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;
    if (!winnerId || !loserId) return;

    // Fetch both participants in parallel
    const [
      { data: winnerP, error: winnerPErr },
      { data: loserP, error: loserPErr },
    ] = await Promise.all([
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single(),
    ]);

    // As for pairs above: both ids came off the match row, so this is a failure
    // and not the unopposed case.
    if (winnerPErr || loserPErr || !winnerP || !loserP) {
      throw new Error(
        `Could not read the participants in match ${matchId} to rate it — ` +
        `${winnerPErr?.message ?? loserPErr?.message ?? 'a participant row is missing'}`,
      );
    }

    // Single batched ratings fetch
    const { data: ratings, error: ratingsErr } = await adminClient.from('ratings')
      .select('player_id, singles_elo, singles_provisional, singles_matches_played')
      .in('player_id', [winnerP.player_id, loserP.player_id]);

    // Without this, a failed read falls through to elo_before / 400 below and
    // rates the match off registration-time or floor ratings.
    if (ratingsErr) {
      throw new Error(`Could not read current ratings to rate match ${matchId} — ${ratingsErr.message}`);
    }

    const winnerRating = ratings?.find(r => r.player_id === winnerP.player_id);
    const loserRating = ratings?.find(r => r.player_id === loserP.player_id);

    const winnerElo = winnerRating?.singles_elo ?? winnerP.elo_before ?? 400;
    const loserElo = loserRating?.singles_elo ?? loserP.elo_before ?? 400;

    const winK = getKFactor('singles', winnerRating?.singles_provisional ?? true, winnerRating?.singles_matches_played, ratingSettings);
    const loseK = getKFactor('singles', loserRating?.singles_provisional ?? true, loserRating?.singles_matches_played, ratingSettings);

    const winResult = calculateEloUpdate({
      playerRating: winnerElo,
      opponentRating: loserElo,
      kFactor: winK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      marginMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
      won: true,
    });

    const loseResult = calculateEloUpdate({
      playerRating: loserElo,
      opponentRating: winnerElo,
      kFactor: loseK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      marginMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
      won: false,
    });

    const winnerIsA = winnerId === match.participant_a_id;
    const winnerStats = statsForSide(winnerIsA);
    const loserStats = statsForSide(!winnerIsA);

    ratingEntries.push(
      {
        player_id: winnerP.player_id, before: winnerElo,
        after: winResult.newRating, delta: winResult.delta,
        won: true, ...winnerStats, participant_id: winnerId,
      },
      {
        player_id: loserP.player_id, before: loserElo,
        after: loseResult.newRating, delta: loseResult.delta,
        won: false, ...loserStats, participant_id: loserId,
      },
    );
  }

  if (ratingEntries.length === 0) return;

  // ONE transaction for every write this match causes: each player's Elo AND
  // match statistics, the singles participants' elo_after/elo_change, and the
  // reversal snapshot.
  //
  // These used to be four-plus separate PostgREST round trips with the snapshot
  // written last. A failure on that final write left the ladder moved with
  // nothing recording by how much — and undoMatchResult, voidMatch and
  // editMatchResult all reverse from the snapshot, so the half-state could not
  // be repaired from the club app at all. The old code's own error message said
  // "the applied deltas must be corrected by hand". Postgres now guarantees the
  // pairing instead of the error message apologising for it.
  //
  // The RPC also re-checks elo_snapshot IS NULL under a row lock, so two desks
  // entering the same result at once cannot both apply a delta.
  const { error: rpcError } = await adminClient.rpc('apply_tournament_match_rating', {
    p_match_id: matchId,
    p_discipline: snapshotDiscipline,
    p_entries: ratingEntries,
  });

  if (rpcError) {
    // Nothing landed — the whole call rolled back — so this is safe to retry
    // and safe to leave alone. That is the entire point of the change.
    throw new Error(
      `Elo update for match ${matchId} failed and NOTHING was applied — ${rpcError.message}`,
    );
  }
}

/**
 * Undo everything a rated tournament match did: each player's Elo delta and
 * match statistics, the reliability counter, the singles participants'
 * elo_after/elo_change, and the snapshot itself.
 *
 * The whole reversal is ONE transaction inside
 * reverse_tournament_match_rating (00078). It used to be a batch of PostgREST
 * read-modify-writes here, and that shape carried a defect no amount of care in
 * TypeScript could close: the ratings came off the ladder in one round trip and
 * the REDUCED snapshot went back in another. When the second one failed, the
 * ORIGINAL snapshot survived on a match whose deltas were already gone — so the
 * next void/undo/edit reversed the same entries a second time. Since 00070 the
 * statistics travel with the Elo, so a double reverse also strips a
 * matches_played, a win, and a set of points and games the match never added.
 * The floors at 0 made that quieter, not rarer.
 *
 * That is also why the old partial-reversal machinery is gone rather than
 * ported. Keeping the un-reversed entries on the snapshot and retrying the
 * remainder was the mitigation for a batch that could half-land; nothing can
 * half-land now, so there is never a remainder.
 *
 * Reversing is therefore idempotent: the snapshot is cleared in the same
 * transaction as the deltas, and a match with no snapshot has nothing to undo,
 * so the RPC returns quietly. A retry after an unclear outcome is safe.
 *
 * The statistics half is not optional. editMatchResult reverses the snapshot and
 * then RE-rates the match, so a reversal that left matches_played/wins/points
 * behind would add a second set of counts on every correction; undo and void
 * would leave a result in the statistics that no longer exists.
 *
 * Two figures still cannot be reversed unconditionally, and the SQL handles both:
 *   - best_*_streak is a high-water mark. It is never written on the way back
 *     out, exactly as it is never written on the way in.
 *   - current_*_streak is restored EXACTLY when the match being undone is still
 *     the player's most recent rated one — 00078 stores the streak before and
 *     after, and compares the stored "after" with what is in the row. Before
 *     that, undoing a win by a player who had been on -3 left them on 0 rather
 *     than -3. If a later match has moved the streak since, the old
 *     step-toward-zero applies instead, because rewinding to the stored value
 *     would erase that later match.
 */
export async function reverseEloSnapshot(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
) {
  const { error } = await adminClient.rpc('reverse_tournament_match_rating', {
    p_match_id: matchId,
  });

  // Nothing landed — the whole call rolled back — so the snapshot is still on
  // the match and a retry reverses it once. Callers turn this into a refusal:
  // a void or an undo that could not hand the rating back has not happened.
  if (error) {
    throw new Error(
      `Elo reversal for match ${matchId} failed and NOTHING was reversed — ${error.message}`,
    );
  }
}

/**
 * Put a match back the way it was found, then rethrow, after its rating failed.
 *
 * Both entry points write the result row BEFORE rating it — they have to, since
 * applyTournamentMatchElo reads the winner and loser off the row. So an RPC
 * failure used to leave a match decided but UNRATED, and nothing could retry it:
 * enterMatchResult refuses anything that is not pending/ready/live, and the
 * withdrawal cascade skips matches that are no longer open. The ratings were
 * never applied — 00070 made that atomic — but the result was, and the pair
 * could not be completed by any action in the console.
 *
 * Undoing the result write restores the only state a retry can start from.
 * Advancement has deliberately not happened yet at either call site (rating runs
 * first, precisely so a later match is rated against the rating an earlier one
 * left behind), so there is nothing downstream to unwind here.
 *
 * Every field either writer touches is restored from the row as it was read,
 * rather than nulled: `status` in particular can legitimately be pending, ready
 * or live, and guessing would decide the bracket's state on the caller's behalf.
 */
export async function undoDecidedResult(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  prior: Record<string, unknown>,
  cause: unknown,
): Promise<never> {
  const restore = {
    status: prior.status ?? 'ready',
    scores: prior.scores ?? null,
    time_exceeded: prior.time_exceeded ?? false,
    winner_participant_id: prior.winner_participant_id ?? null,
    loser_participant_id: prior.loser_participant_id ?? null,
    winner_pair_id: prior.winner_pair_id ?? null,
    loser_pair_id: prior.loser_pair_id ?? null,
    walkover_winner: prior.walkover_winner ?? null,
    walkover_reason: prior.walkover_reason ?? null,
    result_entered_by: prior.result_entered_by ?? null,
    result_entered_at: prior.result_entered_at ?? null,
    updated_at: new Date().toISOString(),
  };

  const detail = cause instanceof Error ? cause.message : String(cause);

  // `elo_snapshot IS NULL` is the whole safety of this write, and it is a
  // condition on the row rather than on anything this request remembers.
  //
  // The rating did not necessarily fail to happen just because THIS request saw
  // it fail. Two desks can both read a playable match, both write a result and
  // both compute against a null snapshot; the first RPC commits and the second
  // is refused with "already rated". A response can also be lost after Postgres
  // committed. In both cases the match IS rated, and restoring it to playable
  // would leave a rated match open for entry — Elo, statistics and the
  // reliability count all applied, with the idempotency guard then refusing
  // every attempt to re-enter it. Strictly worse than the gap this closes.
  //
  // count: 'exact' because PostgREST reports "matched no rows" as success. The
  // filter is the guard; the count is how we find out the guard fired.
  const { error, count } = await adminClient.from('tournament_matches')
    .update(restore, { count: 'exact' })
    .eq('id', matchId)
    .is('elo_snapshot', null);

  // The compensating write is itself a PostgREST write and can fail too. That
  // lands back in exactly the state this function exists to prevent, so say so
  // instead of reporting the rating error alone — an exec reading "rating
  // failed, try again" would try again and be refused.
  if (error) {
    throw new Error(
      `${detail} — and match ${matchId} could not be put back into a retryable state (${error.message}). ` +
      `It is now recorded as decided but UNRATED and must be corrected by hand.`,
    );
  }

  if (count === 0) {
    throw new Error(
      `${detail} — but match ${matchId} is already rated, so the result was left in place. ` +
      `Another desk most likely entered it at the same moment; reload before entering it again.`,
    );
  }

  throw cause;
}

// ============================================================
// Walkovers, advancement, and late withdrawals
// ============================================================

export type DrawExitStatus = 'withdrawn' | 'disqualified';

// Written onto a match forfeited automatically, so the opponent's walkover
// says why rather than just appearing.
export const FORFEIT_REASON: Record<DrawExitStatus, string> = {
  withdrawn: 'Opponent withdrew from the event',
  disqualified: 'Opponent was disqualified',
};

/**
 * The mechanical half of a walkover: stamp the result on the match, rate it,
 * and advance the winner. Shared by the admin's manual walkover entry and by
 * the forfeit cascade a late withdrawal triggers, so both write an identical
 * match row — including the elo_snapshot that undo/edit reverse. A second
 * hand-rolled forfeit path would be a second set of rating invariants.
 *
 * Always rated. Every caller reaches here only on a live event: a walkover
 * recorded earlier could not be rated at all, and it would count as a result,
 * which blocks regenerating the draw — the remedy that belongs at that stage.
 *
 * applyTournamentMatchElo now THROWS when a rating write fails, and that
 * propagates: through advanceWinner's cascade, and out of the
 * forfeitOpenMatchesForEntry loop that a withdrawal or disqualification runs.
 * So a late withdrawal can now fail partway with some forfeits already
 * recorded, and withdrawParticipant reports ok:false instead of a tidy
 * { forfeited, unresolved }. That is the point: the alternative is a cascade
 * that says it forfeited eight matches while silently rating none of them.
 */
export async function recordWalkover(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  winnerPosition: 'a' | 'b',
  reason: string,
  enteredBy: string,
) {
  const matchId = match.id as string;

  const winnerId = (doubles
    ? (winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id)
    : (winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id)) as string | null;
  const loserId = (doubles
    ? (winnerPosition === 'a' ? match.pair_b_id : match.pair_a_id)
    : (winnerPosition === 'a' ? match.participant_b_id : match.participant_a_id)) as string | null;

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Checked, not fired and forgotten: supabase-js resolves with { error } rather
  // than rejecting, so an unchecked write here reported a walkover that the
  // bracket never actually recorded — and then rated and advanced off it.
  //
  // Conditional on the status the caller read, for the same reason
  // enterMatchResult's write is: it makes recording a result a compare-and-swap,
  // so a walkover cannot be stamped over a result another desk entered between
  // that read and this write. The count is the only way to tell, since PostgREST
  // reports "matched no rows" as success.
  const { error: writeError, count } = await adminClient.from('tournament_matches').update({
    status: 'walkover',
    walkover_winner: winnerPosition,
    walkover_reason: reason,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: enteredBy,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status as string);

  if (writeError) {
    throw new Error(`Could not record the walkover on match ${matchId}: ${writeError.message}`);
  }

  if (count === 0) {
    throw new Error(
      `Match ${matchId} changed while the walkover was being recorded — it is no longer ${String(match.status)}. Nothing was written.`,
    );
  }

  // Rate BEFORE advancing. Advancing can cascade into another forfeit further
  // up the bracket, and a player's later matches must be rated against the
  // rating their earlier ones left them on, not the other way round.
  //
  // A failure here would otherwise leave a forfeited-but-unrated match that no
  // action can retry: the cascade skips anything that is no longer open, and
  // manual walkover entry refuses anything already decided. Take the walkover
  // back off so the retry has something to act on.
  try {
    await applyTournamentMatchElo(matchId);
  } catch (err) {
    await undoDecidedResult(adminClient, matchId, match, err);
  }

  // 'skip', not 'refuse': this is also the withdrawal cascade's path, and it is
  // looping over one player's open matches. A throw here would leave the
  // forfeits it already committed with the rest undone.
  if (winnerId) await advanceWinner(adminClient, match, doubles, winnerId, enteredBy, 'skip');
  // A forfeited semi-final still produces a loser, and they still belong in the
  // third-place playoff — where settleAdvancedMatch will notice they have
  // withdrawn (that is usually WHY this was a walkover) and forfeit that match
  // to the other semi-finalist once both slots are filled. Skipping the route
  // here instead would leave the playoff permanently half-empty.
  await advanceLoser(adminClient, match, doubles, loserId, enteredBy, 'skip');
}

/**
 * What to do when the match we would advance INTO has already been decided.
 *
 * 'refuse' is for a human entering a result: they are about to be told their
 * bracket cannot absorb this, and stopping is the only honest answer.
 *
 * 'skip' is for the withdrawal cascade, which loops over one player's open
 * matches. Throwing there would leave the forfeits it had already committed
 * with the rest undone, which is a worse draw than the one it was repairing.
 */
type DecidedTargetPolicy = 'refuse' | 'skip';

/**
 * Move `entryId` into the match this one feeds along `route`, then decide that
 * match's state. Callers used to inline this; the withdrawal cascade needs the
 * exact same rule, and a slot filled by a slightly different one is how a
 * bracket ends up disagreeing with itself.
 */
async function routeEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  entryId: string,
  enteredBy: string,
  route: MatchRoute,
  onDecided: DecidedTargetPolicy,
) {
  const target = routeOf(match, route);
  if (!target) return;

  // Read the target BEFORE touching it. A decided match must not have a slot
  // rewritten underneath its result: that is the corruption at the end of
  // void -> hand-place a substitute -> play the downstream -> restore and
  // replay. The slot write used to happen first and settleAdvancedMatch then
  // dragged a completed, rated match back to `ready`; re-entering it kept the
  // old snapshot, so the new occupants were never rated while the old ones kept
  // the delta.
  const { data: targetRow } = await adminClient.from('tournament_matches')
    .select('status')
    .eq('id', target.nextId)
    .single();

  const targetStatus = targetRow?.status as string | undefined;
  if (targetStatus && targetStatus !== 'pending' && targetStatus !== 'ready') {
    if (onDecided === 'refuse') {
      throw new ExpectedError(
        'The next match has already been played, so this result cannot be advanced into it. ' +
        'Void or undo that match first, then enter this one again.',
      );
    }
    // The withdrawal cascade must not stop half way — it is looping over one
    // player's open matches and the ones already forfeited are committed. Leave
    // the decided match alone and record that the draw needs a human.
    Sentry.captureException(new Error(
      `Could not advance into match ${target.nextId}: it is already ${targetStatus}. The draw may need manual repair.`,
    ));
    return;
  }

  await adminClient.from('tournament_matches')
    .update({ [entrySideField(target.side, doubles)]: entryId })
    .eq('id', target.nextId);

  await settleAdvancedMatch(adminClient, target.nextId, doubles, enteredBy);
}

export async function advanceWinner(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  winnerId: string,
  enteredBy: string,
  onDecided: DecidedTargetPolicy = 'refuse',
) {
  await routeEntry(adminClient, match, doubles, winnerId, enteredBy, 'winner', onDecided);
}

/**
 * Send a semi-final's LOSER into the third-place playoff (00080).
 *
 * `loserId` is nullable and that is the whole point of the guard below: a BYE
 * has no losing side, and a walkover awarded to the only entry present has no
 * loser either. Routing "null" would write an empty slot over one the other
 * semi-final had already filled, or — worse, before the null check — would look
 * to a later reader like a phantom entry standing in a real playoff. A
 * third-place match that keeps one side empty is the honest outcome: the
 * bracket's existing recovery panel offers "advance unopposed", which is
 * unrated, and nobody collects Elo for a playoff nobody contested.
 *
 * Called AFTER advanceWinner at every call site, for the same reason
 * advanceWinner is called after rating: advancement can cascade into another
 * forfeit, and the ordering keeps that cascade deterministic.
 */
export async function advanceLoser(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  loserId: string | null,
  enteredBy: string,
  onDecided: DecidedTargetPolicy = 'refuse',
) {
  if (!loserId) return;
  await routeEntry(adminClient, match, doubles, loserId, enteredBy, 'loser', onDecided);
}

/**
 * A match becomes READY once both slots are filled — but only if both
 * occupants are still in the event. Someone who withdrew after the draw was
 * published is still sitting in their slot, so without this check the arriving
 * winner is shown a live match against a player who is not coming. That is the
 * half of a late withdrawal the withdrawal itself cannot fix: at the time they
 * pulled out their next opponent was still TBD.
 */
async function settleAdvancedMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  doubles: boolean,
  enteredBy: string,
) {
  const { data: next } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('id', matchId)
    .single();
  if (!next) return;

  const aId = (doubles ? next.pair_a_id : next.participant_a_id) as string | null;
  const bId = (doubles ? next.pair_b_id : next.participant_b_id) as string | null;
  if (!aId || !bId) return;

  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: entries } = await adminClient.from(table)
    .select('id, status')
    .in('id', [aId, bId]);

  const statusOf = (id: string) => entries?.find(e => e.id === id)?.status as string | undefined;
  const aOut = isOutOfEvent(statusOf(aId));
  const bOut = isOutOfEvent(statusOf(bId));

  // Exactly one side gone → the other walks over. Both gone is a draw an admin
  // has to unpick by hand, so it still surfaces as READY rather than silently
  // awarding a win to someone who is also not playing.
  if (aOut !== bOut) {
    const goneStatus = statusOf(aOut ? aId : bId) as DrawExitStatus;
    await recordWalkover(adminClient, next, doubles, aOut ? 'b' : 'a', FORFEIT_REASON[goneStatus], enteredBy);
    return;
  }

  // Belt and braces: never drag a DECIDED match back to ready. routeEntry
  // refuses to write into a decided target before it gets here, so this should
  // be unreachable — but this is the single line that every advancement path
  // funnels through, and it was the last step of a sequence that silently
  // destroyed a result (see routeEntry). Silent rather than throwing: the
  // withdrawal cascade calls this in a loop, and one throw mid-loop would leave
  // half the forfeits committed.
  await adminClient.from('tournament_matches')
    .update({ status: 'ready' })
    .eq('id', matchId)
    .in('status', ['pending', 'ready']);
}

/**
 * Forfeit every still-playable match belonging to `entryId` to its opponent.
 * Called when an entry is withdrawn or disqualified after the draw exists —
 * bracket generation only ever saw a point-in-time snapshot of who was in, so
 * without this the entry stays seeded and their matches stay READY.
 *
 * Finished matches are left exactly as they are: a walkover cannot rewrite a
 * result that was actually played, and a first-round bye is unrated, so it
 * carries no Elo to unwind.
 */
export async function forfeitOpenMatchesForEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  entryId: string,
  doubles: boolean,
  reason: string,
  enteredBy: string,
): Promise<{ forfeited: number; unresolved: number }> {
  const { data: candidates } = await adminClient.from('tournament_matches')
    .select('id, round_number, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .in('status', [...OPEN_MATCH_STATUSES])
    .order('round_number', { ascending: true });

  let forfeited = 0;
  let unresolved = 0;

  for (const candidate of candidates ?? []) {
    if (!forfeitOutcome(candidate, entryId, doubles)) continue;

    // Re-read before acting: an earlier forfeit in this loop advances an
    // opponent, which can settle a later match on this very list.
    const { data: match } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', candidate.id)
      .single();
    if (!match || !isOpenMatch(match.status as string) || match.is_bye) continue;

    const outcome = forfeitOutcome(match, entryId, doubles);
    if (!outcome) continue;

    // Opponent slot still TBD — there is nobody to award the walkover to.
    // settleAdvancedMatch forfeits it the moment the feeder match resolves.
    if (!outcome.winnerId) { unresolved++; continue; }

    await recordWalkover(adminClient, match, doubles, outcome.winnerSide, reason, enteredBy);
    forfeited++;
  }

  return { forfeited, unresolved };
}

/**
 * Forfeit the open matches of everyone who is no longer in the event.
 *
 * Run when an event goes live. Between the draw being published and the first
 * serve, a withdrawal deliberately does NOT touch the bracket — nothing has
 * been played, so the honest remedy is to regenerate the draw without them,
 * and a walkover recorded then would be unrated AND would block that
 * regeneration. Go-live is the moment that stops being true: the draw is now
 * the draw, and a forfeit finally carries the Elo it is supposed to.
 */
export async function forfeitOutOfEventEntries(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  doubles: boolean,
  enteredBy: string,
): Promise<{ forfeited: number; unresolved: number }> {
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: entries } = await adminClient.from(table)
    .select('id, status')
    .eq('event_id', eventId)
    .in('status', ['withdrawn', 'disqualified']);

  let forfeited = 0;
  let unresolved = 0;

  for (const entry of entries ?? []) {
    const outcome = await forfeitOpenMatchesForEntry(
      adminClient,
      eventId,
      entry.id,
      doubles,
      FORFEIT_REASON[entry.status as DrawExitStatus],
      enteredBy,
    );
    forfeited += outcome.forfeited;
    unresolved += outcome.unresolved;
  }

  return { forfeited, unresolved };
}

// ============================================================
// Round Robin Standings (utility)
// ============================================================

// seedBy picks the FIRST sort key only — see sortStandings. It exists so that
// pool-to-bracket seeding and the leaderboard tally the same figures from the
// same query and differ only in how the finished table is read.
export async function computeRoundRobinStandings(eventId: string, seedBy: SeedBy = 'wins') {
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) return [];

  const doubles = isDoublesEvent(event.event_type);

  // Get all completed matches
  const { data: matches } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .in('status', ['completed', 'walkover']);

  // EVERY entry, including the ones that left. They are filtered out of the
  // final ordering further down, not out of the tally.
  //
  // Excluding them here quietly deleted real results. The loop below skips any
  // match whose two ids are not both in this map, so when somebody withdrew
  // mid-event, the games they had already PLAYED vanished from the standings —
  // their opponents' genuine wins and losses among them — while every one of
  // those matches stayed in the global Elo and in the players' match records.
  // Positions and round-robin points were then computed from a different set of
  // results than the ratings were, and nothing said so.
  let entries: Array<{ id: string; name: string; out: boolean }> = [];
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, pair_name, status')
      .eq('event_id', eventId);
    entries = (pairs ?? []).map(p => ({
      id: p.id,
      name: p.pair_name ?? 'Unnamed',
      out: isOutOfEvent(p.status as string),
    }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, status, player:players(full_name)')
      .eq('event_id', eventId);
    entries = (participants ?? []).map(p => ({
      id: p.id,
      name: ((p.player as unknown as Record<string, unknown>)?.full_name as string) ?? 'Unknown',
      out: isOutOfEvent(p.status as string),
    }));
  }
  // Who may be RANKED. A withdrawn entry's results still count towards everyone
  // else's record; the entry itself does not take a placing.
  const rankableIds = new Set(entries.filter(e => !e.out).map(e => e.id));

  // Build standings
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

    // Sum points from scores
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

  // Ranked at the END, after every played match has been counted. A withdrawn
  // entry's games still shaped everyone else's record — that is what makes the
  // table agree with the ratings — but the entry itself does not take a placing.
  const rankable = Object.values(stats).filter(e => rankableIds.has(e.id));

  // Ordering lives in @badminton/shared so it is testable without a database
  // and so seeding a bracket off this table cannot drift from the table itself.
  return sortStandings(rankable, seedBy);
}
