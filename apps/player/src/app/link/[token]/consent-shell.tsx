import { ShuttleMark } from '@/components/shuttle-mark';

// The frame every screen under /link/[token] renders in, and the reason it is
// its own file: there are FOUR of them — the consent step and both of its
// outcomes in link-client.tsx, plus the two refusals in page.tsx — split
// across a server component and a client one. They looked identical when they
// were four copies of the same div, and would have stopped looking identical
// the first time one of them was touched.
//
// Deliberately styled as a consent screen rather than as an app page: one
// narrow card, centred, no navigation. That shape is what every OAuth grant
// screen uses, and it is doing real work here — this is the one moment where
// pressing the button hands a Discord account a standing claim on club roles,
// so there should be nothing else on the page to press.

// Discord's own mark, at their brand colour. Nominative use: it names the
// service being connected, which is exactly what a consent screen's identity
// pair is for.
function DiscordMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057 13.1073 13.1073 0 0 1-1.8722-.8923.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.198.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

// The two parties to the grant, side by side — the club on the left, Discord
// on the right, joined by a rule. Every consent screen opens with this because
// it answers "what is being connected to what" before a single word is read.
function MarkPair() {
  const tile: React.CSSProperties = {
    width: 34,
    height: 34,
    display: 'grid',
    placeItems: 'center',
    border: '1px solid var(--line)',
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <div className="brand-mark" style={{ width: 34, height: 34 }}>
        <ShuttleMark size={19} />
      </div>
      <div style={{ width: 22, height: 1, background: 'var(--line)' }} aria-hidden />
      <div style={{ ...tile, background: '#5865F2', color: '#fff', borderColor: 'transparent' }}>
        <DiscordMark size={19} />
      </div>
    </div>
  );
}

export function ConsentShell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        padding: '40px 20px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          padding: '26px 24px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <MarkPair />
        <div>
          <div className="page-eyebrow"><span className="bar" /> {eyebrow}</div>
          <h1
            style={{
              fontFamily: 'var(--display)',
              fontSize: 27,
              fontWeight: 700,
              letterSpacing: '-.02em',
              lineHeight: 1.1,
              margin: '10px 0 0',
            }}
          >
            {title}
          </h1>
        </div>
        {children}
      </div>
    </div>
  );
}
