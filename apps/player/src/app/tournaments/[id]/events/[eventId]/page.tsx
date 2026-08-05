import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  TOURNAMENT_MATCH_FORMAT_LABELS,
  getRoundName,
  unwrap,
  unwrapMaybe,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventStatus,
  TournamentMatchFormat,
  TournamentMatchStatus,
} from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Trophy, ArrowLeft, Crown, Swords, Medal, Star } from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';
import { EventActions } from './EventActions';
import { ParticipantsList, type ParticipantEntry } from './ParticipantsList';

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
  const matchFormat = event.match_format as TournamentMatchFormat;
  const doubles     = isDoublesEvent(eventType);
  const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[eventStatus];

  let participants: Array<Record<string, unknown>> = [];
  let pairs: Array<Record<string, unknown>> = [];

  if (doubles) {
    const data = unwrap(
      await supabase
        .from('tournament_pairs')
        .select('*, player1:players!tournament_pairs_player1_id_fkey(full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number')
    );
    pairs = data as Array<Record<string, unknown>>;
  } else {
    const data = unwrap(
      await supabase
        .from('tournament_participants')
        .select('*, player:players!player_id(full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number')
    );
    participants = data as Array<Record<string, unknown>>;
  }

  const matches = unwrap(
    await supabase
      .from('tournament_matches')
      .select('*')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position')
  );

  const allMatches = matches as Array<Record<string, unknown>>;

  const currentPlayer = await getCurrentPlayer();
  let playerRegistration: { status: string } | null = null;
  let playerParticipantId: string | null = null;

  if (currentPlayer && !doubles) {
    const regRes = await supabase
      .from('tournament_participants')
      .select('id, status')
      .eq('event_id', eventId)
      .eq('player_id', currentPlayer.id)
      .maybeSingle();
    const reg = unwrapMaybe(regRes);
    if (reg) {
      playerRegistration = { status: reg.status };
      playerParticipantId = reg.id;
    }
  }

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

  const roundsMap = new Map<number, Array<Record<string, unknown>>>();
  let maxRound = 0;
  for (const m of allMatches) {
    const rn = m.round_number as number;
    if (rn > maxRound) maxRound = rn;
    if (!roundsMap.has(rn)) roundsMap.set(rn, []);
    roundsMap.get(rn)!.push(m);
  }

  const totalRounds = maxRound;
  const sortedRounds = Array.from(roundsMap.entries()).sort(([a], [b]) => a - b);

  function getEntryName(match: Record<string, unknown>, side: 'a' | 'b'): string {
    if (match.is_bye) return 'BYE';
    const key = doubles
      ? side === 'a' ? 'pair_a_id' : 'pair_b_id'
      : side === 'a' ? 'participant_a_id' : 'participant_b_id';
    const pid = match[key] as string | null;
    if (!pid) return 'TBD';
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

  const isSingleElim = event.format === 'single_elimination';

  return (
    <div className="space-y-5 pb-28 px-4 sm:px-0">
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
                {isSingleElim ? 'Single Elim' : 'Round Robin'}
              </span>
              <span className="chip">
                {TOURNAMENT_MATCH_FORMAT_LABELS[matchFormat]}
              </span>
              {playerRegistration && (
                <span className={`chip ${playerRegistration.status === 'checked_in' ? 'chip-success' : 'chip-info'}`}>
                  <span className="sr-only">Your status: </span>
                  {playerRegistration.status === 'checked_in' ? 'Checked In' : 'Registered'}
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

      {/* Bracket View (Single Elimination) */}
      {isSingleElim && allMatches.length > 0 && (
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
                  const MATCH_H      = 68;
                  const BASE_GAP     = 10;
                  const roundMult    = Math.pow(2, roundIdx);
                  const gap          = isFirstRound ? BASE_GAP : (MATCH_H + BASE_GAP) * roundMult - MATCH_H;
                  const topPadding   = isFirstRound ? 0 : ((MATCH_H + BASE_GAP) * (roundMult - 1)) / 2;

                  return (
                    <div
                      key={roundNum}
                      className="relative flex flex-col min-w-[200px]"
                      role="rowgroup"
                      aria-label={getRoundName(roundNum, totalRounds)}
                      style={{ gap: `${gap}px`, paddingTop: `${topPadding}px` }}
                    >
                      <h3
                        className="eyebrow text-center pb-2"
                        role="columnheader"
                        style={{
                          marginTop:  topPadding > 0 ? `-${topPadding}px` : undefined,
                          paddingTop: topPadding > 0 ? `${topPadding}px` : undefined,
                        }}
                      >
                        {getRoundName(roundNum, totalRounds)}
                      </h3>
                      {roundMatches.map((m, matchIdx) => {
                        const matchStatus = m.status as TournamentMatchStatus;
                        const scores      = m.scores as Array<{ a: number; b: number }> | null;
                        const scoreStr    = formatScores(scores);

                        if (m.is_bye) {
                          return (
                            <div key={m.id as string} className="relative">
                              {!isLastRound && <div className="absolute top-1/2 -right-[16px] w-[16px] border-t border-[var(--border)]" />}
                              {!isFirstRound && <div className="absolute top-1/2 -left-[16px] w-[16px] border-t border-[var(--border)]" />}
                              {!isLastRound && matchIdx % 2 === 0 && matchIdx + 1 < roundMatches.length && (
                                <div className="absolute border-r border-[var(--border)]" style={{ right: '-16px', top: '50%', height: `${MATCH_H + gap}px` }} />
                              )}
                              <div className="border border-[var(--border)] rounded-xl overflow-hidden opacity-40">
                                <div className="p-2.5 text-sm text-[var(--text-muted)] bg-white/[0.02]">
                                  {getEntryName(m, 'a')} (BYE)
                                </div>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div key={m.id as string} className="relative">
                            {!isLastRound && <div className="absolute top-1/2 -right-[16px] w-[16px] border-t border-[var(--border)]" />}
                            {!isFirstRound && <div className="absolute top-1/2 -left-[16px] w-[16px] border-t border-[var(--border)]" />}
                            {!isLastRound && matchIdx % 2 === 0 && matchIdx + 1 < roundMatches.length && (
                              <div className="absolute border-r border-[var(--border)]" style={{ right: '-16px', top: '50%', height: `${MATCH_H + gap}px` }} />
                            )}
                            <div className="border border-[var(--border)] rounded-xl overflow-hidden card-surface card-interactive">
                              {(['a', 'b'] as const).map((side) => {
                                const name = getEntryName(m, side);
                                const seed = getEntrySeed(m, side);
                                const won  = isWinner(m, side);
                                return (
                                  <div
                                    key={side}
                                    className={`p-2.5 text-sm flex items-center gap-2 ${
                                      side === 'b' ? 'border-t border-[var(--border)]' : ''
                                    } ${
                                      won
                                        ? 'match-winner'
                                        : 'bg-white/[0.02] text-[var(--text-secondary)]'
                                    }`}
                                  >
                                    {seed && (
                                      <span className="nums text-[10px] text-[var(--text-dim)] w-4 text-right shrink-0">
                                        [{seed}]
                                      </span>
                                    )}
                                    <span className="truncate flex-1">{name}</span>
                                    {won && <span className="sr-only">(Winner)</span>}
                                    {won && matchStatus === 'completed' && (
                                      <Crown className="w-3 h-3 text-[var(--color-gold)] shrink-0 ml-auto" aria-hidden="true" />
                                    )}
                                  </div>
                                );
                              })}
                              {scoreStr && (
                                <div className="nums text-center text-xs text-[var(--text-dim)] py-1.5 border-t border-[var(--border)]">
                                  {scoreStr}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Round Robin View */}
      {!isSingleElim && allMatches.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Swords className="w-4 h-4 text-[var(--color-accent)]" />
              <h2 className="display-md">Match Results</h2>
            </div>
            <div className="px-4 pb-4 space-y-4">
              {sortedRounds.map(([roundNum, roundMatches]) => (
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
                          <span className="chip capitalize">{matchStatus}</span>
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
