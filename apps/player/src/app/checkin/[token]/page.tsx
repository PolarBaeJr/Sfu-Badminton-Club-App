import { redirect } from 'next/navigation';
import { CHECKIN_TOKEN_REGEX, getAccountStanding } from '@badminton/shared';
import { getCurrentPlayer } from '@/lib/supabase-server';
import { CheckinClient } from './checkin-client';

// This URL performs a check-in and its result depends on who is signed in —
// it must never be cached or prerendered.
export const dynamic = 'force-dynamic';

// Landing page for the session QR code an admin displays. The token identifies
// the SESSION only; the player is whoever is signed in on the scanning phone.
// It has to be a page rather than a route handler because the person holding
// the camera needs to see whether it worked.
export default async function CheckinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const player = await getCurrentPlayer();
  if (!player) {
    // Carry the token through sign-in — /login has no generic `next=` support.
    // Only a well-formed token travels, so nothing arbitrary can ride along.
    redirect(CHECKIN_TOKEN_REGEX.test(token) ? `/login?checkin=${token}` : '/login');
  }

  // checkInWithToken -> requirePlayer() refuses before it even resolves the
  // token, so say so on arrival. Someone standing at the door with a phone
  // needs to know they are not on the list *now*, not after a spinner.
  const standing = getAccountStanding(player);
  if (!standing.ok) {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 700 }}>Can&apos;t check you in</h1>
        <p className="page-sub" style={{ marginTop: 8 }}>{standing.detail}</p>
      </div>
    );
  }

  return <CheckinClient token={token} />;
}
