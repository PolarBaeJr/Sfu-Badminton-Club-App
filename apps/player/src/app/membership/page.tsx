import Link from 'next/link';
import { featureAccessFor, playerPathVisible } from '@badminton/shared';
import { getActiveSeason, getViewer } from '@/lib/supabase-server';
import { getFeatureFlags } from '@/lib/feature-gate';
import { getClubSocials, getMembershipPayments } from '@/lib/club-socials';
import { ClubSocialsList, hasClubSocials } from '@/components/club-socials-list';
import { money } from '@/lib/fees';

// THE PUBLIC MEMBERSHIP PAGE: what a membership costs this season and where to
// buy one, for somebody deciding whether to join as much as for a member.
//
// IT NEVER READS club_fees. The prices come from get_active_season(), which is
// granted to anon, so nothing here is a disclosure. A member's own statement is
// /fees, behind its own switch; this page only links to it.
//
// The page is public (see public-paths.ts); the membership switch is the
// layout's FeatureGate.
export default async function MembershipPage() {
  const [season, viewer, payments, socials, features] = await Promise.all([
    getActiveSeason().catch(() => null),
    getViewer().catch(() => ({ user: null, player: null })),
    getMembershipPayments(),
    getClubSocials(),
    getFeatureFlags(),
  ]);

  const { player } = viewer;
  const access = featureAccessFor(player);
  const pending = player?.status === 'pending_approval';
  // The same test the root layout uses for "approved": neither pending nor
  // suspended. A suspended member sees the public half only.
  const approved = player !== null && !pending && player.status !== 'suspended';
  const showDues = approved && playerPathVisible('/fees', features, access);
  const showSocials = playerPathVisible('/socials', features, access) && hasClubSocials(socials);

  return (
    <div className="fees wide-page" data-screen-label="Membership">
      <header className="fees-head wide-head">
        <h1 className="fees-title">
          Membership<span className="dot">.</span>
        </h1>
        <p className="fees-sub">
          {season ? season.name : 'No season is running, so no membership is on sale.'}
        </p>
      </header>

      <div className="fees-grid wide-grid">
        <div className="fees-col">
          {/* ── WHAT IT COSTS ─────────────────────────────────────────── */}
          <section className="card-base fees-prices">
            <div className="fees-label">What a membership costs</div>
            {season ? (
              <>
                <div className="fees-price">
                  <div className="fees-price-main">
                    <div className="fees-price-name">Competitive membership</div>
                    <div className="fees-price-note">Competitive sessions · one season</div>
                  </div>
                  <div className="fees-price-amount">{money(season.competitive_fee_cents)}</div>
                </div>
                <div className="fees-price">
                  <div className="fees-price-main">
                    <div className="fees-price-name">Recreational membership</div>
                    <div className="fees-price-note">Recreational sessions · one season</div>
                  </div>
                  <div className="fees-price-amount">{money(season.recreational_fee_cents)}</div>
                </div>
              </>
            ) : (
              <p className="fees-note">Membership prices are set per season, and no season is running.</p>
            )}
            {payments.sfssPurchaseUrl && (
              <p style={{ marginTop: 18 }}>
                <a
                  href={payments.sfssPurchaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                >
                  Buy membership on SFU Recreation
                </a>
              </p>
            )}
          </section>

          {/* ── YOUR MEMBERSHIP ───────────────────────────────────────── */}
          {pending && (
            <p className="fees-note" role="status">
              Your account is waiting for an exec to approve it. Once it is, your dues show up here.
            </p>
          )}
          {showDues && (
            <p className="fees-note">
              <Link href="/fees" className="fees-link">
                See your dues
              </Link>
            </p>
          )}
        </div>

        {showSocials && (
          <div className="fees-col">
            {/* ── SOCIALS ───────────────────────────────────────────────── */}
            <section className="card-base fees-prices">
              <div className="fees-label">Club socials</div>
              <ClubSocialsList socials={socials} />
              <p className="fees-note">
                <Link href="/socials" className="fees-link">
                  All socials
                </Link>
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
