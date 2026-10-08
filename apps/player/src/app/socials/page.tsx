import Link from 'next/link';
import { getClubSocials } from '@/lib/club-socials';
import { ClubSocialsList, hasClubSocials } from '@/components/club-socials-list';

// Every link the club publishes, on one page anybody can open, signed in or
// not. Reads the same row the footer does (getClubSocials, once per request),
// so the two cannot disagree. The socials switch is the layout's FeatureGate.
export default async function SocialsPage() {
  const socials = await getClubSocials();

  return (
    <div className="fees wide-page" data-screen-label="Socials">
      <header className="fees-head wide-head">
        <h1 className="fees-title">
          Socials<span className="dot">.</span>
        </h1>
        <p className="fees-sub">Where the club talks between sessions.</p>
      </header>

      <div className="fees-grid wide-grid">
        <div className="fees-col">
          <section className="card-base fees-prices">
            <div className="fees-label">Find us</div>
            {hasClubSocials(socials) ? (
              <ClubSocialsList socials={socials} />
            ) : (
              <p className="fees-note">
                The club has no social links up right now. The{' '}
                <Link href="/exec" className="fees-link">
                  exec team
                </Link>{' '}
                can point you the right way.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
