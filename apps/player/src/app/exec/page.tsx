import { getExecutives } from '@/lib/supabase-server';
import { PageHeader, Avatar } from '@badminton/ui';

// Public page — viewable without an account (see middleware public allowlist).
export const dynamic = 'force-dynamic';

export default async function ExecPage() {
  const execs = await getExecutives();

  return (
    <div data-screen-label="Executives" style={{ maxWidth: 1120, margin: '0 auto' }}>
      <PageHeader
        title="Executives"
        sub="The team that runs SFU Badminton Club."
      />

      {execs.length === 0 ? (
        <div className="card-base">
          <p className="muted" style={{ fontSize: 13 }}>No executives listed yet.</p>
        </div>
      ) : (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}
        >
          {execs.map((e) => (
            <div key={e.id} className="card-base" style={{ textAlign: 'center', padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                <Avatar name={e.name} src={e.avatar_url} size="lg" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{e.name}</div>
              {e.exec_title && (
                <div
                  className="mono muted"
                  style={{ fontSize: 12, marginTop: 4, textTransform: 'uppercase', letterSpacing: '.08em' }}
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
