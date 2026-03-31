import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import Link from 'next/link';
import { Award, Users, ChevronRight } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function TournamentsPage() {
  const supabase = await createServerSupabaseClient();

  const { data: tournaments } = await supabase
    .from('tournaments')
    .select('*, legacy_tournament_participants(count)')
    .order('start_date', { ascending: false });

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#FFD700]/10 flex items-center justify-center">
            <Award className="w-5 h-5 text-[#FFD700]" />
          </div>
          <h1 className="text-3xl font-black font-display text-shuttle-white tracking-wider uppercase">Tournaments</h1>
        </div>
      </FadeIn>

      <FadeIn delay={0.05}>
        <StaggerContainer className="grid gap-3">
          {tournaments?.map((t) => {
            const count = Array.isArray(t.legacy_tournament_participants) ? t.legacy_tournament_participants[0]?.count ?? 0 : 0;
            return (
              <StaggerItem key={t.id}>
                <Link href={`/tournaments/${t.id}`} className="block group">
                  <div className={`bg-[#161B2E] border rounded-xl p-4 hover:bg-white/[0.02] transition-all duration-200 ${
                    t.status === 'active' ? 'border-[#FFD700]/10 hover:border-[#FFD700]/25' : 'border-white/[0.06] hover:border-white/[0.1]'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-shuttle-white font-semibold">{t.name}</h3>
                        <p className="text-xs text-[#64748B] mt-1">{formatDate(t.start_date)} &middot; {t.format} &middot; {t.scope}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge variant={t.status === 'active' ? 'success' : t.status === 'completed' ? 'neutral' : 'warning'}>{t.status}</Badge>
                          <span className="flex items-center gap-1 text-xs text-[#64748B]"><Users className="w-3 h-3" />{count}</span>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-[#475569] group-hover:text-[#FFD700] transition-colors shrink-0" />
                    </div>
                  </div>
                </Link>
              </StaggerItem>
            );
          })}
          {(!tournaments || tournaments.length === 0) && (
            <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-12 text-center">
              <Award className="w-10 h-10 text-[#1E293B] mx-auto mb-3" />
              <p className="text-[#64748B]">No tournaments yet</p>
            </div>
          )}
        </StaggerContainer>
      </FadeIn>
    </div>
  );
}
