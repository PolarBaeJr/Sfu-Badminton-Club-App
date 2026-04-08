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
    .select('*, tournament_events(count)')
    .order('start_date', { ascending: false });

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center gap-3 reveal reveal-1">
          <div className="w-10 h-10 rounded-xl bg-[#FFD700]/10 flex items-center justify-center">
            <Award className="w-5 h-5 text-gold" />
          </div>
          <div>
            <p className="eyebrow">Competition</p>
            <h1 className="display-lg text-shuttle-white">Tournaments</h1>
          </div>
        </div>
      </FadeIn>

      <FadeIn delay={0.05}>
        <StaggerContainer className="grid gap-3">
          {tournaments?.map((t) => {
            const eventsArr = t.tournament_events;
            const eventCount = Array.isArray(eventsArr) ? eventsArr[0]?.count ?? 0 : 0;
            return (
              <StaggerItem key={t.id}>
                <Link href={`/tournaments/${t.id}`} className="block group">
                  <div className="card-surface card-interactive p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-shuttle-white font-semibold">{t.name}</h3>
                        <p className="text-xs text-[#64748B] mt-1 nums">{formatDate(t.start_date)} &middot; {t.format} &middot; {t.scope}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className={t.status === 'active' ? 'chip chip-success' : t.status === 'completed' ? 'chip' : 'chip chip-gold'}>{t.status}</span>
                          <span className="flex items-center gap-1 text-xs text-[#64748B] nums"><Users className="w-3 h-3" />{eventCount} event{eventCount !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-[#475569] group-hover:text-gold transition-colors shrink-0" />
                    </div>
                  </div>
                </Link>
              </StaggerItem>
            );
          })}
          {(!tournaments || tournaments.length === 0) && (
            <div className="card-elevated p-12 text-center">
              <Award className="w-10 h-10 text-[#1E293B] mx-auto mb-3" />
              <p className="text-[#64748B]">No tournaments yet</p>
            </div>
          )}
        </StaggerContainer>
      </FadeIn>
    </div>
  );
}
