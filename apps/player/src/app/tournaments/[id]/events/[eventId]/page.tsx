import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  describeMatchShape,
  getRoundName,
  isOutOfEvent,
  unwrap,
  unwrapMaybe,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  isPoolToBracket,
  endsInKnockout,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventStatus,
  TournamentMatchStatus,
} from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Trophy, ArrowLeft, Crown, Swords, Medal, Star } from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';
import { EventActions } from './EventActions';
import { ParticipantsList, type ParticipantEntry } from './ParticipantsList';
import { LiveTournament } from '../../../live-tournament';

/**
 * Bracket geometry — one source of truth for the card size, the column offsets
 * and the connector elbows. Every card is forced to BRACKET_CARD_H so a round's
 * pitch is exactly BRACKET_PITCH no matter what a card contains; the elbows are
 * positioned off the same numbers.
 */
const BRACKET_CARD_H = 92;                                  // fixed outer height of a match card
const BRACKET_GAP    = 12;                                  // gap between sibling cards in round 1
const BRACKET_PITCH  = BRACKET_CARD_H + BRACKET_GAP;        // centre-to-centre distance in round 1
const BRACKET_HEAD_H = 30;                                  // round heading block, equal in every column
const BRACKET_FOOT_H = 22;                                  // card footer strip (score / status)

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;
  const supabase = await createServerSupabaseClient();

  const tournamentRes = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', tournamentId)
    .maybeSingle();
  const tournament = unwrapMaybe(tournamentRes);
  if (!tournament) notFound();

  const eventRes = await supabase
    .from('tournament_events')
    .select('*')
    .eq('id', eventId)
    .maybeSingle();
  const event = unwrapMaybe(eventRes);
  if (!event) notFound();

  const eventType   = event.event_type as TournamentEventType;
  const eventStatus = event.status as TournamentEventStatus;
  // Reads the typed shape when the event has one, so a player sees the format
  // they will actually play rather than the enum it fell back from.
  const matchShape = describeMatchShape(event);
  const doubles     = isDoublesEvent(eventType);
  const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[eventStatus];

  let participants: Array<Record<string, unknown>> = [];
  let pairs: Array<Record<string, unknown>> = [];

  // NAMED COLUMNS, NOT `*`, ON ALL THREE READS BELOW — and the reason is
  // 00117/00118 rather than payload size.
  //
  // Those two migrations moved the exec's own free text out of these tables and
  // into private ones, but deliberately did NOT drop the old columns: the owner
  // applies migrations by hand and deploys code separately, so a running build
  // may still be selecting them. `tournament_participants.notes` and
  // `tournament_pairs.notes` are the reason an entry was withdrawn or
  // disqualified; `tournament_matches.notes` is the reason a match was voided,
  // recorded as a double no-show, or restored. Every one of them still holds its
  // history, and this page — the one player screen that reads all three tables —
  // was shipping the lot to every member inside the RSC payload. Narrowing the
  // select is what actually stops that before the DROP COLUMN follow-up runs.
  //
  // The columns are enumerated from what the JSX below actually reads, not from
  // what looks plausible, because a column list is all-or-nothing: PostgREST
  // fails the WHOLE request on an unknown or ungranted column, and 00115 is the
  // write-up of that emptying five player screens. Here it would THROW rather
  // than blank — `unwrap` raises on `res.error` — but a loud wrong answer is
  // still a wrong answer. Note that the `as Array<Record<string, unknown>>`
  // casts erase the select-derived row type, so type-check cannot check this
  // list for you; it was checked by reading every access off these rows,
  // including the bracket-notation ones in getEntryName/getEntrySeed/isWinner
  // and the `(e: any)` ones in Final Standings.
  //
  // ONE STRING LITERAL EACH, never a concatenation: supabase-js parses the
  // select string as a literal type, and `'a, b' + 'c'` widens to `string`.
  if (doubles) {
    const data = unwrap(
      await supabase
        .from('tournament_pairs')
        // pair_name and points are read by Final Standings; final_position both
        // filters and sorts it. player1_id/player2_id are NOT here — the only
        // code that compares them is the "who is my partner" lookup below, which
        // has always had its own narrow select.
        .select('id, seed_number, status, final_position, points, pair_name, player1:players!tournament_pairs_player1_id_fkey(full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number')
    );
    pairs = data as Array<Record<string, unknown>>;
  } else {
    const data = unwrap(
      await supabase
        .from('tournament_participants')
        // elo_change is the singles-only rating delta in Final Standings; it has
        // no counterpart on the pairs read above because that block is behind
        // `!doubles`. `players!player_id` is a foreign-key hint naming the
        // relationship, not a selected column, so player_id itself stays out.
        .select('id, seed_number, status, final_position, points, elo_change, player:players!player_id(full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number')
    );
    participants = data as Array<Record<string, unknown>>;
  }

  const matches = unwrap(
    await supabase
      .from('tournament_matches')
      // bracket_position is the second .order() key rather than something the
      // JSX reads. PostgREST would sort on it whether or not it is selected;
      // it is named so the ordering and the projection cannot drift apart.
      //
      // What is deliberately gone, beyond `notes`: elo_snapshot (the rating
      // engine's working, a Json blob), walkover_reason / walkover_winner,
      // result_entered_by, the loser_* and *_to_* advancement wiring, and the
      // per-match format overrides — none of which this page draws.
      .select('id, round_number, bracket_position, round_name, court, status, scores, is_bye, is_third_place, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position')
  );

  const allMatches = matches as Array<Record<string, unknown>>;

  const currentPlayer = await getCurrentPlayer();
  // `paired` is the discriminator; `partnerName` is display only and may be
  // null even for a real pair, so nothing branches on it.
  let playerRegistration: { status: string; paired: boolean; partnerName?: string | null } | null = null;
  let playerParticipantId: string | null = null;

  // READ FOR DOUBLES TOO, since 00102. This was `!doubles` on the grounds that a
  // doubles entrant had no participant row — true until a member could enter
  // without a partner. Left as it was, somebody who self-entered would come back
  // to a page still offering them Register, and the second press would fail
  // "Already registered".
  if (currentPlayer) {
    const regRes = await supabase
      .from('tournament_participants')
      .select('id, status')
      .eq('event_id', eventId)
      .eq('player_id', currentPlayer.id)
      .maybeSingle();
    const reg = unwrapMaybe(regRes);
    if (reg) {
      playerRegistration = { status: reg.status, paired: false };
      // Only meaningful for singles: everything downstream that keys on a
      // participant id (the bracket's "you" highlight, the match list) is inside
      // a `!doubles` branch, because a doubles match names a PAIR id and never
      // this one.
      if (!doubles) playerParticipantId = reg.id;
    }

    // And the other way to be in a doubles event: on a formed team. The partner's
    // NAME, because a member who agreed to play with whoever they were given
    // wants exactly one thing off this page — who that turned out to be.
    if (doubles) {
      const pairRes = await supabase
        .from('tournament_pairs')
        .select('status, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
        .eq('event_id', eventId)
        .or(`player1_id.eq.${currentPlayer.id},player2_id.eq.${currentPlayer.id}`)
        .limit(1);
      const mine = (pairRes.data ?? [])[0] as Record<string, unknown> | undefined;
      if (mine) {
        const partnerEmbed = mine.player1_id === currentPlayer.id ? mine.player2 : mine.player1;
        const one = Array.isArray(partnerEmbed) ? partnerEmbed[0] : partnerEmbed;
        playerRegistration = {
          status: mine.status as string,
          paired: true,
          partnerName: (one as { full_name?: string | null } | null)?.full_name ?? null,
        };
      }
    }
  }

  const playerOutOfEvent = isOutOfEvent(playerRegistration?.status);

  const participantNameMap: Record<string, string> = {};
  const participantSeedMap: Record<string, number | null> = {};

  if (doubles) {
    for (const p of pairs) {
      const p1 = p.player1 as Record<string, unknown> | null;
      const p2 = p.player2 as Record<string, unknown> | null;
      const name = [p1?.full_name, p2?.full_name].filter(Boolean).join(' & ');
      participantNameMap[p.id as string] = name || 'Unknown Pair';
      participantSeedMap[p.id as string] = p.seed_number as number | null;
    }
  } else {
    for (const p of participants) {
      const player = p.player as Record<string, unknown> | null;
      participantNameMap[p.id as string] = (player?.full_name as string) || 'Unknown';
      participantSeedMap[p.id as string] = p.seed_number as number | null;
    }
  }

  // The participants card filters by name in the browser, so it is a client
  // component: flatten singles and pairs into one shape here rather than
  // shipping raw rows and branching again on the client.
  const participantEntries: ParticipantEntry[] = doubles
    ? pairs.map((p) => {
        const p1 = p.player1 as Record<string, unknown> | null;
        const p2 = p.player2 as Record<string, unknown> | null;
        return {
          id:            p.id as string,
          name:          participantNameMap[p.id as string] ?? 'Unknown Pair',
          seed:          p.seed_number as number | null,
          status:        p.status as string,
          finalPosition: p.final_position as number | null,
          avatars: [
            { name: (p1?.full_name as string) || '', url: (p1?.avatar_url as string | null) ?? null },
            { name: (p2?.full_name as string) || '', url: (p2?.avatar_url as string | null) ?? null },
          ],
        };
      })
    : participants.map((p) => {
        const player = p.player as Record<string, unknown> | null;
        return {
          id:            p.id as string,
          name:          participantNameMap[p.id as string] ?? 'Unknown',
          seed:          p.seed_number as number | null,
          status:        p.status as string,
          finalPosition: p.final_position as number | null,
          avatars: [
            { name: (player?.full_name as string) || '', url: (player?.avatar_url as string | null) ?? null },
          ],
        };
      });

  // The third-place playoff shares round_number with the final so the two are
  // scheduled together (00080), and it has to come OUT of the round grouping
  // before the columns are built. Left in, it renders as a second card in the
  // final's column with a connector elbow drawn into it — which says the winner
  // of that match goes on to play the final. They do not; the match feeds
  // nothing. It gets its own labelled row underneath instead.
  //
  // "Your Matches" further down deliberately still reads it off allMatches: a
  // player who is in it wants to see it, and it identifies itself there by
  // round_name ("3rd Place Playoff") with nothing implied about the draw.
  const thirdPlaceMatch = allMatches.find((m) => m.is_third_place) ?? null;
  // TWO HALVES ON A pool_to_bracket EVENT (00107). The knockout diagram is
  // built from the bracket phase and the results list from the pool phase, so
  // both are shown and neither is fed the other's matches — a bracket drawn
  // over the pool's fixtures would be a tree of round-robin games.
  //
  // On the other two formats every match carries phase NULL, so `poolMatches`
  // is the whole list for a round robin and `bracketMatches` is the whole list
  // for a knockout, exactly as before.
  const poolToBracket = isPoolToBracket(event.format as string);
  const poolMatches = poolToBracket
    ? allMatches.filter((m) => m.phase === 'pool')
    : allMatches;
  const knockoutMatches = poolToBracket
    ? allMatches.filter((m) => m.phase === 'bracket')
    : allMatches;
  const bracketMatches = knockoutMatches.filter((m) => !m.is_third_place);

  const roundsMap = new Map<number, Array<Record<string, unknown>>>();
  let maxRound = 0;
  for (const m of bracketMatches) {
    const rn = m.round_number as number;
    if (rn > maxRound) maxRound = rn;
    if (!roundsMap.has(rn)) roundsMap.set(rn, []);
    roundsMap.get(rn)!.push(m);
  }

  const totalRounds = maxRound;
  const sortedRounds = Array.from(roundsMap.entries()).sort(([a], [b]) => a - b);

  // The pool half's own rounds, listed separately so a pool_to_bracket event
  // shows its round robin as a results list under the bracket.
  const poolRoundsMap = new Map<number, Array<Record<string, unknown>>>();
  for (const m of poolMatches) {
    const rn = m.round_number as number;
    if (!poolRoundsMap.has(rn)) poolRoundsMap.set(rn, []);
    poolRoundsMap.get(rn)!.push(m);
  }
  const sortedPoolRounds = Array.from(poolRoundsMap.entries()).sort(([a], [b]) => a - b);

  function getEntryName(match: Record<string, unknown>, side: 'a' | 'b'): string {
    const key = doubles
      ? side === 'a' ? 'pair_a_id' : 'pair_b_id'
      : side === 'a' ? 'participant_a_id' : 'participant_b_id';
    const pid = match[key] as string | null;
    // A skip match has one real entry and one empty slot — label only the empty
    // side, otherwise both names read as the placeholder.
    if (!pid) return match.is_bye ? 'SKIP' : 'TBD';
    return participantNameMap[pid] || 'TBD';
  }

  function getEntrySeed(match: Record<string, unknown>, side: 'a' | 'b'): number | null {
    const key = doubles
      ? side === 'a' ? 'pair_a_id' : 'pair_b_id'
      : side === 'a' ? 'participant_a_id' : 'participant_b_id';
    const pid = match[key] as string | null;
    if (!pid) return null;
    return participantSeedMap[pid] ?? null;
  }

  function isWinner(match: Record<string, unknown>, side: 'a' | 'b'): boolean {
    const key      = doubles ? (side === 'a' ? 'pair_a_id' : 'pair_b_id') : (side === 'a' ? 'participant_a_id' : 'participant_b_id');
    const winnerKey= doubles ? 'winner_pair_id' : 'winner_participant_id';
    const pid      = match[key] as string | null;
    const winnerId = match[winnerKey] as string | null;
    return !!pid && !!winnerId && pid === winnerId;
  }

  function formatScores(scores: Array<{ a: number; b: number }> | null): string {
    if (!scores || scores.length === 0) return '';
    return scores.map((s) => `${s.a}–${s.b}`).join(', ');
  }

  // endsInKnockout, not `=== 'single_elimination'`: a pool_to_bracket event has
  // a bracket too, and it is the half that decides the event.
  const isSingleElim = endsInKnockout(event.format as string);

  return (
    <div className="space-y-5 pb-28 px-4 sm:px-0">
      {/* THE SCREEN THIS WHOLE CHANGE IS FOR. An entrant sits courtside with
          this page open waiting to learn whether their next match is ready, and
          every write that could tell them is made by an exec at the scoring
          table — so until now the answer only arrived if they thought to pull
          to refresh.

          `draw` is TRUE here and nowhere else on the player side: this is the
          one player screen that reads tournament_matches. One eventId, so the
          match filter is this event's and a score in the men's singles does not
          wake somebody watching the mixed doubles. */}
      <LiveTournament
        channel={`player-tournament-event-${eventId}`}
        tournamentId={tournamentId}
        eventIds={[eventId]}
        draw
      />
      <Link
        href={`/tournaments/${tournamentId}`}
        aria-label="Back to tournament"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <ArrowLeft className="w-4 h-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to {tournament.name}
      </Link>

      {/* Event Header */}
      <FadeIn>
        <div className="card-elevated rounded-2xl overflow-hidden">
          <div className="h-1.5" style={{ background: statusColor }} />
          <div className="p-5">
            <p className="eyebrow mb-1">Event</p>
            <h1 className="display-lg leading-none mb-1 min-w-0 truncate">
              {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
            </h1>
            <p className="text-sm text-[var(--text-muted)] mb-3">
              {tournament.name} &middot; {formatDate(tournament.start_date)}
            </p>

            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span
                className="chip"
                role="status"
                style={{ borderColor: `${statusColor}50`, background: `${statusColor}18`, color: statusColor }}
              >
                <span className="sr-only">Event status: </span>
                {TOURNAMENT_EVENT_STATUS_LABELS[eventStatus]}
              </span>
              <span className="chip">
                {TOURNAMENT_EVENT_FORMAT_LABELS[event.format as keyof typeof TOURNAMENT_EVENT_FORMAT_LABELS]
                  ?? (event.format as string)}
              </span>
              <span className="chip">
                {matchShape}
              </span>
              {playerRegistration && (
                <span className={`chip ${
                  playerOutOfEvent ? 'chip-red' : playerRegistration.status === 'checked_in' ? 'chip-success' : 'chip-info'
                }`}>
                  <span className="sr-only">Your status: </span>
                  {playerOutOfEvent
                    ? (playerRegistration.status === 'withdrawn' ? 'Withdrawn' : 'Disqualified')
                    : playerRegistration.status === 'checked_in' ? 'Checked In' : 'Registered'}
                </span>
              )}
              {tournament.suspended_at && (
                <span className="chip chip-red" role="status">
                  <span className="sr-only">Tournament status: </span>Suspended
                </span>
              )}
            </div>

            {tournament.suspended_at && (
              <p className="text-sm text-[var(--text-muted)] mb-4" role="status">
                This tournament is currently suspended
                {tournament.suspension_reason ? `: ${tournament.suspension_reason}` : '.'}
              </p>
            )}

            <EventActions
              eventId={eventId}
              eventStatus={eventStatus}
              playerRegistration={playerRegistration}
              isDoubles={doubles}
              suspended={!!tournament.suspended_at}
              eventWaiverText={tournament.waiver_text}
            />
          </div>
        </div>
      </FadeIn>

      {/* Bracket View (Single Elimination, and the knockout half of a
          pool_to_bracket event) */}
      {isSingleElim && bracketMatches.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Trophy className="w-4 h-4 text-[var(--color-gold)]" />
              <h2 className="display-md">Bracket</h2>
            </div>
            {/* Horizontal scroll wrapper with fade mask */}
            <div className="overflow-x-auto scroll-fade-x pb-4 px-4" role="region" aria-label="Tournament bracket">
              <div className="flex min-w-fit" role="table" aria-label="Bracket rounds" style={{ gap: '32px' }}>
                {sortedRounds.map(([roundNum, roundMatches], roundIdx) => {
                  const isFirstRound = roundIdx === 0;
                  const isLastRound  = roundIdx === sortedRounds.length - 1;
                  const roundMult    = Math.pow(2, roundIdx);
                  // Everything below is derived from BRACKET_CARD_H / BRACKET_GAP so the
                  // elbows and the column offsets can never drift apart. The card height
                  // is enforced on the card itself — the old value was a guess that no
                  // card actually matched, which is why the lines missed the boxes.
                  const gap          = roundMult * BRACKET_PITCH - BRACKET_CARD_H;
                  const topPadding   = ((roundMult - 1) * BRACKET_PITCH) / 2;

                  return (
                    <div
                      key={roundNum}
                      className="flex flex-col min-w-[210px]"
                      role="rowgroup"
                      aria-label={getRoundName(roundNum, totalRounds)}
                    >
                      {/* Headings live outside the gapped column — as a flex child they
                          picked up the round's own (doubling) gap and shoved each round
                          down by a different amount. */}
                      <h3
                        className="eyebrow text-center flex items-center justify-center shrink-0"
                        role="columnheader"
                        style={{ height: `${BRACKET_HEAD_H}px` }}
                      >
                        {getRoundName(roundNum, totalRounds)}
                      </h3>
                      <div
                        className="flex flex-col"
                        style={{ gap: `${gap}px`, paddingTop: `${topPadding}px`, paddingBottom: `${topPadding}px` }}
                      >
                        {roundMatches.map((m, matchIdx) => {
                          const matchStatus = m.status as TournamentMatchStatus;
                          const scores      = m.scores as Array<{ a: number; b: number }> | null;
                          const scoreStr    = formatScores(scores);
                          const isSkip      = !!m.is_bye;
                          const footer      = scoreStr
                            || (isSkip ? 'Skip' : matchStatus === 'completed' ? 'W/O' : 'vs');

                          return (
                            <div key={m.id as string} className="relative" style={{ height: `${BRACKET_CARD_H}px` }}>
                              {!isLastRound && <div className="absolute top-1/2 -right-[16px] w-[16px] border-t border-[var(--border)]" />}
                              {!isFirstRound && <div className="absolute top-1/2 -left-[16px] w-[16px] border-t border-[var(--border)]" />}
                              {!isLastRound && matchIdx % 2 === 0 && matchIdx + 1 < roundMatches.length && (
                                <div className="absolute border-r border-[var(--border)]" style={{ right: '-16px', top: '50%', height: `${BRACKET_CARD_H + gap}px` }} />
                              )}
                              <div
                                className={`h-full flex flex-col border border-[var(--border)] rounded-xl overflow-hidden card-surface ${
                                  isSkip ? 'opacity-50' : 'card-interactive'
                                }`}
                              >
                                {(['a', 'b'] as const).map((side) => {
                                  const name = getEntryName(m, side);
                                  const seed = getEntrySeed(m, side);
                                  const won  = isWinner(m, side);
                                  return (
                                    <div
                                      key={side}
                                      className={`flex-1 min-h-0 px-2.5 text-sm flex items-center gap-2 ${
                                        side === 'b' ? 'border-t border-[var(--border)]' : ''
                                      } ${
                                        won
                                          ? 'match-winner'
                                          : 'bg-white/[0.02] text-[var(--text-secondary)]'
                                      }`}
                                    >
                                      <span className="nums text-[10px] text-[var(--text-dim)] w-4 text-right shrink-0">
                                        {seed ?? ''}
                                      </span>
                                      <span className="truncate flex-1">{name}</span>
                                      {won && <span className="sr-only">(Winner)</span>}
                                      {won && matchStatus === 'completed' && (
                                        <Crown className="w-3 h-3 text-[var(--color-gold)] shrink-0" aria-hidden="true" />
                                      )}
                                    </div>
                                  );
                                })}
                                <div
                                  className="nums flex items-center justify-center text-[11px] text-[var(--text-dim)] border-t border-[var(--border)] shrink-0"
                                  style={{ height: `${BRACKET_FOOT_H}px` }}
                                >
                                  {footer}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3rd Place Playoff — outside the scrolling grid, with no connector
                touching it, so it cannot read as a second final. */}
            {thirdPlaceMatch && (
              <div className="px-4 pb-4">
                <h3 className="eyebrow mb-2">3rd Place Playoff</h3>
                <div className="border border-[var(--border)] rounded-xl overflow-hidden max-w-[280px]">
                  {(['a', 'b'] as const).map((side) => {
                    const won = isWinner(thirdPlaceMatch, side);
                    return (
                      <div
                        key={side}
                        className={`px-2.5 py-2 text-sm flex items-center gap-2 ${
                          side === 'b' ? 'border-t border-[var(--border)]' : ''
                        } ${won ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'}`}
                      >
                        <span className="truncate flex-1">{getEntryName(thirdPlaceMatch, side)}</span>
                        {won && <span className="sr-only">(Winner)</span>}
                      </div>
                    );
                  })}
                  <div className="nums flex items-center justify-center text-[11px] text-[var(--text-dim)] border-t border-[var(--border)] py-1.5">
                    {formatScores(thirdPlaceMatch.scores as Array<{ a: number; b: number }> | null)
                      || (thirdPlaceMatch.status === 'completed' ? 'W/O' : 'vs')}
                  </div>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-2">
                  The two semi-final losers, playing for 3rd. The winner does not advance to the final.
                </p>
              </div>
            )}
          </div>
        </FadeIn>
      )}

      {/* Round Robin View — the whole event on a round_robin, and the pool half
          on a pool_to_bracket. Shown ALONGSIDE the bracket on that format
          rather than instead of it: a player wants to see the pool they played
          and the draw it put them into. */}
      {poolMatches.length > 0 && (!isSingleElim || poolToBracket) && (
        <FadeIn delay={0.05}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Swords className="w-4 h-4 text-[var(--color-accent)]" />
              <h2 className="display-md">{poolToBracket ? 'Round Robin' : 'Match Results'}</h2>
            </div>
            <div className="px-4 pb-4 space-y-4">
              {sortedPoolRounds.map(([roundNum, roundMatches]) => (
                <div key={roundNum}>
                  <h3 className="eyebrow mb-2">Round {roundNum}</h3>
                  <div className="space-y-2">
                    {roundMatches.map((m) => {
                      const scores      = m.scores as Array<{ a: number; b: number }> | null;
                      const scoreStr    = formatScores(scores);
                      const matchStatus = m.status as TournamentMatchStatus;
                      const winA        = isWinner(m, 'a');
                      const winB        = isWinner(m, 'b');

                      return (
                        <div
                          key={m.id as string}
                          className="border border-[var(--border)] rounded-xl overflow-hidden"
                        >
                          <div className="flex items-center">
                            <div className={`flex-1 p-2.5 text-sm truncate ${winA ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'}`}>
                              {getEntryName(m, 'a')}{winA && <span className="sr-only"> (Winner)</span>}
                            </div>
                            <div className="nums px-3 text-xs text-[var(--text-dim)] bg-white/[0.02] py-2.5 border-x border-[var(--border)] shrink-0">
                              {matchStatus === 'completed' ? scoreStr || 'W/O' : 'vs'}
                            </div>
                            <div className={`flex-1 p-2.5 text-sm text-right truncate ${winB ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'}`}>
                              {getEntryName(m, 'b')}{winB && <span className="sr-only"> (Winner)</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Your Matches — above the participant list: someone opening this page at
          the venue came for their own next match, and the roster below can run
          long enough to push it off a phone screen. */}
      {playerParticipantId && allMatches.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="p-4 pb-0 mb-3">
              <p className="eyebrow mb-1">For you</p>
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-[var(--color-gold)]" />
                <h2 className="display-md">Your Matches</h2>
              </div>
            </div>
            {/* An entry that is out of the event still owns rows here — the
                matches it played stay on the record. Say so once at the top so
                an unplayed one below is not read as "still on". */}
            {playerOutOfEvent && (
              <p className="px-4 pb-2 text-xs text-[var(--text-secondary)]" role="status">
                You are no longer in this event. Any unplayed match here is forfeited to your opponent.
              </p>
            )}
            <div className="px-4 pb-4 space-y-2">
              {allMatches
                .filter((m) => {
                  const aId = doubles ? m.pair_a_id : m.participant_a_id;
                  const bId = doubles ? m.pair_b_id : m.participant_b_id;
                  return aId === playerParticipantId || bId === playerParticipantId;
                })
                .map((m) => {
                  const matchStatus  = m.status as TournamentMatchStatus;
                  const scores       = m.scores as Array<{ a: number; b: number }> | null;
                  const scoreStr     = formatScores(scores);
                  const playerSide   = (doubles ? m.pair_a_id : m.participant_a_id) === playerParticipantId ? 'a' : 'b';
                  const opponentSide = playerSide === 'a' ? 'b' : 'a';
                  const won          = isWinner(m, playerSide as 'a' | 'b');
                  const opponentName = getEntryName(m, opponentSide as 'a' | 'b');
                  const done         = matchStatus === 'completed' || matchStatus === 'walkover';

                  return (
                    <div
                      key={m.id as string}
                      className={`flex items-center justify-between p-3 rounded-xl border gap-3 ${
                        done
                          ? won
                            ? 'border-[var(--color-success)]/20 bg-[var(--color-success)]/5'
                            : 'border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5'
                          : 'border-[var(--border)] bg-white/[0.02]'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-[var(--text-primary)] font-medium truncate">
                          vs {opponentName}
                        </p>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                          {(m.round_name as string) || `Round ${m.round_number}`}
                          {m.court ? ` — Court ${m.court as string}` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        {done ? (
                          <>
                            <span className={`text-sm font-bold ${won ? 'text-[var(--color-success)]' : 'text-[var(--color-accent)]'}`} role="status">
                              {won ? 'WIN' : 'LOSS'}
                            </span>
                            {scoreStr && (
                              <p className="nums text-xs text-[var(--text-muted)] mt-0.5">{scoreStr}</p>
                            )}
                          </>
                        ) : (
                          // "Ready" on a match you can no longer play is an
                          // invitation to turn up for it.
                          <span className="chip capitalize">
                            {playerOutOfEvent
                              ? (playerRegistration?.status === 'withdrawn' ? 'Withdrawn' : 'Disqualified')
                              : matchStatus}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Participants / Pairs List — reference material: it keeps the heading
          but gives up the accent icon and the eyebrow, so the "for you" block
          above is the only thing on the page shouting. */}
      <FadeIn delay={0.15}>
        <ParticipantsList entries={participantEntries} doubles={doubles} />
      </FadeIn>

      {/* Final Standings */}
      {eventStatus === 'completed' && (
        <FadeIn delay={0.2}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Medal className="w-4 h-4 text-[var(--color-gold)]" />
              <h2 className="display-md">Final Standings</h2>
            </div>
            <div className="px-4 pb-4 space-y-1.5">
              {(doubles ? pairs : participants)
                .filter((e: any) => e.final_position != null)
                .sort((a: any, b: any) => a.final_position - b.final_position)
                .map((e: any) => {
                  const pos    = e.final_position as number;
                  const name   = doubles
                    ? e.pair_name ?? `${(e.player1 as any)?.full_name} & ${(e.player2 as any)?.full_name}`
                    : (e.player as any)?.full_name ?? 'Unknown';
                  const points = e.points ?? 0;
                  const posColors: Record<number, string> = { 1: 'var(--color-gold)', 2: 'var(--color-silver)', 3: 'var(--color-bronze)' };
                  const isTop3 = pos <= 3;

                  return (
                    <div
                      key={e.id}
                      className={`flex items-center justify-between p-2.5 rounded-xl ${
                        pos === 1 ? 'bg-[var(--color-gold)]/5 border border-[var(--color-gold)]/20' :
                        pos === 2 ? 'bg-white/[0.03] border border-white/[0.06]' :
                        pos === 3 ? 'bg-white/[0.02] border border-white/[0.04]' :
                        'bg-transparent border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="nums text-sm font-black w-6 text-center shrink-0"
                          style={{ color: posColors[pos] ?? 'var(--text-muted)' }}
                        >
                          {pos}
                        </span>
                        {pos === 1 && <Crown className="w-3.5 h-3.5 text-[var(--color-gold)] shrink-0" aria-hidden />}
                        <span className={`text-sm font-medium truncate ${isTop3 ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                          {name}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="nums text-xs font-bold text-[var(--color-accent)]">{points} pts</span>
                        {!doubles && e.elo_change != null && (
                          <span className={`nums text-xs font-bold ${e.elo_change > 0 ? 'text-[var(--color-success)]' : e.elo_change < 0 ? 'text-[var(--color-accent)]' : 'text-[var(--text-muted)]'}`}>
                            <span className="sr-only">{e.elo_change > 0 ? 'Gained' : e.elo_change < 0 ? 'Lost' : 'No change'}: </span>
                            {e.elo_change > 0 ? '+' : ''}{e.elo_change} elo
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
