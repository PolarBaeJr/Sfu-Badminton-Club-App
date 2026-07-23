import Link from 'next/link';
import { ArrowRight, Swords, TrendingUp, CalendarDays, Trophy } from 'lucide-react';

type TopEntry = { name: string; elo: number };

const FEATURES = [
  { icon: Swords, title: 'Challenge anyone', body: 'Issue a match, confirm the score, and it counts. Singles or doubles, comp or rec.' },
  { icon: TrendingUp, title: 'Every match moves your number', body: 'A live ELO rating that rises when you win and dips when you don’t. No guesswork.' },
  { icon: CalendarDays, title: 'Practices on a schedule', body: 'See open sessions and claim a court spot before it fills.' },
  { icon: Trophy, title: 'Run real tournaments', body: 'Brackets, seeding, and placement points — the club’s events, tracked end to end.' },
];

export function Landing({ top, seasonName, isAuthenticated }: { top: TopEntry[]; seasonName: string | null; isAuthenticated?: boolean }) {
  return (
    <div className="lp">
      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <div className="lp-kicker">
            <span className="lp-kicker-bar" />
            SFU BADMINTON CLUB{seasonName ? ` · ${seasonName}` : ''}
          </div>
          <h1 className="lp-title">
            The club runs<br />on a ladder.
          </h1>
          <p className="lp-lead">
            Track every match, climb a live ELO ranking, and settle who’s actually the best
            on court — one rally at a time.
          </p>
          <div className="lp-cta-row">
            {isAuthenticated ? (
              <Link href="/feed" className="lp-btn lp-btn-primary">
                Enter the app <ArrowRight size={16} />
              </Link>
            ) : (
              <Link href="/login" className="lp-btn lp-btn-primary">
                Sign in to play <ArrowRight size={16} />
              </Link>
            )}
            <Link href="/leaderboard" className="lp-btn lp-btn-ghost">
              View the leaderboard
            </Link>
          </div>
          <div className="lp-sublinks">
            <Link href="/exec">Meet the executives</Link>
          </div>
        </div>

        {/* Signature: the live top of the singles ladder */}
        <aside className="lp-ladder" aria-label="Top of the singles ladder">
          <div className="lp-ladder-head">
            <span>Top of the ladder</span>
            <span className="lp-ladder-tag">SINGLES · LIVE</span>
          </div>
          {top.length === 0 ? (
            <p className="lp-ladder-empty">No ranked players yet — be the first.</p>
          ) : (
            <ol className="lp-ladder-list">
              {top.map((e, i) => (
                <li key={e.name + i} className="lp-ladder-row">
                  <span className="lp-rank">{i + 1}</span>
                  <span className="lp-name">{e.name}</span>
                  <span className="lp-elo">{e.elo}</span>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </section>

      {/* What it is */}
      <section className="lp-features">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.title} className="lp-feature">
              <span className="lp-feature-icon">
                <Icon size={22} strokeWidth={2} />
              </span>
              <h3 className="lp-feature-title">{f.title}</h3>
              <p className="lp-feature-body">{f.body}</p>
            </div>
          );
        })}
      </section>

      {/* Closing CTA */}
      <section className="lp-close">
        <h2 className="lp-close-title">Ready to climb?</h2>
        {isAuthenticated ? (
          <>
            <p className="lp-close-lead">Jump back into the ladder.</p>
            <Link href="/feed" className="lp-btn lp-btn-primary lp-btn-lg">
              Open the app <ArrowRight size={16} />
            </Link>
          </>
        ) : (
          <>
            <p className="lp-close-lead">Sign in with your SFU email and issue your first challenge.</p>
            <Link href="/login" className="lp-btn lp-btn-primary lp-btn-lg">
              Get started <ArrowRight size={16} />
            </Link>
          </>
        )}
      </section>

      <footer className="lp-footer">
        SFU Badminton Club · Lorne Davies Complex
        <div style={{ marginTop: 8 }}>
          <Link href="/legal/terms" style={{ color: 'inherit' }}>Terms of Use</Link>
          {' · '}
          <Link href="/legal/privacy" style={{ color: 'inherit' }}>Privacy Policy</Link>
        </div>
      </footer>
    </div>
  );
}
