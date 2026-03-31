import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge, Avatar } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { notFound, redirect } from 'next/navigation';
import { CheckInButton } from './check-in';
import Link from 'next/link';
import { Calendar, MapPin, Users, Swords, ArrowLeft, CheckCircle2, Zap, Plus } from 'lucide-react';
import { FadeIn } from '@/components/motion-wrapper';

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: session } = await supabase.from('sessions').select('*').eq('id', id).single();
  if (!session) notFound();

  const { data: attendance } = await supabase
    .from('session_attendance')
    .select('*, player:players(id, full_name, ratings(singles_elo, doubles_elo))')
    .eq('session_id', id);

  const isCheckedIn = attendance?.some((a) => a.player_id === player.id);

  const { data: sessionChallenges } = await supabase
    .from('challenges')
    .select('*, creator:players!challenges_created_by_fkey(full_name)')
    .eq('session_id', id)
    .in('status', ['proposed', 'partially_confirmed', 'accepted']);

  return (
    <div className="space-y-6">
      <Link href="/sessions" className="inline-flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#94A3B8] transition-colors">
        <ArrowLeft className="w-4 h-4" />Back to Sessions
      </Link>

      <FadeIn>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-6">
          <h1 className="text-2xl font-black text-shuttle-white font-display tracking-wide">{session.name || 'Session'}</h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-[#64748B]">
            <span className="flex items-center gap-1.5"><Calendar className="w-4 h-4" />{formatDate(session.date)}</span>
            <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" />{session.location}</span>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <Badge variant={session.status === 'open' ? 'success' : 'neutral'}>{session.status}</Badge>
            {isCheckedIn && (
              <span className="flex items-center gap-1.5 text-xs text-[#EF4444] font-semibold">
                <CheckCircle2 className="w-4 h-4" /> You are checked in
              </span>
            )}
          </div>
        </div>
      </FadeIn>

      {session.status === 'open' && !isCheckedIn && (
        <FadeIn delay={0.05}><CheckInButton sessionId={id} /></FadeIn>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FadeIn delay={0.1}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4 h-full">
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-4 h-4 text-[#EF4444]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Players ({attendance?.length ?? 0})
              </h2>
            </div>
            <div className="space-y-2">
              {attendance?.map((a) => {
                const p = a.player as Record<string, unknown>;
                const r = Array.isArray(p?.ratings) ? (p.ratings as Record<string, unknown>[])[0] : p?.ratings as Record<string, unknown>;
                return (
                  <div key={a.id} className="flex items-center justify-between p-2.5 bg-white/[0.03] rounded-lg border border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={p?.full_name as string || ''} size="sm" />
                      <Link href={`/leaderboard/${p?.id}`} className="text-sm text-shuttle-white hover:text-[#EF4444] transition-colors font-medium">
                        {p?.full_name as string}
                      </Link>
                    </div>
                    <span className="text-xs font-mono text-[#64748B]">
                      S:{r?.singles_elo as number ?? '-'} D:{r?.doubles_elo as number ?? '-'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4 h-full">
            <div className="flex items-center gap-2 mb-4">
              <Swords className="w-4 h-4 text-[#FFD700]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">Active Challenges</h2>
            </div>
            <div className="space-y-2">
              {sessionChallenges?.map((c) => (
                <Link key={c.id} href={`/challenges/${c.id}`} className="block group">
                  <div className="p-3 bg-white/[0.03] rounded-lg border border-white/[0.04] hover:border-[#FFD700]/20 transition-all">
                    <p className="text-sm text-shuttle-white font-medium">{(c.creator as Record<string, unknown>)?.full_name as string}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#EF4444]/10 text-[#EF4444] font-medium">{c.type}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${c.rated_flag ? 'bg-[#FFD700]/10 text-[#FFD700]' : 'bg-white/[0.06] text-[#64748B]'}`}>
                        {c.rated_flag ? 'Rated' : 'Casual'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-medium">{c.status}</span>
                    </div>
                  </div>
                </Link>
              ))}
              {(!sessionChallenges || sessionChallenges.length === 0) && (
                <div className="text-center py-6">
                  <Swords className="w-8 h-8 text-[#1E293B] mx-auto mb-2" />
                  <p className="text-sm text-[#64748B]">No active challenges</p>
                </div>
              )}
            </div>
            {isCheckedIn && (
              <Link href={`/challenges/new?session=${id}`} className="block mt-3">
                <button className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#EF4444] to-[#DC2626] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-[#EF4444]/20 hover:shadow-[#EF4444]/30 transition-all">
                  <Plus className="w-4 h-4" />Create Challenge
                </button>
              </Link>
            )}
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
