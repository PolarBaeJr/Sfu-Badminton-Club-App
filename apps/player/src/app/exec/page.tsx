import { getExecutives } from '@/lib/supabase-server';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { Users } from 'lucide-react';

// Public page — viewable without an account (see middleware public allowlist).
export const dynamic = 'force-dynamic';

export default async function ExecPage() {
  const execs = await getExecutives();

  return (
    <div data-screen-label="Executives" style={{ maxWidth: 1120, margin: '0 auto' }}>
      <PageHeader
        eyebrow="THE TEAM"
        title="Executives"
        sub="The team that runs SFU Badminton Club."
      />

      {execs.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <div className="empty-icon"><Users size={20} /></div>
            <div className="empty-title">No executives listed yet</div>
            <div className="empty-hint">The exec team will appear here once it&apos;s been added.</div>
          </div>
        </div>
      ) : (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}
        >
          {execs.map((e) => (
            <div key={e.id} className="card-base card-interactive" style={{ textAlign: 'center', padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                <AvatarChip name={e.name} src={e.avatar_url} size="lg" id={e.id} />
              </div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{e.name}</div>
              {e.exec_title && (
                <div
                  className="mono"
                  style={{ fontSize: 12, marginTop: 4, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--red)' }}
                >
                  {e.exec_title}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
