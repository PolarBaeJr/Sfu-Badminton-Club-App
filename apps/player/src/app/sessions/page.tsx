import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Calendar, MapPin, Users, ChevronRight, CheckCircle2 } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function SessionsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: sessions } = await supabase
    .from('sessions')
    .select('*, session_attendance(count)')
    .order('date', { ascending: false })
    .limit(20);

  const { data: myAttendance } = await supabase
    .from('session_attendance')
    .select('session_id')
    .eq('player_id', player.id);

  const checkedInSessions = new Set(myAttendance?.map((a) => a.session_id) || []);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center">
            <Calendar className="w-5 h-5 text-[#EF4444]" />
          </div>
          <h1 className="text-3xl font-black font-display text-shuttle-white tracking-wider uppercase">Sessions</h1>
        </div>
      </FadeIn>

      <FadeIn delay={0.05}>
        <StaggerContainer className="grid gap-3">
          {sessions?.map((s) => {
            const count = Array.isArray(s.session_attendance) ? s.session_attendance[0]?.count ?? 0 : 0;
            const checkedIn = checkedInSessions.has(s.id);

            return (
              <StaggerItem key={s.id}>
                <Link href={`/sessions/${s.id}`} className="block group">
                  <div className={`bg-[#161B2E] border rounded-xl p-4 hover:bg-white/[0.02] transition-all duration-200 ${
                    s.status === 'open' ? 'border-[#EF4444]/10 hover:border-[#EF4444]/25' : 'border-white/[0.06] hover:border-white/[0.1]'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <h3 className="text-shuttle-white font-semibold truncate">{s.name || 'Session'}</h3>
                          {checkedIn && (
                            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#EF4444]/15 text-[#EF4444] font-medium shrink-0">
                              <CheckCircle2 className="w-3 h-3" /> Checked In
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[#64748B]">
                          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{formatDate(s.date)}</span>
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{s.location}</span>
                          <span className="flex items-center gap-1"><Users className="w-3 h-3" />{count}</span>
                        </div>
                        <div className="mt-2">
                          <Badge variant={s.status === 'open' ? 'success' : 'neutral'}>{s.status}</Badge>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-[#475569] group-hover:text-[#EF4444] transition-colors shrink-0 ml-3" />
                    </div>
                  </div>
                </Link>
              </StaggerItem>
            );
          })}
          {(!sessions || sessions.length === 0) && (
            <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-12 text-center">
              <Calendar className="w-10 h-10 text-[#1E293B] mx-auto mb-3" />
              <p className="text-[#64748B]">No sessions</p>
            </div>
          )}
        </StaggerContainer>
      </FadeIn>
    </div>
  );
}
