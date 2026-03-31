import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Badge, Avatar } from '@badminton/ui';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  TOURNAMENT_MATCH_FORMAT_LABELS,
  getRoundName,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventStatus,
  TournamentMatchFormat,
  TournamentMatchStatus,
} from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Trophy, Users, ArrowLeft, Crown, Swords } from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;
  const supabase = await createServerSupabaseClient();

  const { data: tournament } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', tournamentId)
    .single();
  if (!tournament) notFound();

  const { data: event } = await supabase
    .from('tournament_events')
    .select('*')
    .eq('id', eventId)
    .single();
  if (!event) notFound();

  const eventType = event.event_type as TournamentEventType;
  const eventStatus = event.status as TournamentEventStatus;
  const matchFormat = event.match_format as TournamentMatchFormat;
  const doubles = isDoublesEvent(eventType);
  const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[eventStatus];

  // Fetch participants or pairs
  let participants: Array<Record<string, unknown>> = [];
  let pairs: Array<Record<string, unknown>> = [];

  if (doubles) {
    const { data } = await supabase
      .from('tournament_pairs')
      .select(
        '*, player1:players!tournament_pairs_player1_id_fkey(full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(full_name, avatar_url)'
      )
      .eq('event_id', eventId)
      .order('seed_number');
    pairs = (data as Array<Record<string, unknown>>) ?? [];
  } else {
    const { data } = await supabase
      .from('tournament_participants')
      .select('*, player:players(full_name, avatar_url)')
      .eq('event_id', eventId)
      .order('seed_number');
    participants = (data as Array<Record<string, unknown>>) ?? [];
  }

  // Fetch matches
  const { data: matches } = await supabase
    .from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .order('round_number')
    .order('bracket_position');

  const allMatches = (matches as Array<Record<string, unknown>>) ?? [];

  // Build name/seed lookup maps
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

  // Group matches by round for bracket display
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
    const key = doubles
      ? side === 'a' ? 'pair_a_id' : 'pair_b_id'
      : side === 'a' ? 'participant_a_id' : 'participant_b_id';
    const winnerKey = doubles ? 'winner_pair_id' : 'winner_participant_id';
    const pid = match[key] as string | null;
    const winnerId = match[winnerKey] as string | null;
    return !!pid && !!winnerId && pid === winnerId;
  }

  function formatScores(scores: Array<{ a: number; b: number }> | null): string {
    if (!scores || scores.length === 0) return '';
    return scores.map((s) => `${s.a}-${s.b}`).join(', ');
  }

  const isSingleElim = event.format === 'single_elimination';

  return (
    <div className="space-y-6">
      <Link
        href={`/tournaments/${tournamentId}`}
        className="inline-flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#94A3B8] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to {tournament.name}
      </Link>

      {/* Event Header */}
      <FadeIn>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-6">
          <h1 className="text-2xl font-black text-shuttle-white font-display tracking-wide">
            {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
          </h1>
          <p className="text-sm text-[#64748B] mt-1">
            {tournament.name} &middot; {formatDate(tournament.start_date)}
          </p>
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <span
              className="inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{
                backgroundColor: `${statusColor}20`,
                color: statusColor,
              }}
            >
              {TOURNAMENT_EVENT_STATUS_LABELS[eventStatus]}
            </span>
            <Badge variant="neutral">
              {isSingleElim ? 'Single Elimination' : 'Round Robin'}
            </Badge>
            <Badge variant="neutral">
              {TOURNAMENT_MATCH_FORMAT_LABELS[matchFormat]}
            </Badge>
          </div>
        </div>
      </FadeIn>

      {/* Bracket View (Single Elimination) */}
      {isSingleElim && allMatches.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <Trophy className="w-4 h-4 text-[#FFD700]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Bracket
              </h2>
            </div>
            <div className="overflow-x-auto">
              <div className="flex gap-6 min-w-fit">
                {sortedRounds.map(([roundNum, roundMatches]) => (
                  <div key={roundNum} className="flex flex-col gap-4 min-w-[240px]">
                    <h3 className="text-xs font-bold text-[#64748B] text-center uppercase tracking-wider">
                      {getRoundName(roundNum, totalRounds)}
                    </h3>
                    {roundMatches.map((m) => {
                      const matchStatus = m.status as TournamentMatchStatus;
                      const scores = m.scores as Array<{ a: number; b: number }> | null;
                      const scoreStr = formatScores(scores);

                      if (m.is_bye) {
                        return (
                          <div
                            key={m.id as string}
                            className="border border-white/[0.04] rounded-xl overflow-hidden opacity-50"
                          >
                            <div className="p-2.5 text-sm text-[#64748B] bg-white/[0.02]">
                              {getEntryName(m, 'a')} (BYE)
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={m.id as string}
                          className="border border-white/[0.06] rounded-xl overflow-hidden"
                        >
                          {(['a', 'b'] as const).map((side) => {
                            const name = getEntryName(m, side);
                            const seed = getEntrySeed(m, side);
                            const won = isWinner(m, side);
                            return (
                              <div
                                key={side}
                                className={`p-2.5 text-sm flex items-center gap-2 ${
                                  side === 'b' ? 'border-t border-white/[0.04]' : ''
                                } ${
                                  won
                                    ? 'bg-[#EF4444]/10 text-[#EF4444] font-semibold'
                                    : 'bg-white/[0.02] text-[#94A3B8]'
                                }`}
                              >
                                {seed && (
                                  <span className="text-[10px] font-mono text-[#64748B] w-4 text-right shrink-0">
                                    [{seed}]
                                  </span>
                                )}
                                <span className="truncate">{name}</span>
                                {won && matchStatus === 'completed' && (
                                  <Crown className="w-3 h-3 text-[#FFD700] shrink-0 ml-auto" />
                                )}
                              </div>
                            );
                          })}
                          {scoreStr && (
                            <div className="text-center text-xs text-[#475569] py-1.5 border-t border-white/[0.04] font-mono">
                              {scoreStr}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Round Robin View */}
      {!isSingleElim && allMatches.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <Swords className="w-4 h-4 text-[#EF4444]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Match Results
              </h2>
            </div>
            <div className="space-y-3">
              {sortedRounds.map(([roundNum, roundMatches]) => (
                <div key={roundNum}>
                  <h3 className="text-xs font-bold text-[#64748B] uppercase tracking-wider mb-2">
                    Round {roundNum}
                  </h3>
                  <div className="space-y-2">
                    {roundMatches.map((m) => {
                      const scores = m.scores as Array<{ a: number; b: number }> | null;
                      const scoreStr = formatScores(scores);
                      const matchStatus = m.status as TournamentMatchStatus;

                      return (
                        <div
                          key={m.id as string}
                          className="border border-white/[0.06] rounded-lg overflow-hidden"
                        >
                          <div className="flex items-center">
                            <div
                              className={`flex-1 p-2.5 text-sm ${
                                isWinner(m, 'a')
                                  ? 'bg-[#EF4444]/10 text-[#EF4444] font-semibold'
                                  : 'bg-white/[0.02] text-[#94A3B8]'
                              }`}
                            >
                              {getEntryName(m, 'a')}
                            </div>
                            <div className="px-3 text-xs text-[#475569] font-mono bg-white/[0.02] py-2.5 border-x border-white/[0.04]">
                              {matchStatus === 'completed' ? scoreStr || 'W/O' : 'vs'}
                            </div>
                            <div
                              className={`flex-1 p-2.5 text-sm text-right ${
                                isWinner(m, 'b')
                                  ? 'bg-[#EF4444]/10 text-[#EF4444] font-semibold'
                                  : 'bg-white/[0.02] text-[#94A3B8]'
                              }`}
                            >
                              {getEntryName(m, 'b')}
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

      {/* Participants List */}
      <FadeIn delay={0.1}>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-[#EF4444]" />
            <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
              {doubles ? 'Pairs' : 'Participants'}
            </h2>
          </div>

          <div className="space-y-2">
            {doubles
              ? pairs.map((p) => {
                  const p1 = p.player1 as Record<string, unknown> | null;
                  const p2 = p.player2 as Record<string, unknown> | null;
                  const seed = p.seed_number as number | null;
                  const status = p.status as string;
                  const finalPos = p.final_position as number | null;

                  return (
                    <div
                      key={p.id as string}
                      className="flex items-center justify-between p-2.5 bg-white/[0.03] rounded-lg border border-white/[0.04]"
                    >
                      <div className="flex items-center gap-2.5">
                        {seed && (
                          <span className="text-xs font-mono text-[#64748B] w-5 text-center">
                            #{seed}
                          </span>
                        )}
                        <div className="flex -space-x-2">
                          <Avatar
                            name={(p1?.full_name as string) || ''}
                            src={p1?.avatar_url as string | null}
                            size="sm"
                          />
                          <Avatar
                            name={(p2?.full_name as string) || ''}
                            src={p2?.avatar_url as string | null}
                            size="sm"
                          />
                        </div>
                        <span className="text-sm text-shuttle-white font-medium">
                          {p1?.full_name as string} & {p2?.full_name as string}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {finalPos === 1 && (
                          <Crown className="w-3.5 h-3.5 text-[#FFD700]" />
                        )}
                        {finalPos && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                              finalPos === 1
                                ? 'bg-[#FFD700]/15 text-[#FFD700]'
                                : 'bg-white/[0.06] text-[#94A3B8]'
                            }`}
                          >
                            #{finalPos}
                          </span>
                        )}
                        {status === 'withdrawn' && (
                          <Badge variant="neutral">Withdrawn</Badge>
                        )}
                        {status === 'disqualified' && (
                          <Badge variant="danger">DQ</Badge>
                        )}
                      </div>
                    </div>
                  );
                })
              : participants.map((p) => {
                  const player = p.player as Record<string, unknown> | null;
                  const seed = p.seed_number as number | null;
                  const status = p.status as string;
                  const finalPos = p.final_position as number | null;

                  return (
                    <div
                      key={p.id as string}
                      className="flex items-center justify-between p-2.5 bg-white/[0.03] rounded-lg border border-white/[0.04]"
                    >
                      <div className="flex items-center gap-2.5">
                        {seed && (
                          <span className="text-xs font-mono text-[#64748B] w-5 text-center">
                            #{seed}
                          </span>
                        )}
                        <Avatar
                          name={(player?.full_name as string) || ''}
                          src={player?.avatar_url as string | null}
                          size="sm"
                        />
                        <span className="text-sm text-shuttle-white font-medium">
                          {player?.full_name as string}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {finalPos === 1 && (
                          <Crown className="w-3.5 h-3.5 text-[#FFD700]" />
                        )}
                        {finalPos && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                              finalPos === 1
                                ? 'bg-[#FFD700]/15 text-[#FFD700]'
                                : 'bg-white/[0.06] text-[#94A3B8]'
                            }`}
                          >
                            #{finalPos}
                          </span>
                        )}
                        {status === 'withdrawn' && (
                          <Badge variant="neutral">Withdrawn</Badge>
                        )}
                        {status === 'disqualified' && (
                          <Badge variant="danger">DQ</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}

            {participants.length === 0 && pairs.length === 0 && (
              <p className="text-[#64748B] text-sm text-center py-6">
                No {doubles ? 'pairs' : 'participants'} yet
              </p>
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
