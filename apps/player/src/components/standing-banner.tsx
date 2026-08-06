'use client';

import { usePathname } from 'next/navigation';
import { useStanding } from '@/components/standing-provider';

// The app-wide explanation, rendered once under the top bar whenever the
// signed-in member's standing will refuse things. Every surface that withholds
// a control shows a one-clause note; this is the place that says the whole of
// it, including what undoes it — so that hiding buttons reads as a stated
// account state rather than as the app losing features.
//
// Client-side only so it can duck out of the auth and onboarding screens,
// which render their own full-screen layout with no app chrome (same guard as
// TopBar/BottomNav). A brand-new member is pending_approval and un-onboarded
// at the same time, so without this they would meet the banner mid-signup.
export function StandingBanner() {
  const standing = useStanding();
  const pathname = usePathname();

  if (standing.ok) return null;
  if (pathname === '/login' || pathname.startsWith('/auth') || pathname === '/onboarding') return null;

  return (
    <div
      role="status"
      style={{
        borderBottom: '1px solid var(--red-border)',
        background: 'var(--red-wash)',
        color: 'var(--ink)',
        fontSize: 13,
        lineHeight: 1.5,
        padding: '10px 28px',
      }}
    >
      <div style={{ maxWidth: 1360, margin: '0 auto' }}>
        <strong style={{ color: 'var(--red)' }}>
          {standing.block === 'pending_approval' ? 'Awaiting approval' : 'Account suspended'}
        </strong>{' '}
        {standing.detail}
      </div>
    </div>
  );
}
