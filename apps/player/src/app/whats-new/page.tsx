import { PageHeader } from '@badminton/ui';
import { WHATS_NEW } from '@/lib/whats-new';

// Public page: viewable without an account (see lib/public-paths.ts).
export const metadata = { title: "What's new" };

// The dates are calendar days, not instants, so they are read and printed in
// UTC to keep any timezone from moving them a day.
function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function WhatsNewPage() {
  const current = process.env.NEXT_PUBLIC_APP_VERSION;
  return (
    <div data-screen-label="What's new" style={{ maxWidth: 760, margin: '0 auto' }}>
      <PageHeader
        eyebrow="RELEASE NOTES"
        title="What's new"
        sub="What changed in each version of the app."
      />
      <div className="grid" style={{ gap: 12 }}>
        {WHATS_NEW.map((entry) => (
          <section key={entry.version} className="card-base">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
                v{entry.version}: {entry.title}
              </h2>
              {entry.version === current && <span className="mono tag">This version</span>}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {formatDate(entry.date)}
            </div>
            {entry.members.length > 0 && (
              <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14 }}>
                {entry.members.map((line) => (
                  <li key={line} style={{ marginTop: 4 }}>{line}</li>
                ))}
              </ul>
            )}
            {entry.execs && entry.execs.length > 0 && (
              <>
                <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginTop: 12 }}>
                  For execs
                </div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 14 }}>
                  {entry.execs.map((line) => (
                    <li key={line} style={{ marginTop: 4 }}>{line}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
