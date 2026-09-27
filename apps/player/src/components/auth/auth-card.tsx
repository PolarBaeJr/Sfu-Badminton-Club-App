import { ShuttleMark } from '@/components/shuttle-mark';

// The shell /login and /signup share: backdrop, glow, card and brand header.
// A <section>, not a <main>: the root layout already wraps every page in one.
export function AuthCard({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="signin-shell">
      <div className="signin-grid" aria-hidden />
      <div className="signin-wrap">
        <div className="signin-glow" aria-hidden />
        <section className="signin-card">
          <header className="signin-head">
            <div className="brand-mark signin-mark"><ShuttleMark size={28} /></div>
            <h1 className="signin-title">SFU Badminton</h1>
            <p className="signin-sub">{subtitle}</p>
          </header>
          {children}
        </section>
      </div>
    </div>
  );
}
