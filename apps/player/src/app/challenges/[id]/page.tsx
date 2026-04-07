import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge, Avatar } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, EVENT_TYPE_LABELS, formatRelativeTime } from '@badminton/shared';
import { notFound, redirect } from 'next/navigation';
import { ChallengeDetailActions } from './actions';
import {
  Swords,
  ArrowLeft,
  Clock,
  Zap,
  Users,
  Trophy,
  MessageSquare,
} from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';

export default async function ChallengeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(full_name, ratings(*)))')
    .eq('id', id)
    .single();

  if (!challenge) notFound();

  const { data: match } = await supabase
    .from('matches')
    .select('*, match_participants(*, player:players(full_name)), match_games(*)')
    .eq('challenge_id', id)
    .maybeSingle();

  const myParticipant = challenge.challenge_participants?.find(
    (cp: Record<string, unknown>) => cp.player_id === player.id
  );

  const sideA = challenge.challenge_participants?.filter((cp: Record<string, unknown>) => cp.team_side === 'a') || [];
  const sideB = challenge.challenge_participants?.filter((cp: Record<string, unknown>) => cp.team_side === 'b') || [];

  const statusStyles: Record<string, string> = {
    proposed: 'bg-[#FFD700]/10 text-[#FFD700] border-[#FFD700]/20',
    partially_confirmed: 'bg-[#FFD700]/10 text-[#FFD700] border-[#FFD700]/20',
    accepted: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    disputed: 'bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/20',
    cancelled: 'bg-white/[0.06] text-[#64748B] border-white/[0.06]',
    expired: 'bg-white/[0.06] text-[#64748B] border-white/[0.06]',
    walkover_pending: 'bg-[#FFD700]/10 text-[#FFD700] border-[#FFD700]/20',
    walkover_confirmed: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href="/challenges" className="inline-flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#94A3B8] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Challenges
      </Link>

      <FadeIn>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center">
                <Swords className="w-5 h-5 text-[#EF4444]" />
              </div>
              <h1 className="text-xl font-black text-shuttle-white font-display tracking-wide">Challenge Detail</h1>
            </div>
            <span className={`text-xs px-3 py-1.5 rounded-full font-bold border ${statusStyles[challenge.status] || 'bg-white/[0.06] text-[#64748B] border-white/[0.06]'}`}>
              {challenge.status}
            </span>
          </div>

          {/* Meta Grid */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Swords, label: 'Type', value: challenge.type, color: '#EF4444' },
              { icon: Trophy, label: 'Format', value: MATCH_FORMAT_LABELS[challenge.format as keyof typeof MATCH_FORMAT_LABELS], color: '#FFD700' },
              { icon: Zap, label: 'Rated', value: challenge.rated_flag ? 'Yes' : 'No', color: challenge.rated_flag ? '#FFD700' : '#64748B' },
              { icon: Clock, label: 'Created', value: formatRelativeTime(challenge.created_at), color: '#94A3B8' },
            ].map((item) => (
              <div key={item.label} className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.04]">
                <div className="flex items-center gap-1.5 mb-1">
                  <item.icon className="w-3 h-3" style={{ color: item.color }} />
                  <span className="text-[10px] text-[#64748B] font-medium uppercase tracking-wider">{item.label}</span>
                </div>
                <p className="text-sm font-semibold text-shuttle-white capitalize">{item.value}</p>
              </div>
            ))}
          </div>

          {/* Note */}
          {challenge.note && (
            <div className="bg-white/[0.03] border border-white/[0.04] rounded-xl p-4 flex items-start gap-2.5">
              <MessageSquare className="w-4 h-4 text-[#64748B] mt-0.5 shrink-0" />
              <p className="text-sm text-[#94A3B8]">{challenge.note}</p>
            </div>
          )}

          {/* Teams */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Team A', players: sideA, color: '#EF4444' },
              { label: 'Team B', players: sideB, color: '#FFD700' },
            ].map((team) => (
              <div key={team.label} className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.04]">
                <p className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: team.color }}>
                  {team.label}
                </p>
                <div className="space-y-2">
                  {team.players.map((cp: Record<string, unknown>) => {
                    const p = cp.player as Record<string, unknown>;
                    const confirmColors: Record<string, string> = {
                      accepted: 'bg-emerald-500/15 text-emerald-400',
                      rejected: 'bg-[#EF4444]/15 text-[#EF4444]',
                      pending: 'bg-[#FFD700]/15 text-[#FFD700]',
                    };
                    return (
                      <div key={cp.id as string} className="flex items-center gap-2">
                        <Avatar name={p?.full_name as string || ''} size="sm" />
                        <div className="min-w-0 flex-1">
                          <span className="text-sm text-shuttle-white truncate block">{p?.full_name as string}</span>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${confirmColors[cp.confirmation_status as string] || 'bg-white/[0.06] text-[#64748B]'}`}>
                          {cp.confirmation_status as string}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Match Result */}
          {match && (
            <div className="bg-white/[0.03] border border-white/[0.04] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Trophy className="w-4 h-4 text-[#FFD700]" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#FFD700]">Match Result</span>
              </div>
              <p className="text-2xl font-mono font-bold text-shuttle-white mb-2">{match.score_summary || 'Pending'}</p>
              <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${
                match.result_status === 'confirmed' ? 'bg-emerald-500/15 text-emerald-400' :
                match.result_status === 'disputed' ? 'bg-[#EF4444]/15 text-[#EF4444]' :
                'bg-[#FFD700]/15 text-[#FFD700]'
              }`}>
                {match.result_status}
              </span>
              {match.match_games?.map((g: Record<string, unknown>) => (
                <p key={g.id as string} className="text-sm text-[#64748B] mt-2 font-mono">
                  Game {g.game_number as number}: {g.side_a_score as number}-{g.side_b_score as number}
                </p>
              ))}
              <div className="mt-3 pt-3 border-t border-white/[0.04] space-y-1">
                {match.match_participants?.map((mp: Record<string, unknown>) => (
                  <div key={mp.id as string} className="flex items-center justify-between">
                    <span className="text-sm text-[#94A3B8]">{(mp.player as Record<string, unknown>)?.full_name as string}</span>
                    <span className={`font-mono text-sm font-bold ${(mp.rating_delta as number ?? 0) >= 0 ? 'text-emerald-400' : 'text-[#EF4444]'}`}>
                      {mp.rating_delta !== null ? `${(mp.rating_delta as number) >= 0 ? '+' : ''}${mp.rating_delta}` : 'pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Actions */}
      <ChallengeDetailActions
        challengeId={id}
        challengeStatus={challenge.status}
        matchId={match?.id}
        matchStatus={match?.result_status}
        myParticipantStatus={myParticipant?.confirmation_status}
        isCreator={challenge.created_by === player.id}
        format={challenge.format}
        participants={challenge.challenge_participants}
        playerId={player.id}
      />
    </div>
  );
}
