import { createServerSupabaseClient } from '@/lib/supabase-server';
import { formatDate, TOURNAMENT_STATUS_TAG } from '@badminton/shared';
import Link from 'next/link';
import { Award, Users, ChevronRight } from 'lucide-react';
import { PageHeader } from '@badminton/ui';

export default async function TournamentsPage() {
  const supabase = await createServerSupabaseClient();

  const { data: tournaments } = await supabase
    .from('tournaments')
    .select('*, tournament_events(count)')
    .order('start_date', { ascending: false });

  const now = Date.now();
  const active = (tournaments ?? []).filter((t) => ['active', 'registration', 'live'].includes(t.status));
  const upcoming = (tournaments ?? []).filter((t) => {
    if (active.includes(t)) return false;
    return t.start_date && new Date(t.start_date).getTime() > now && t.status !== 'completed' && t.status !== 'cancelled';
  });
  const past = (tournaments ?? []).filter(
    (t) => !active.includes(t) && !upcoming.includes(t)
  );

  function TCard({ t }: { t: Record<string, unknown> }) {
    const eventsArr = t.tournament_events as Array<{ count: number }> | undefined;
    const eventCount = Array.isArray(eventsArr) ? eventsArr[0]?.count ?? 0 : 0;
    const status = (t.status as string) || 'unknown';
    return (
      <Link
        href={`/tournaments/${t.id as string}`}
        className="press"
        style={{
          display: 'block',
          padding: 18,
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--surface)',
        }}
      >
        <div className="row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
          <span className="tag tag-red">{((t.format as string) || '').toUpperCase()}</span>
          <span className="tag">{((t.scope as string) || '').toUpperCase()}</span>
          <span className={TOURNAMENT_STATUS_TAG[status] ?? 'tag'}>{status.toUpperCase()}</span>
          <span className="mono muted" style={{ marginLeft: 'auto' }}>
            {t.start_date ? formatDate(t.start_date as string).toUpperCase() : 'TBD'}
          </span>
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 600, letterSpacing: '-.01em' }}>
              {t.name as string}
            </div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
              <Users size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
              {eventCount} event{eventCount !== 1 ? 's' : ''}
            </div>
          </div>
          <ChevronRight size={16} className="text-[var(--mute)]" />
        </div>
      </Link>
    );
  }

  function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
    return (
      <div className="card-base">
        <div className="card-head">
          <h3 className="card-title">{title}</h3>
          <span className="tag">{count}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
      </div>
    );
  }

  return (
    <div data-screen-label="Tournaments">
      <PageHeader
        title="Tournaments"
        sub="Internal championships, open events, invitationals. Sign up while registration is open and check brackets when matches go live."
      />

      {(tournaments ?? []).length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <Award size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No tournaments scheduled yet.
          </div>
        </div>
      ) : (
        <div className="feed-col">
          {active.length > 0 && (
            <Section title="Live and registration-open" count={active.length}>
              {active.map((t) => <TCard key={t.id} t={t as unknown as Record<string, unknown>} />)}
            </Section>
          )}
          {upcoming.length > 0 && (
            <Section title="Upcoming" count={upcoming.length}>
              {upcoming.map((t) => <TCard key={t.id} t={t as unknown as Record<string, unknown>} />)}
            </Section>
          )}
          {past.length > 0 && (
            <Section title="Past" count={past.length}>
              {past.map((t) => <TCard key={t.id} t={t as unknown as Record<string, unknown>} />)}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
