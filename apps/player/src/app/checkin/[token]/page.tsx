import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { CHECKIN_TOKEN_REGEX, getClientIp, rateLimit } from '@badminton/shared';
import { getCurrentPlayer } from '@/lib/supabase-server';
import { CheckinClient } from './checkin-client';

// This URL performs a check-in and its result depends on who is signed in —
// it must never be cached or prerendered.
export const dynamic = 'force-dynamic';

// Landing page for the session QR code an admin displays. The token identifies
// the SESSION only; the player is whoever is signed in on the scanning phone.
// It has to be a page rather than a route handler because the person holding
// the camera needs to see whether it worked.
export default async function CheckinPage({ params }: { params: { token: string } }) {
  // Rate limit: 20 scans per IP per minute. A gym full of players on one wifi
  // NAT shares a bucket, so the limit is generous — it only throttles someone
  // walking the token space.
  const rl = rateLimit(
    `checkin:${getClientIp(new Request('http://localhost', { headers: await headers() }))}`,
    20,
    60_000
  );
  if (!rl.success) {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 700 }}>Too many attempts</h1>
        <p className="page-sub" style={{ marginTop: 8 }}>Wait a minute and scan the code again.</p>
      </div>
    );
  }

  const player = await getCurrentPlayer();
  if (!player) {
    // Carry the token through sign-in — /login has no generic `next=` support.
    // Only a well-formed token travels, so nothing arbitrary can ride along.
    redirect(CHECKIN_TOKEN_REGEX.test(params.token) ? `/login?checkin=${params.token}` : '/login');
  }

  return <CheckinClient token={params.token} />;
}
